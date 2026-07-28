#!/usr/bin/env -S npx tsx
// CLI entry: prloop <PR URL> [--since <iteration>] [--dry-run]
//
// Exit codes: 0 = reviewed, no high-risk findings; 2 = high-risk findings posted;
// 1 = fatal (auth, network, bad arguments).
import { FINDER_MODELS, LLM_BASE_URL, isDryRun } from "./config";
import { parsePrUrl } from "./ado/client";
import { unmetCriteria } from "./gates/requirement";
import { banner, die, log } from "./libs/log";
import { createRunner } from "./models/runner";
import { runReview } from "./orchestrator";

function usage(): never {
  console.error(`用法：prloop <PR URL> [選項]

  <PR URL>              https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}

選項：
  --since <iteration>   只審查該 iteration 之後的變更（增量 review）
  --dry-run             計算但不發佈留言
  -h, --help            顯示此說明

環境變數見 .env.example。`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) usage();

  const url = args.find((a) => !a.startsWith("-"));
  if (!url) usage();

  let compareTo = 0;
  const sinceIdx = args.indexOf("--since");
  if (sinceIdx >= 0) {
    const raw = args[sinceIdx + 1];
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) die(`--since 需要非負整數，收到：${raw}`);
    compareTo = n;
  }
  if (args.includes("--dry-run")) process.env["PRR_DRY_RUN"] = "1";

  const ref = parsePrUrl(url);
  banner(`prloop：${ref.org}/${ref.project}/${ref.repoId} PR !${ref.prId}`);
  log(`模型：${FINDER_MODELS.join("、")} @ ${LLM_BASE_URL}`);
  if (isDryRun()) log("DRY RUN：不會發佈任何留言");
  if (compareTo > 0) log(`增量模式：只審查 iteration ${compareTo} 之後的變更`);

  const result = await runReview({ ref, runner: createRunner(), compareTo });

  banner("完成");
  log(`耗時 ${result.durationSec}s，artifacts：${result.runDir}`);

  const unmet = result.req ? unmetCriteria(result.req) : [];
  if (result.req?.skipped) log(`需求軸：${result.req.skipped}`);
  else if (result.req?.error) log(`需求軸：未能完成（${result.req.error}）`);
  else if (result.req) {
    log(
      `需求軸：${result.req.criteria.length} 條驗收條件，${unmet.length} 條未滿足` +
        (result.req.extras.length ? `，${result.req.extras.length} 項範圍外變更` : ""),
    );
  }

  const { inline, degraded, belowBar } = result.agg;
  log(`程式碼軸：inline 留言 ${inline.length}｜未達門檻 ${belowBar.length}｜無法定位 ${degraded.length}`);
  if (result.publishResult) {
    log(
      `實際發佈 ${result.publishResult.posted.length}｜先前已發過 ${result.publishResult.alreadyPosted.length}` +
        (result.publishResult.failed.length ? `｜失敗 ${result.publishResult.failed.length}` : ""),
    );
  }

  // Either axis can fail the run: an unimplemented requirement is as blocking as a bug.
  const highRisk = inline.filter((f) => f.severity === "critical" || f.severity === "high");
  process.exit(highRisk.length > 0 || unmet.length > 0 ? 2 : 0);
}

main().catch((e) => {
  die(e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e));
});
