// Skeptic gate: every anchored finding is handed to a different model family that tries to
// refute it. This is where precision comes from — the finder runs in coverage mode and is
// expected to over-report, so something downstream has to do the killing.
//
// Findings are verified in parallel; a skeptic that fails to answer leaves its finding
// alive (fail-open here, because a dead verifier must not silently delete real bugs — the
// consensus rule downstream still requires corroboration before publishing).
import {
  SKEPTIC_CONTEXT_LINES,
  SKEPTIC_MODELS,
  SKEPTIC_ROUNDS,
  SKEPTIC_TIMEOUT_MS,
  severityRank,
} from "../config";
import { parseJsonObject } from "../libs/json";
import { log, logVerbose } from "../libs/log";
import { SEVERITIES, type Severity } from "../config";
import type { AnchoredFinding, FileDiff, ModelRunner } from "../libs/types";
import { VERDICT_SCHEMA } from "../models/schemas";
import { SKEPTIC_SYSTEM, buildSkepticPrompt } from "../prompts/skeptic";

export interface Verdict {
  refuted: boolean;
  reason: string;
  confidence: number;
  suggestedSeverity?: Severity;
  model: string;
  error?: string;
}

export interface SkepticOutcome {
  finding: AnchoredFinding;
  verdicts: Verdict[];
  // Majority of answering skeptics refuted it.
  killed: boolean;
}

const VALID_SEVERITY = new Set<string>(SEVERITIES);

export function parseVerdict(raw: string, model: string): Verdict {
  const parsed = parseJsonObject<Record<string, unknown>>(raw);
  if (!parsed.ok) {
    // Fail open: an unparseable verdict is not evidence that the finding is wrong.
    return { refuted: false, reason: "", confidence: 0, model, error: parsed.error };
  }
  const o = parsed.value;
  // A parseable object that never says refuted true/false is not a verdict. Counting it as
  // an answer would let garbage output both survive the kill vote AND satisfy the
  // "cleared by a skeptic" corroboration gate downstream.
  if (typeof o["refuted"] !== "boolean") {
    return { refuted: false, reason: "", confidence: 0, model, error: "no refuted field in verdict" };
  }
  const sev = typeof o["suggested_severity"] === "string" ? o["suggested_severity"].toLowerCase() : "";
  let confidence = Number(o["confidence"]);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  return {
    refuted: o["refuted"] === true,
    reason: typeof o["reason"] === "string" ? o["reason"] : "",
    confidence: Math.min(1, Math.max(0, confidence)),
    suggestedSeverity: VALID_SEVERITY.has(sev) ? (sev as Severity) : undefined,
    model,
  };
}

async function verifyOne(
  runner: ModelRunner,
  finding: AnchoredFinding,
  file: FileDiff,
  model: string,
): Promise<Verdict> {
  const prompt = buildSkepticPrompt({
    claim: finding.claim,
    category: finding.category,
    severity: finding.severity,
    file,
    side: finding.anchor!.side,
    startLine: finding.anchor!.startLine,
    endLine: finding.anchor!.endLine,
    contextLines: SKEPTIC_CONTEXT_LINES,
  });
  const res = await runner.chat({
    model,
    system: SKEPTIC_SYSTEM,
    user: prompt,
    schema: VERDICT_SCHEMA,
    schemaName: "verdict",
    maxTokens: 2048,
    timeoutMs: SKEPTIC_TIMEOUT_MS,
  });
  if (res.error) {
    logVerbose(`skeptic ${model} call failed: ${res.error}`);
    return { refuted: false, reason: "", confidence: 0, model, error: res.error };
  }
  return parseVerdict(res.text, model);
}

export async function runSkeptic(
  runner: ModelRunner,
  findings: AnchoredFinding[],
  files: FileDiff[],
): Promise<SkepticOutcome[]> {
  if (findings.length === 0 || SKEPTIC_MODELS.length === 0) {
    return findings.map((f) => ({ finding: f, verdicts: [], killed: false }));
  }

  // One verifier per round per finding; rounds cycle through the configured models so a
  // 3-round setup with 2 models still gets cross-family coverage.
  const jobs: Array<Promise<SkepticOutcome>> = findings.map(async (finding) => {
    const file = files.find((f) => f.path === finding.file);
    if (!file || !finding.anchor) return { finding, verdicts: [], killed: false };

    const models = Array.from(
      { length: SKEPTIC_ROUNDS },
      (_, i) => SKEPTIC_MODELS[i % SKEPTIC_MODELS.length]!,
    );
    const verdicts = await Promise.all(models.map((m) => verifyOne(runner, finding, file, m)));

    // Only skeptics that actually answered get a vote.
    const answered = verdicts.filter((v) => !v.error);
    const refutedCount = answered.filter((v) => v.refuted).length;
    const killed = answered.length > 0 && refutedCount * 2 > answered.length;

    return { finding, verdicts, killed };
  });

  const outcomes = await Promise.all(jobs);
  const killed = outcomes.filter((o) => o.killed).length;
  log(
    `skeptic: verified ${outcomes.length}, refuted ${killed}, kept ${outcomes.length - killed}` +
      ` (${SKEPTIC_ROUNDS} rounds each, models ${SKEPTIC_MODELS.join(", ")})`,
  );
  for (const o of outcomes) {
    if (!o.killed) continue;
    const why = o.verdicts.find((v) => v.refuted)?.reason ?? "";
    logVerbose(`  refuted: ${o.finding.file}:${o.finding.anchor?.startLine} — ${why.slice(0, 120)}`);
  }
  return outcomes;
}

/**
 * Applies surviving verdicts back onto findings: a skeptic that accepts a finding but argues
 * the severity was inflated gets to lower it (never raise it — the finder owns the ceiling,
 * and letting a verifier escalate reintroduces the agreeableness it exists to counter).
 */
export function applyVerdicts(outcomes: SkepticOutcome[]): AnchoredFinding[] {
  const survivors: AnchoredFinding[] = [];
  for (const o of outcomes) {
    if (o.killed) continue;
    const f = o.finding;
    const answered = o.verdicts.filter((v) => !v.error);
    // "Cleared" = examined and NOT refuted. A refuting minority vote kept the finding
    // alive (fail-open), but it must not double as the corroboration that publishes it.
    f.skepticVerdicts = answered.filter((v) => !v.refuted).length;
    f.skepticRefuted = answered.filter((v) => v.refuted).length;

    const downgrades = answered
      .map((v) => v.suggestedSeverity)
      .filter((s): s is Severity => s !== undefined && severityRank(s) > severityRank(f.severity));
    if (downgrades.length > 0) {
      const mildest = downgrades.reduce((a, b) => (severityRank(a) > severityRank(b) ? a : b));
      logVerbose(`  severity downgraded: ${f.file}:${f.anchor?.startLine} ${f.severity} → ${mildest}`);
      f.severity = mildest;
    }
    survivors.push(f);
  }
  return survivors;
}
