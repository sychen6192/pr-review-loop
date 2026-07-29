// Preflight. Every check that can fail at 3am should fail here instead, with the fix in
// the message. Run `doctor <PR URL> --smoke` before the first real run.
import {
  ADO_AUTH_MODE,
  ADO_PAT,
  AZ_BIN,
  FINDER_MODELS,
  LLM_BASE_URL,
  MAX_INLINE_COMMENTS,
  ADO_API_VERSION,
  MIN_INLINE_SEVERITY,
  OPENCODE_AGENT,
  SKIP_STATIC,
  TRIAGE_MODEL,
  WORKDIR,
  OPENCODE_BIN,
  REQUIRE_CORROBORATION,
  RUNNER_KIND,
  SKEPTIC_MODELS,
  SKEPTIC_ROUNDS,
} from "../config";
import { adoGet, parsePrUrl, prBase } from "../ado/client";
import { describeAuthMode } from "../ado/auth";
import { existsSync } from "node:fs";
import { commandExists, run } from "../libs/shell";
import { proxySummary } from "../libs/proxy";
import { PROFILES } from "../profiles";
import { createRunner } from "../models/runner";
import { FINDINGS_SCHEMA } from "../models/schemas";
import { parseJsonObject } from "../libs/json";

let warnings = 0;
let errors = 0;

function ok(label: string, detail = "") {
  console.log(`  [OK]   ${label}${detail ? ` — ${detail}` : ""}`);
}
function warn(label: string, fix: string) {
  warnings++;
  console.log(`  [WARN] ${label}\n         → ${fix}`);
}
function bad(label: string, fix: string) {
  errors++;
  console.log(`  [FAIL] ${label}\n         → ${fix}`);
}

async function main() {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith("-"));
  const smoke = args.includes("--smoke");

  console.log("\n環境");
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok("Node.js", `v${process.versions.node}`);
  else bad(`Node.js v${process.versions.node} 過舊`, "需要 v20 以上（本工具使用內建 fetch）");
  if (process.env["NODE_EXTRA_CA_CERTS"]) {
    ok("額外 CA 憑證", process.env["NODE_EXTRA_CA_CERTS"]);
  } else if ((process.env["NODE_OPTIONS"] ?? "").includes("use-system-ca")) {
    ok("憑證來源", "系統信任存放區（--use-system-ca）");
  }
  ok("proxy", proxySummary());

  console.log("\nAzure DevOps 認證");
  ok("認證模式", await describeAuthMode());
  const hasAz = await commandExists(AZ_BIN);
  if (ADO_PAT) {
    ok("PAT", `已設定（長度 ${ADO_PAT.length}）`);
  } else if (hasAz) {
    const acct = await run(AZ_BIN, ["account", "show", "--query", "user.name", "-o", "tsv"]);
    if (acct.code === 0 && acct.stdout.trim()) ok("az 登入身分", acct.stdout.trim());
    else bad("az 已安裝但尚未登入", "執行 az login");
  } else if (ADO_AUTH_MODE === "azcli") {
    bad(`PRR_AUTH_MODE=azcli 但找不到 ${AZ_BIN}`, "安裝 Azure CLI，或改用 PAT");
  } else {
    bad("沒有可用的認證", "二擇一：設定 PRR_ADO_PAT，或安裝 az CLI 並執行 az login");
  }

  console.log("\nRunner");
  ok("runner", RUNNER_KIND);
  if (RUNNER_KIND === "opencode") {
    if (await commandExists(OPENCODE_BIN)) ok("opencode CLI", "已安裝");
    else bad(`找不到 ${OPENCODE_BIN}`, "安裝 opencode CLI，或設 PRR_OPENCODE_BIN");
    ok("agent", OPENCODE_AGENT);
    warn(
      "opencode 不會把 response_format 傳給後端",
      "schema 只能靠 prompt 約束，弱模型的格式服從度會下降。" +
        "後端若支援 guided decoding（vLLM/xgrammar），改用 PRR_RUNNER=openai 精度更好",
    );
  } else {
    ok("endpoint", LLM_BASE_URL);
  }

  console.log("\n模型");
  ok("finder 模型", FINDER_MODELS.join("、"));
  if (FINDER_MODELS.length === 1) {
    warn(
      "只設定一顆 finder 模型",
      "多模型交叉比對是精度的主要來源。在 PRR_FINDER_MODELS 填入多顆「不同家族」的模型",
    );
  }
  if (SKEPTIC_MODELS.length === 0) {
    warn(
      "未設定 skeptic 模型，對抗驗證不會執行",
      "設 PRR_SKEPTIC_MODELS。若同時只有一顆 finder，所有 findings 都會因缺乏佐證而不留 inline 留言",
    );
  } else {
    ok("skeptic 模型", `${SKEPTIC_MODELS.join("、")}（每筆 ${SKEPTIC_ROUNDS} 輪）`);
    const overlap = SKEPTIC_MODELS.filter((m) => FINDER_MODELS.includes(m));
    if (overlap.length > 0) {
      warn(
        `skeptic 與 finder 使用同一顆模型：${overlap.join("、")}`,
        "同家族驗證者會共用 finder 的盲點，最該抓的錯誤反而會被確認。請改用不同家族的模型",
      );
    }
  }
  if (!REQUIRE_CORROBORATION) {
    warn("已關閉佐證要求（PRR_REQUIRE_CORROBORATION=0）", "單一模型未經驗證的 findings 會直接留言，誤報率會上升");
  }

  console.log("\n靜態分析");
  if (SKIP_STATIC) {
    ok("已停用", "PRR_SKIP_STATIC=1");
  } else if (!WORKDIR) {
    warn(
      "未設定 PRR_WORKDIR，靜態分析不會執行",
      "指向 PR 來源分支的 checkout；在 pipeline 中就是 agent 的工作目錄",
    );
  } else if (!existsSync(WORKDIR)) {
    bad(`PRR_WORKDIR 不存在：${WORKDIR}`, "確認路徑，或清空以停用靜態分析");
  } else {
    ok("工作目錄", WORKDIR);
    const tools = [...new Set(PROFILES.flatMap((p) => p.tools.map((t) => t.bin)))];
    const found: string[] = [];
    const missing: string[] = [];
    for (const t of tools) ((await commandExists(t)) ? found : missing).push(t);
    if (found.length > 0) ok("可用的工具", found.join("、"));
    if (missing.length > 0) warn(`PATH 中找不到：${missing.join("、")}`, "對應的工具會被略過，不影響其他階段");
    if (!TRIAGE_MODEL) {
      warn(
        "未設定 PRR_TRIAGE_MODEL",
        "bandit / PMD / eslint 等高誤報工具的結果會被丟棄而非留言（刻意 fail-closed）。" +
          "設定後才會由模型判定其真偽",
      );
    } else {
      ok("triage 模型", TRIAGE_MODEL);
    }
  }

  console.log("\n發佈設定");
  ok("inline 留言上限", String(MAX_INLINE_COMMENTS));
  ok("最低留言嚴重度", MIN_INLINE_SEVERITY);

  if (url) {
    console.log("\nPR 連線測試");
    try {
      const ref = parsePrUrl(url);
      ok("URL 解析", `collection=${ref.org}｜project=${ref.project}｜repo=${ref.repoId}｜PR !${ref.prId}`);
      // The single most useful line when an on-prem request fails: it shows exactly what
      // the REST calls will hit, so a wrong collection or missing virtual directory is
      // visible before anything is sent.
      ok("API base", ref.baseUrl);
      ok("實際請求位址", `${prBase(ref)}?api-version=${ADO_API_VERSION}`);
      try {
        const pr = await adoGet<{ title?: string; status?: string }>(prBase(ref));
        ok("讀取 PR", `「${pr.title ?? ""}」狀態 ${pr.status ?? "?"}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const hint = /api-version|Unsupported|not supported/i.test(msg)
          ? `此伺服器不支援 api-version ${ADO_API_VERSION}。on-prem 對應版本：Server 2019→5.0、2020→6.0、2022→7.0。設 PRR_ADO_API_VERSION 調整`
          : /憑證|TLS|DNS|逾時|拒/.test(msg)
            ? "見上方訊息中的解法"
            : "檢查認證是否有效、以及上方「API base」是否為正確的 collection 位址";
        bad(`讀取 PR 失敗：${msg}`, hint);
      }
    } catch (e) {
      bad(`URL 解析失敗：${e instanceof Error ? e.message : String(e)}`, "格式需為 .../{org}/{project}/_git/{repo}/pullrequest/{id}");
    }
  } else {
    console.log("\nPR 連線測試");
    warn("未提供 PR URL，略過", "執行 doctor <PR URL> 可一併測試 ADO 連線");
  }

  if (smoke) {
    console.log("\n模型實測（--smoke）");
    const runner = await createRunner();
    for (const model of FINDER_MODELS) {
      const res = await runner.chat({
        model,
        system: "You output only JSON matching the given schema.",
        user:
          '回傳一個 findings 陣列，其中恰好一筆：category "logic"、severity "low"、' +
          'confidence 0.5、file "/a.ts"、quote "x();"、claim "smoke test"。',
        schema: FINDINGS_SCHEMA,
        schemaName: "findings",
        maxTokens: 512,
      });
      if (res.error) {
        bad(`${model} 呼叫失敗：${res.error}`, "檢查 PRR_LLM_BASE_URL / API key / 模型名稱是否正確");
        continue;
      }
      const parsed = parseJsonObject<{ findings?: unknown[] }>(res.text);
      if (!parsed.ok) {
        bad(
          `${model} 輸出無法解析：${parsed.error}`,
          "後端可能不支援 json_schema。改用 vLLM guided decoding，或設 PRR_LLM_STRUCTURED=0 後觀察",
        );
      } else if (!Array.isArray(parsed.value.findings)) {
        warn(`${model} 回傳 JSON 但缺少 findings 陣列`, "弱模型常見；schema 強制未生效時精度會下降");
      } else {
        ok(`${model} 結構化輸出正常`, `findings ${parsed.value.findings.length} 筆`);
      }
    }
  } else {
    console.log("\n模型實測");
    warn("未加 --smoke，略過", "首次設定建議執行 doctor <PR URL> --smoke 實測一次模型");
  }

  console.log(`\n結果：${errors} 個錯誤、${warnings} 個警告`);
  if (errors > 0) console.log("有錯誤項目，先依上方提示修正再執行 prloop。");
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
