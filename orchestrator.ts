// The single deterministic control flow. Models are called at exactly one point (the finder
// stage); every other decision — what to review, where a finding lives, what gets posted —
// is made by code here (design principle: the loop never hands control to a model).
import { SKIP_REQUIREMENT, SKIP_STATIC } from "./config";
import { buildReviewContext, type ReviewContext } from "./ado/intake";
import { anchorAndDedupe, finalize, mergeToolFindings, type AggregateResult } from "./gates/aggregate";
import { runFinders } from "./gates/finder";
import { runRequirementGate, toRequirementFindings } from "./gates/requirement";
import { applyVerdicts, runSkeptic } from "./gates/skeptic";
import { runStaticGate, triageAndConvert, type StaticResult } from "./gates/static";
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

  banner("Step 1/4: fetch PR changes");
  const ctx = await buildReviewContext(opts.ref, opts.compareTo);
  const run = createRunDir(opts.ref, ctx.iteration.id);
  log(`artifacts: ${run.dir}`);

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
    log("No reviewable code changes, exiting");
    const agg: AggregateResult = {
      inline: [],
      belowBar: [],
      degraded: [],
      stats: { raw: 0, afterDedupe: 0, anchored: 0, survived: 0, inline: 0, byFailure: {} },
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
  banner("Step 2/4: static analysis, requirement axis and code axis");
  const [staticResult, reqOut, finderOut] = await Promise.all([
    SKIP_STATIC
      ? Promise.resolve<StaticResult>({
          facts: [],
          needsTriage: [],
          suppressedCount: 0,
          ranTools: [],
          skipped: [],
          skippedReason: "static analysis skipped by config",
        })
      : runStaticGate(ctx.files),
    SKIP_REQUIREMENT
      ? Promise.resolve<Awaited<ReturnType<typeof runRequirementGate>>>({
          result: {
            workItems: [],
            criteria: [],
            extras: [],
            skipped: "requirement check skipped by config",
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

  if (staticResult.skippedReason) log(`Static analysis: ${staticResult.skippedReason}`);
  run.saveJson("static.json", staticResult);

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

  banner("Step 3/4: anchor, adversarial verification and verdicts");
  const candidates = anchorAndDedupe(outputs, ctx.files);

  // Adversarial verification. The finder ran in coverage mode and is expected to
  // over-report; this is the stage that does the killing.
  const outcomes = await runSkeptic(opts.runner, candidates.merged, ctx.files);
  const survivors = applyVerdicts(outcomes);
  run.saveJson(
    "skeptic.json",
    outcomes.map((o) => ({
      file: o.finding.file,
      line: o.finding.anchor?.startLine,
      claim: o.finding.claim,
      killed: o.killed,
      verdicts: o.verdicts,
    })),
  );

  // Tool findings join the code axis after triage. They carry real line numbers, so they
  // skip anchoring, and a deterministic tool counts as its own corroboration.
  const toolOut = await triageAndConvert(opts.runner, staticResult, ctx.files);
  run.saveJson("static-findings.json", toolOut);

  const agg = finalize(candidates, mergeToolFindings(survivors, toolOut.findings));
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

  banner("Step 4/4: post comments");
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
      staticResult,
      durationSec,
      runDir: run.dir,
    },
  );
  run.saveJson("publish.json", {
    summaryThreadId: publishResult.summaryThreadId,
    posted: publishResult.posted.map((f) => ({ fp: f.fingerprint, file: f.file, line: f.anchor?.startLine })),
    alreadyPosted: publishResult.alreadyPosted.map((f) => f.fingerprint),
    failed: publishResult.failed.map((x) => ({ fp: x.finding.fingerprint, error: x.error })),
    resolved: publishResult.resolved,
    dismissals: publishResult.dismissals,
  });

  return { ctx, agg, req, reqFindings, publishResult, runDir: run.dir, durationSec };
}
