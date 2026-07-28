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
  severityRank,
  type Severity,
} from "../config";
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
}

const EMPTY: StaticResult = {
  facts: [],
  needsTriage: [],
  suppressedCount: 0,
  ranTools: [],
  skipped: [],
};

function stripLeadingSlash(p: string): string {
  return p.replace(/^\/+/, "");
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
    return { findings: [], skipped: `找不到 ${spec.requires}` };
  }
  if (!(await commandExists(spec.bin))) {
    return { findings: [], skipped: `PATH 中找不到 ${spec.bin}` };
  }

  const args = spec.args(files);
  logVerbose(`static：${spec.name} ${args.slice(0, 6).join(" ")}…`);
  const res = await run(spec.bin, args, STATIC_TIMEOUT_MS);

  // Linters conventionally exit non-zero when they find something; that's not a failure.
  if (res.code !== 0 && !spec.allowNonZeroExit) {
    return { findings: [], skipped: `結束碼 ${res.code}：${res.stderr.slice(0, 200)}` };
  }
  const raw = spec.readStderr ? res.stderr : res.stdout || res.stderr;
  const parsed = parseToolOutput(raw, spec, workdir);

  const ignored = new Set(profile.ignoreRules ?? []);
  const findings = parsed.filter((f) => !ignored.has(f.ruleId));
  return { findings };
}

export async function runStaticGate(files: FileDiff[]): Promise<StaticResult> {
  if (!WORKDIR) {
    return { ...EMPTY, skippedReason: "未設定 PRR_WORKDIR，靜態分析需要原始碼工作目錄" };
  }
  if (!fs.existsSync(WORKDIR)) {
    return { ...EMPTY, skippedReason: `PRR_WORKDIR 不存在：${WORKDIR}` };
  }

  const changedPaths = files.map((f) => stripLeadingSlash(f.path));
  const profiles = selectProfiles(changedPaths);
  if (profiles.length === 0) {
    return { ...EMPTY, skippedReason: "本次變更沒有對應的語言 profile" };
  }

  const all: ToolFinding[] = [];
  const ranTools: string[] = [];
  const skipped: Array<{ tool: string; reason: string }> = [];

  for (const profile of profiles) {
    const targets = filesForProfile(profile, changedPaths).filter((p) =>
      fs.existsSync(path.join(WORKDIR, p)),
    );
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
    `static：執行 ${ranTools.length} 個工具 → ${all.length} 筆 → 變更行內 ${kept.length} 筆` +
      `（事實 ${facts.length}、待 triage ${needsTriage.length}、風格 ${suppressedCount}），` +
      `${dropped} 筆落在變更範圍外已濾除`,
  );
  for (const s of skipped) logVerbose(`  略過 ${s.tool}：${s.reason}`);

  return { facts, needsTriage, suppressedCount, ranTools, skipped };
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
): Promise<{ findings: AnchoredFinding[]; triaged: number; dropped: number }> {
  const kept: ToolFinding[] = [...result.facts];
  let dropped = 0;
  let triaged = 0;

  const batch = result.needsTriage.slice(0, MAX_TRIAGE_ITEMS);
  if (batch.length < result.needsTriage.length) {
    log(
      `static triage：待判定 ${result.needsTriage.length} 筆，超過上限只處理前 ${batch.length} 筆` +
        `（其餘未進入留言，請調高 PRR_MAX_TRIAGE_ITEMS 或收斂工具規則）`,
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
      log(`[WARN] static triage 失敗（${res.error}），${batch.length} 筆待判定 findings 不予留言`);
      dropped += batch.length;
    } else {
      const parsed = parseJsonObject<{ results?: unknown }>(res.text);
      if (!parsed.ok) {
        log(`[WARN] static triage 輸出無法解析（${parsed.error}），${batch.length} 筆不予留言`);
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
          kept.push({ ...f, severity: v.severity ?? f.severity, message: v.reason || f.message });
        });
        log(`static triage：${batch.length} 筆待判定 → 保留 ${triaged} 筆、濾除 ${batch.length - triaged} 筆`);
      }
    }
  } else if (batch.length > 0) {
    log(`[WARN] 未設定 PRR_TRIAGE_MODEL，${batch.length} 筆高誤報率 findings 不予留言`);
    dropped += batch.length;
  }

  const byPath = new Map<string, FileDiff>();
  for (const f of files) byPath.set(f.path.replace(/^\/+/, ""), f);

  const findings: AnchoredFinding[] = [];
  for (const f of kept) {
    const fd = byPath.get(f.file.replace(/^\/+/, ""));
    if (!fd) continue;
    const lineText = fd.rightLines[f.line - 1] ?? "";
    findings.push({
      category: categoryForRule(f),
      severity: f.severity,
      confidence: f.tier === "fact" ? 1 : 0.8,
      file: fd.path,
      quote: lineText,
      side: "right",
      claim: `${f.message}`,
      evidence: `由 ${f.tool} 回報${f.ruleId ? `（規則 ${f.ruleId}）` : ""}${f.helpUri ? `\n${f.helpUri}` : ""}`,
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
  return { findings, triaged, dropped };
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
