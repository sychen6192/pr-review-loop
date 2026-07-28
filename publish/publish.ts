// Publishing: one sticky summary edited in place, plus inline threads for findings that
// anchored. Re-runs recognise their own threads by fingerprint and never post the same
// issue twice (the "re-review amnesia" failure mode).
import { POST_STATUS, isDryRun } from "../config";
import { createThread, listThreads, updateComment, type Thread } from "../ado/threads";
import { postStatus } from "../ado/statuses";
import { unmetCriteria } from "../gates/requirement";
import { log } from "../libs/log";
import { collectDismissals, findStaleThreads, iterationMarker, resolveStaleThreads } from "./lifecycle";
import type { AnchoredFinding, PrRef } from "../libs/types";
import type { DismissalRecord } from "./lifecycle";
import { SUMMARY_MARKER, renderFindingComment, renderSummary, type SummaryInput } from "./format";

export interface PublishResult {
  summaryThreadId?: number;
  posted: AnchoredFinding[];
  alreadyPosted: AnchoredFinding[];
  failed: Array<{ finding: AnchoredFinding; error: string }>;
  // Our own threads auto-closed because the code they pointed at changed.
  resolved: number;
  // Findings a human closed as wontFix/byDesign — raw material for future exclusion rules.
  dismissals: DismissalRecord[];
}

function findSummaryThread(threads: Thread[]): { thread: Thread; commentId: number } | undefined {
  for (const t of threads) {
    const c = t.comments?.find((c) => !c.isDeleted && (c.content ?? "").includes(SUMMARY_MARKER));
    if (c) return { thread: t, commentId: c.id };
  }
  return undefined;
}

function postedFingerprints(threads: Thread[]): Set<string> {
  const out = new Set<string>();
  const re = /<!-- prloop:fp=([0-9a-f]+) -->/g;
  for (const t of threads) {
    for (const c of t.comments ?? []) {
      if (c.isDeleted) continue;
      for (const m of (c.content ?? "").matchAll(re)) {
        if (m[1]) out.add(m[1]);
      }
    }
  }
  return out;
}

export async function publish(
  ref: PrRef,
  axes: { requirement: AnchoredFinding[]; code: AnchoredFinding[] },
  summaryInput: SummaryInput,
): Promise<PublishResult> {
  const result: PublishResult = { posted: [], alreadyPosted: [], failed: [], resolved: 0, dismissals: [] };
  const summaryBody = `${renderSummary(summaryInput)}\n${iterationMarker(summaryInput.ctx.iteration.id)}`;

  // Requirement findings go first so that if anything below fails, the message that
  // survived is the one about the PR not doing what was asked.
  const findings = [...axes.requirement, ...axes.code];

  if (isDryRun()) {
    log(
      `[DRY RUN] 不發佈。將會建立 ${findings.length} 則 inline 留言` +
        `（需求軸 ${axes.requirement.length}、程式碼軸 ${axes.code.length}）+ 1 則 summary`,
    );
    for (const f of findings) {
      log(`  ${f.severity} ${f.file}:${f.anchor?.startLine} — ${f.claim}`);
    }
    result.posted = findings;
    return result;
  }

  const threads = await listThreads(ref);
  const seen = postedFingerprints(threads);
  const { ctx } = summaryInput;

  // Close our own threads whose code has since changed, before adding new ones — otherwise
  // a PR accumulates stale comments the author already addressed.
  result.resolved = await resolveStaleThreads(ref, findStaleThreads(threads, ctx.files));
  result.dismissals = collectDismissals(threads);
  if (result.dismissals.length > 0) {
    log(`偵測到 ${result.dismissals.length} 則先前被人工標記為不修的留言（已記錄，供日後收斂規則用）`);
  }

  for (const f of findings) {
    if (seen.has(f.fingerprint)) {
      result.alreadyPosted.push(f);
      continue;
    }
    if (!f.anchor) continue; // defensive: aggregate already filtered these out
    try {
      await createThread(ref, {
        content: renderFindingComment(f),
        status: "active",
        filePath: f.file,
        anchor: f.anchor,
        changeTrackingId: f.changeTrackingId ?? ctx.changeTrackingIds.get(f.file),
        iterationId: ctx.iteration.id,
        firstComparingIteration: ctx.compareTo > 0 ? ctx.compareTo : 1,
      });
      result.posted.push(f);
      seen.add(f.fingerprint);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`[FAIL] 建立留言失敗 ${f.file}:${f.anchor.startLine}：${msg}`);
      result.failed.push({ finding: f, error: msg });
    }
  }

  if (result.alreadyPosted.length > 0) {
    log(`${result.alreadyPosted.length} 筆 findings 先前已留言過，本次略過`);
  }

  const existing = findSummaryThread(threads);
  try {
    if (existing) {
      await updateComment(ref, existing.thread.id, existing.commentId, summaryBody);
      result.summaryThreadId = existing.thread.id;
      log(`已更新 summary 留言（thread ${existing.thread.id}）`);
    } else {
      // Closed, not active: the summary is informational and should never trip a
      // "comment resolution required" policy.
      const t = await createThread(ref, { content: summaryBody, status: "closed" });
      result.summaryThreadId = t.id;
      log(`已建立 summary 留言（thread ${t.id}）`);
    }
  } catch (e) {
    log(`[FAIL] summary 留言失敗：${e instanceof Error ? e.message : String(e)}`);
  }

  if (POST_STATUS) {
    // Either axis can fail the status, and the description names which one — a single
    // "3 issues" message would hide that the real problem is an unimplemented requirement.
    const unmet = summaryInput.req ? unmetCriteria(summaryInput.req) : [];
    const risky = axes.code.filter((f) => f.severity === "critical" || f.severity === "high");
    const reasons: string[] = [];
    if (unmet.length > 0) reasons.push(`${unmet.length} 條驗收條件未滿足`);
    if (risky.length > 0) reasons.push(`${risky.length} 個高風險程式碼問題`);
    try {
      await postStatus(
        ref,
        reasons.length > 0 ? "failed" : "succeeded",
        reasons.length > 0
          ? reasons.join("、")
          : `已審查 ${ctx.files.length} 個檔案，需求與程式碼皆無阻擋項目`,
        { iterationId: ctx.iteration.id },
      );
      log(`已回報 PR status：${reasons.length > 0 ? `failed（${reasons.join("、")}）` : "succeeded"}`);
    } catch (e) {
      log(`[FAIL] PR status 回報失敗：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}
