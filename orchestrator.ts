// The single deterministic control flow. Models are called at exactly one point (the finder
// stage); every other decision — what to review, where a finding lives, what gets posted —
// is made by code here (design principle: the loop never hands control to a model).
import { SKIP_REQUIREMENT } from "./config";
import { buildReviewContext, type ReviewContext } from "./ado/intake";
import { aggregate, type AggregateResult } from "./gates/aggregate";
import { runFinders } from "./gates/finder";
import { runRequirementGate, toRequirementFindings } from "./gates/requirement";
import { createRunDir } from "./libs/artifacts";
import { banner, log } from "./libs/log";
import type { AnchoredFinding, ModelRunner, PrRef, RequirementResult } from "./libs/types";
import { publish, type PublishResult } from "./publish/publish";

export interface ReviewRunOptions {
  ref: PrRef;
  runner: ModelRunner;
  compareTo: number;
}

export interface ReviewRunResult {
  ctx: ReviewContext;
  agg: AggregateResult;
  req?: RequirementResult;
  reqFindings: AnchoredFinding[];
  publishResult?: PublishResult;
  runDir: string;
  durationSec: number;
}

export async function runReview(opts: ReviewRunOptions): Promise<ReviewRunResult> {
  const started = Date.now();

  banner("Step 1/4：取得 PR 變更內容");
  const ctx = await buildReviewContext(opts.ref, opts.compareTo);
  const run = createRunDir(opts.ref, ctx.iteration.id);
  log(`artifacts：${run.dir}`);

  run.saveJson("context.json", {
    ref: opts.ref,
    pr: ctx.pr,
    iteration: ctx.iteration,
    compareTo: ctx.compareTo,
    files: ctx.files.map((f) => ({
      path: f.path,
      changeType: f.changeType,
      language: f.language,
      hunks: f.hunks.length,
      changedLines: f.changedRightLines.size,
    })),
    skipped: ctx.skipped,
  });

  if (ctx.files.length === 0) {
    log("沒有可審查的程式碼變更，結束");
    const agg: AggregateResult = {
      inline: [],
      belowBar: [],
      degraded: [],
      stats: { raw: 0, afterDedupe: 0, anchored: 0, inline: 0, byFailure: {} },
    };
    return {
      ctx,
      agg,
      reqFindings: [],
      runDir: run.dir,
      durationSec: Math.round((Date.now() - started) / 1000),
    };
  }

  // The two axes run concurrently and blind to each other: neither model sees the other's
  // output, so "the code is clean" can't excuse a missing requirement, or vice versa.
  banner("Step 2/4：執行需求軸與程式碼軸");
  const [reqOut, finderOut] = await Promise.all([
    SKIP_REQUIREMENT
      ? Promise.resolve<Awaited<ReturnType<typeof runRequirementGate>>>({
          result: {
            workItems: [],
            criteria: [],
            extras: [],
            skipped: "依設定跳過需求檢查",
          },
        })
      : runRequirementGate({ ref: opts.ref, pr: ctx.pr, files: ctx.files, runner: opts.runner }),
    runFinders(opts.runner, {
      pr: ctx.pr,
      files: ctx.files,
      iterationId: ctx.iteration.id,
      compareTo: ctx.compareTo,
    }),
  ]);

  const req = reqOut.result;
  if (reqOut.prompt) run.save("requirement-prompt.md", reqOut.prompt);
  if (reqOut.raw) run.save("requirement-raw.txt", reqOut.raw);
  run.saveJson("requirement.json", req);

  const { outputs, prompt, omitted, rules } = finderOut;
  run.save("finder-prompt.md", prompt);
  outputs.forEach((o, i) => {
    run.save(`finder-${i}-${o.model.replace(/[^\w.-]/g, "_")}-raw.txt`, o.raw || `(error: ${o.error ?? "no output"})`);
  });
  run.saveJson("finder-outputs.json", outputs.map((o) => ({ ...o, raw: undefined })));

  banner("Step 3/4：定位與彙整");
  const agg = aggregate(outputs, ctx.files);
  const reqFindings = toRequirementFindings(req, ctx.files);
  // Attach the tracking id ADO needs for each thread to survive future pushes.
  for (const f of [...agg.inline, ...reqFindings]) {
    f.changeTrackingId = ctx.changeTrackingIds.get(f.file);
  }
  run.saveJson("requirement-findings.json", reqFindings);
  run.saveJson("findings.json", {
    inline: agg.inline,
    belowBar: agg.belowBar,
    degraded: agg.degraded,
    stats: agg.stats,
  });

  banner("Step 4/4：發佈留言");
  const durationSec = Math.round((Date.now() - started) / 1000);
  const finderErrors = outputs
    .filter((o) => o.error)
    .map((o) => ({ model: o.model, error: o.error! }));

  const publishResult = await publish(
    opts.ref,
    { requirement: reqFindings, code: agg.inline },
    {
      ctx,
      agg,
      req,
      finderErrors,
      omittedFiles: omitted,
      appliedRules: rules,
      durationSec,
      runDir: run.dir,
    },
  );
  run.saveJson("publish.json", {
    summaryThreadId: publishResult.summaryThreadId,
    posted: publishResult.posted.map((f) => ({ fp: f.fingerprint, file: f.file, line: f.anchor?.startLine })),
    alreadyPosted: publishResult.alreadyPosted.map((f) => f.fingerprint),
    failed: publishResult.failed.map((x) => ({ fp: x.finding.fingerprint, error: x.error })),
  });

  return { ctx, agg, req, reqFindings, publishResult, runDir: run.dir, durationSec };
}
