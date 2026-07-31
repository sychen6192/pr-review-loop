// Static-analysis gate.
//
// Requires a working tree: linters need files on disk, and prloop otherwise reads blobs
// straight from Azure DevOps. Point PRR_WORKDIR at a checkout of the source branch — in a
// pipeline that's just the agent's checkout. Without one this gate skips loudly rather than
// pretending it ran.
//
// Everything a tool reports is filtered to the PR's changed lines first (reviewdog's
// diff-filter): a pre-existing warning on an untouched line is not this PR's business, and
// posting it is the fastest way to get a review bot switched off.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  MAX_TRIAGE_ITEMS,
  SEVERITIES,
  STATIC_TIMEOUT_MS,
  TRIAGE_CONTEXT_LINES,
  TRIAGE_MODEL,
  WORKDIR,
  excludedCategories,
  severityRank,
  type Severity,
} from "../config";
import { splitLines } from "../ado/blobs";
import { parseJsonObject } from "../libs/json";
import { log, logVerbose } from "../libs/log";
import { commandExists, run } from "../libs/shell";
import { filesForProfile, selectProfiles } from "../profiles";
import { parseToolOutput } from "../profiles/parsers";
import type { Profile, ToolFinding, ToolSpec } from "../profiles/types";
import type { AnchoredFinding, FileDiff, ModelRunner } from "../libs/types";
import { TRIAGE_SCHEMA } from "../models/schemas";
import { TRIAGE_SYSTEM, buildTriagePrompt, type TriageItem } from "../prompts/triage";

export interface StaticResult {
  // Authoritative findings, ready to post without a model in the loop.
  facts: ToolFinding[];
  // High-false-positive findings awaiting LLM triage.
  needsTriage: ToolFinding[];
  // Style noise: counted, never commented.
  suppressedCount: number;
  ranTools: string[];
  skipped: Array<{ tool: string; reason: string }>;
  skippedReason?: string;
  // Changed files whose on-disk content is not the content under review, so no tool ran on
  // them. Reported, never analysed: their line numbers would not be this PR's line numbers.
  staleFiles: string[];
}

const EMPTY: StaticResult = {
  facts: [],
  needsTriage: [],
  suppressedCount: 0,
  ranTools: [],
  skipped: [],
  staleFiles: [],
};

function stripLeadingSlash(p: string): string {
  return p.replace(/^\/+/, "");
}

/**
 * Whether the file on disk is byte-for-byte the content under review.
 *
 * Tool findings bypass quote anchoring — they carry line numbers straight from the linter,
 * and those numbers are then filtered against changedRightLines computed from ADO blobs. A
 * linter does not hallucinate a location, but it reports the location in the file IT read;
 * if PRR_WORKDIR sits on a different commit (behind the PR head, uncommitted edits, the
 * target branch) the two coordinate systems silently disagree and every tool comment lands
 * on the wrong line. This is the only guard on the one path that has no anchoring.
 *
 * Trailing CR is stripped on both sides: core.autocrlf checkouts differ from the blob in
 * line endings alone, which is not a content difference.
 */
export function matchesReviewedContent(absPath: string, rightLines: string[]): boolean {
  let onDisk: string[];
  try {
    onDisk = splitLines(fs.readFileSync(absPath));
  } catch {
    return false;
  }
  if (onDisk.length !== rightLines.length) return false;
  const bare = (s: string) => (s.endsWith("\r") ? s.slice(0, -1) : s);
  return onDisk.every((l, i) => bare(l) === bare(rightLines[i] ?? ""));
}

/** reviewdog's `added` filter mode: keep only findings on lines this PR changed. */
export function filterToChangedLines(
  findings: ToolFinding[],
  files: FileDiff[],
): { kept: ToolFinding[]; dropped: number } {
  const byPath = new Map<string, FileDiff>();
  for (const f of files) byPath.set(stripLeadingSlash(f.path), f);

  const kept: ToolFinding[] = [];
  let dropped = 0;
  for (const f of findings) {
    const fd = byPath.get(stripLeadingSlash(f.file));
    if (!fd) {
      dropped++;
      continue;
    }
    const from = f.line;
    const to = f.endLine && f.endLine >= f.line ? f.endLine : f.line;
    let hit = false;
    for (let l = from; l <= to; l++) {
      if (fd.changedRightLines.has(l)) {
        hit = true;
        break;
      }
    }
    if (hit) kept.push(f);
    else dropped++;
  }
  return { kept, dropped };
}

async function runTool(
  spec: ToolSpec,
  profile: Profile,
  files: string[],
  workdir: string,
): Promise<{ findings: ToolFinding[]; skipped?: string }> {
  if (spec.requires && !fs.existsSync(path.join(workdir, spec.requires))) {
    return { findings: [], skipped: `${spec.requires} not found` };
  }
  if (!(await commandExists(spec.bin))) {
    return { findings: [], skipped: `${spec.bin} not found on PATH` };
  }

  const args = spec.args(files);
  logVerbose(`static: ${spec.name} ${args.slice(0, 6).join(" ")}…`);
  const res = await run(spec.bin, args, STATIC_TIMEOUT_MS);

  // Linters conventionally exit non-zero when they find something; that's not a failure.
  if (res.code !== 0 && !spec.allowNonZeroExit) {
    return { findings: [], skipped: `exit code ${res.code}: ${res.stderr.slice(0, 200)}` };
  }
  const raw = spec.readStderr ? res.stderr : res.stdout || res.stderr;
  const parsed = parseToolOutput(raw, spec, workdir);

  const ignored = new Set(profile.ignoreRules ?? []);
  const findings = parsed.filter((f) => !ignored.has(f.ruleId));
  return { findings };
}

export async function runStaticGate(files: FileDiff[]): Promise<StaticResult> {
  if (!WORKDIR) {
    return { ...EMPTY, skippedReason: "PRR_WORKDIR not set; static analysis needs a source working directory" };
  }
  if (!fs.existsSync(WORKDIR)) {
    return { ...EMPTY, skippedReason: `PRR_WORKDIR does not exist: ${WORKDIR}` };
  }

  const changedPaths = files.map((f) => stripLeadingSlash(f.path));
  const profiles = selectProfiles(changedPaths);
  if (profiles.length === 0) {
    return { ...EMPTY, skippedReason: "No language profile matches the changed files" };
  }

  const all: ToolFinding[] = [];
  const ranTools: string[] = [];
  const skipped: Array<{ tool: string; reason: string }> = [];

  const byPath = new Map<string, FileDiff>();
  for (const f of files) byPath.set(stripLeadingSlash(f.path), f);
  const stale: string[] = [];
  let analysable = 0;

  for (const profile of profiles) {
    const targets = filesForProfile(profile, changedPaths).filter((p) => {
      const abs = path.join(WORKDIR, p);
      if (!fs.existsSync(abs)) return false;
      analysable++;
      const fd = byPath.get(p);
      // No FileDiff means the profile matched something outside the change set; nothing to
      // filter it against later anyway, so leave the existing behaviour alone.
      if (fd && !matchesReviewedContent(abs, fd.rightLines)) {
        stale.push(p);
        return false;
      }
      return true;
    });
    if (targets.length === 0) continue;

    // Tools within a profile are independent; run them together.
    const results = await Promise.all(
      profile.tools.map(async (spec) => ({
        spec,
        ...(await runTool(spec, profile, targets, WORKDIR)),
      })),
    );
    for (const r of results) {
      if (r.skipped) {
        skipped.push({ tool: r.spec.name, reason: r.skipped });
        continue;
      }
      ranTools.push(r.spec.name);
      all.push(...r.findings);
    }
  }

  // Every analysable file differing means the checkout is simply not this PR — a stale
  // branch or the wrong commit. Say that once, instead of listing every file in the change.
  if (analysable > 0 && stale.length === analysable) {
    return {
      ...EMPTY,
      staleFiles: stale,
      skippedReason:
        `PRR_WORKDIR does not contain the code under review: all ${stale.length} analysable ` +
        `files differ from iteration content. Check out the PR's source branch at its head ` +
        `commit, or clear PRR_WORKDIR to disable static analysis`,
    };
  }

  const { kept, dropped } = filterToChangedLines(all, files);
  const facts = kept.filter((f) => f.tier === "fact");
  const needsTriage = kept.filter((f) => f.tier === "triage");
  const suppressedCount = kept.filter((f) => f.tier === "suppress").length;

  // Worst-first so a triage budget spends on the findings that matter.
  const bySeverity = (a: ToolFinding, b: ToolFinding) =>
    severityRank(a.severity) - severityRank(b.severity);
  facts.sort(bySeverity);
  needsTriage.sort(bySeverity);

  log(
    `static: ran ${ranTools.length} tools → ${all.length} findings → ${kept.length} on changed lines` +
      ` (${facts.length} facts, ${needsTriage.length} to triage, ${suppressedCount} style), ` +
      `${dropped} filtered out as outside the changed region`,
  );
  for (const s of skipped) logVerbose(`  skipped ${s.tool}: ${s.reason}`);
  if (stale.length > 0) {
    log(
      `[WARN] static: ${stale.length} files skipped, PRR_WORKDIR content differs from the ` +
        `iteration under review (${stale.slice(0, 5).join(", ")}${stale.length > 5 ? ", ..." : ""})`,
    );
  }

  return { facts, needsTriage, suppressedCount, ranTools, skipped, staleFiles: stale };
}

/**
 * LLM triage of the high-false-positive tier, then conversion of everything that survives
 * into review findings. Tool findings carry real line numbers already, so they bypass the
 * quote-anchoring path entirely — a linter does not hallucinate a location.
 */
export async function triageAndConvert(
  runner: ModelRunner,
  result: StaticResult,
  files: FileDiff[],
): Promise<{ findings: AnchoredFinding[]; triaged: number; dropped: number; excluded: number }> {
  const kept: ToolFinding[] = [...result.facts];
  let dropped = 0;
  let triaged = 0;

  const batch = result.needsTriage.slice(0, MAX_TRIAGE_ITEMS);
  if (batch.length < result.needsTriage.length) {
    log(
      `static triage: ${result.needsTriage.length} awaiting verdict, over the cap — only the first ${batch.length} processed` +
        ` (the rest are not commented; raise PRR_MAX_TRIAGE_ITEMS or tighten the tool rules)`,
    );
  }

  if (batch.length > 0 && TRIAGE_MODEL) {
    const items: TriageItem[] = batch.map((f, i) => ({
      index: i,
      tool: f.tool,
      ruleId: f.ruleId,
      message: f.message,
      file: f.file,
      line: f.line,
      severity: f.severity,
    }));
    const res = await runner.chat({
      model: TRIAGE_MODEL,
      system: TRIAGE_SYSTEM,
      user: buildTriagePrompt(items, files, TRIAGE_CONTEXT_LINES),
      schema: TRIAGE_SCHEMA,
      schemaName: "triage",
    });

    if (res.error) {
      // Fail closed: an un-triaged high-FP finding is noise, so it does not get posted.
      log(`[WARN] static triage failed (${res.error}); ${batch.length} findings awaiting verdict will not be commented`);
      dropped += batch.length;
    } else {
      const parsed = parseJsonObject<{ results?: unknown }>(res.text);
      if (!parsed.ok) {
        log(`[WARN] static triage output unparseable (${parsed.error}); ${batch.length} findings will not be commented`);
        dropped += batch.length;
      } else {
        const verdicts = new Map<number, { keep: boolean; reason: string; severity?: Severity }>();
        for (const r of (Array.isArray(parsed.value.results) ? parsed.value.results : []) as unknown[]) {
          if (typeof r !== "object" || r === null) continue;
          const o = r as Record<string, unknown>;
          const idx = Number(o["index"]);
          if (!Number.isInteger(idx)) continue;
          const sev = typeof o["severity"] === "string" ? o["severity"].toLowerCase() : "";
          verdicts.set(idx, {
            keep: o["keep"] === true,
            reason: typeof o["reason"] === "string" ? o["reason"] : "",
            severity: (SEVERITIES as readonly string[]).includes(sev) ? (sev as Severity) : undefined,
          });
        }
        batch.forEach((f, i) => {
          const v = verdicts.get(i);
          // No verdict means the model skipped it; treat that as "not justified".
          if (!v?.keep) {
            dropped++;
            return;
          }
          triaged++;
          // Same rule as the skeptic: a verifying model may lower severity, never raise
          // it. The tool's own rating owns the ceiling.
          const sev =
            v.severity !== undefined && severityRank(v.severity) > severityRank(f.severity)
              ? v.severity
              : f.severity;
          kept.push({ ...f, severity: sev, message: v.reason || f.message });
        });
        log(`static triage: ${batch.length} awaiting verdict → kept ${triaged}, filtered out ${batch.length - triaged}`);
      }
    }
  } else if (batch.length > 0) {
    log(`[WARN] PRR_TRIAGE_MODEL not set; ${batch.length} high-false-positive findings will not be commented`);
    dropped += batch.length;
  }

  const byPath = new Map<string, FileDiff>();
  for (const f of files) byPath.set(f.path.replace(/^\/+/, ""), f);

  // Same exclusion rule the model findings get in aggregate: a category the config turned
  // off is off for tools too, and the drop is counted rather than silent.
  const excludedCats = new Set(excludedCategories());
  let excluded = 0;

  const findings: AnchoredFinding[] = [];
  for (const f of kept) {
    const fd = byPath.get(f.file.replace(/^\/+/, ""));
    if (!fd) continue;
    const category = categoryForRule(f);
    if (excludedCats.has(category)) {
      excluded++;
      continue;
    }
    const lineText = fd.rightLines[f.line - 1] ?? "";
    findings.push({
      category,
      severity: f.severity,
      confidence: f.tier === "fact" ? 1 : 0.8,
      file: fd.path,
      quote: lineText,
      side: "right",
      claim: `${f.message}`,
      evidence: `Reported by ${f.tool}${f.ruleId ? ` (rule ${f.ruleId})` : ""}${f.helpUri ? `\n${f.helpUri}` : ""}`,
      // A deterministic tool is its own corroboration: it doesn't guess, so it doesn't
      // need a second model to agree before we believe the location exists.
      sources: [f.tool],
      skepticVerdicts: 1,
      skepticRefuted: 0,
      fingerprint: createHash("sha1")
        .update(`tool ${f.tool} ${f.ruleId} ${f.file} ${lineText.trim()}`)
        .digest("hex")
        .slice(0, 12),
      anchor: {
        side: "right",
        startLine: f.line,
        endLine: f.endLine && f.endLine >= f.line ? f.endLine : f.line,
        startOffset: 1,
        endOffset: Math.max(lineText.replace(/\r$/, "").length + 1, 1),
      },
    });
  }
  if (excluded > 0) {
    log(`static: ${excluded} tool findings dropped, category excluded by config (${[...excludedCats].join(", ")})`);
  }
  return { findings, triaged, dropped, excluded };
}

// Maps a tool rule to a review category so tool findings sit in the same taxonomy as
// model findings and dedupe against them.
function categoryForRule(f: ToolFinding): string {
  const id = f.ruleId.toUpperCase();
  const msg = f.message.toLowerCase();
  if (f.tool === "bandit" || id.startsWith("S") || /injection|xss|csrf|secret|password|crypto/.test(msg)) {
    return "security";
  }
  if (f.tool === "mypy" || f.tool === "tsc") return "correctness";
  if (/thread|concurren|synchroniz|atomic|race/.test(msg)) return "concurrency";
  if (/close|leak|resource|stream/.test(msg)) return "reliability";
  if (/performance|inefficient|complexity/.test(msg)) return "performance";
  return "maintainability";
}
