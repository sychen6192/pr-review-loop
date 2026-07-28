// Skeptic gate: every anchored finding is handed to a different model family that tries to
// refute it. This is where precision comes from — the finder runs in coverage mode and is
// expected to over-report, so something downstream has to do the killing.
//
// Findings are verified in parallel; a skeptic that fails to answer leaves its finding
// alive (fail-open here, because a dead verifier must not silently delete real bugs — the
// consensus rule downstream still requires corroboration before publishing).
import { SKEPTIC_MODELS, SKEPTIC_ROUNDS, SKEPTIC_CONTEXT_LINES, severityRank } from "../config";
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
  });
  if (res.error) {
    logVerbose(`skeptic ${model} 呼叫失敗：${res.error}`);
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
    `skeptic：驗證 ${outcomes.length} 筆，推翻 ${killed} 筆、保留 ${outcomes.length - killed} 筆` +
      `（每筆 ${SKEPTIC_ROUNDS} 輪，模型 ${SKEPTIC_MODELS.join("、")}）`,
  );
  for (const o of outcomes) {
    if (!o.killed) continue;
    const why = o.verdicts.find((v) => v.refuted)?.reason ?? "";
    logVerbose(`  推翻：${o.finding.file}:${o.finding.anchor?.startLine} — ${why.slice(0, 120)}`);
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
    f.skepticVerdicts = answered.length;
    f.skepticRefuted = answered.filter((v) => v.refuted).length;

    const downgrades = answered
      .map((v) => v.suggestedSeverity)
      .filter((s): s is Severity => s !== undefined && severityRank(s) > severityRank(f.severity));
    if (downgrades.length > 0) {
      const mildest = downgrades.reduce((a, b) => (severityRank(a) > severityRank(b) ? a : b));
      logVerbose(`  嚴重度下修：${f.file}:${f.anchor?.startLine} ${f.severity} → ${mildest}`);
      f.severity = mildest;
    }
    survivors.push(f);
  }
  return survivors;
}
