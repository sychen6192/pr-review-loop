// Raw connectivity probe. Answers "why is my request failing" by showing everything the
// normal code path hides: where each setting actually came from, the exact URL, the raw
// HTTP status and the server's own error message.
//
// doctor tells you whether things work. probe tells you why they don't.
import * as fs from "node:fs";
import * as path from "node:path";
import { ADO_API_VERSION, ADO_PAT, PRLOOP_ROOT } from "../config";
import { authHeader, describeAuthMode } from "../ado/auth";
import { parsePrUrl, prBase, repoBase } from "../ado/client";

// api-versions worth trying, newest first. Cloud speaks 7.1; on-prem tops out lower
// depending on the server release.
const CANDIDATE_VERSIONS = ["7.1", "7.0", "6.0", "5.1", "5.0"];

function line(label: string, value: string) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

/**
 * Config provenance. The .env loader deliberately never overrides an existing environment
 * variable, so a stale `export` in a shell profile silently wins over the file — which is
 * invisible unless you look for it.
 */
function reportProvenance(keys: string[]) {
  const envPath = path.join(PRLOOP_ROOT, ".env");
  const fileValues = new Map<string, string>();
  if (fs.existsSync(envPath)) {
    for (const raw of fs.readFileSync(envPath, "utf8").split("\n")) {
      const s = raw.trim();
      if (!s || s.startsWith("#")) continue;
      const i = s.indexOf("=");
      if (i <= 0) continue;
      fileValues.set(s.slice(0, i).trim(), s.slice(i + 1).trim());
    }
  } else {
    console.log(`  （找不到 ${envPath}）`);
  }

  for (const k of keys) {
    const inFile = fileValues.get(k);
    const effective = process.env[k];
    const shown = k.includes("PAT") || k.includes("KEY")
      ? effective
        ? `（已設定，長度 ${effective.length}）`
        : "（未設定）"
      : (effective ?? "（未設定）");

    let source = "預設值";
    if (inFile !== undefined && effective === inFile) source = ".env";
    else if (effective !== undefined && inFile === undefined) source = "shell 環境變數";
    else if (inFile !== undefined && effective !== inFile) {
      source = `⚠️  shell 環境變數覆蓋了 .env（.env 寫的是「${inFile}」，實際生效的是「${effective ?? ""}」）`;
    }
    line(k, `${shown}   ← ${source}`);
  }
}

async function rawGet(url: string, header: string): Promise<void> {
  console.log(`\n  GET ${url}`);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { Authorization: header, Accept: "application/json" },
    });
    const ms = Date.now() - started;
    const ctype = res.headers.get("content-type") ?? "";
    line("HTTP 狀態", `${res.status} ${res.statusText}   (${ms}ms)`);
    line("content-type", ctype);

    const body = await res.text();
    if (res.status === 203 || ctype.includes("text/html")) {
      console.log(
        "  → 收到登入頁而非 JSON。這代表認證沒有被接受：PAT 無效、已過期、" +
          "或缺少 Code (Read & Write) scope。",
      );
      return;
    }
    // ADO puts the real reason in a JSON `message` field; show it verbatim rather than
    // truncating it into an exception.
    try {
      const j = JSON.parse(body) as Record<string, unknown>;
      if (typeof j["message"] === "string") {
        console.log(`  伺服器訊息：${j["message"]}`);
      } else if (typeof j["title"] === "string") {
        console.log(`  ${String(j["title"])}｜狀態 ${String(j["status"] ?? "")}`);
      } else {
        const keys = Object.keys(j).slice(0, 8).join(", ");
        console.log(`  回應 JSON 欄位：${keys}`);
      }
    } catch {
      console.log(`  回應前 300 字元：${body.slice(0, 300)}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { cause?: { code?: string } })?.cause?.code ?? "";
    line("連線失敗", `${msg}${code ? `（${code}）` : ""}`);
  }
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("用法：tsx scripts/probe.ts '<PR URL>'");
    process.exit(1);
  }

  console.log("\n=== 1. 設定值與來源 ===");
  reportProvenance([
    "PRR_ADO_PAT",
    "PRR_AUTH_MODE",
    "PRR_ADO_BASE_URL",
    "PRR_ADO_API_VERSION",
    "PRR_LLM_BASE_URL",
    "HTTPS_PROXY",
    "NODE_EXTRA_CA_CERTS",
  ]);
  line("生效的 api-version", ADO_API_VERSION);
  if (!/^\d+\.\d+$/.test(ADO_API_VERSION)) {
    console.log(
      `  ⚠️  「${ADO_API_VERSION}」不是合法格式。ADO 只接受 x.y（例如 7.1、6.0），` +
        "少了小數點會被伺服器拒絕。",
    );
  }

  console.log("\n=== 2. URL 解析 ===");
  const ref = parsePrUrl(url);
  line("collection / org", ref.org);
  line("project", ref.project);
  line("repository", ref.repoId);
  line("PR id", String(ref.prId));
  line("API base", ref.baseUrl);
  if (ref.baseUrl.includes("dev.azure.com")) {
    console.log("  → 這是 Azure DevOps Services（雲端）。api-version 用預設的 7.1 即可。");
  } else {
    console.log("  → 這是 on-prem Server。api-version 需配合伺服器版本（2019→5.0、2020→6.0、2022→7.0）。");
  }

  console.log("\n=== 3. 認證 ===");
  line("模式", await describeAuthMode());
  let header: string;
  try {
    header = await authHeader();
    line("Authorization", `${header.split(" ")[0]} ...（長度 ${header.length}）`);
    if (ADO_PAT && /\s/.test(ADO_PAT)) {
      console.log("  ⚠️  PAT 內含空白字元，多半是複製時帶到換行或空格。");
    }
  } catch (e) {
    line("取得認證失敗", e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  console.log("\n=== 4. 用目前設定實際請求一次 ===");
  await rawGet(`${prBase(ref)}?api-version=${ADO_API_VERSION}`, header);

  console.log("\n=== 5. 逐一測試各 api-version，找出這台伺服器接受哪個 ===");
  const working: string[] = [];
  for (const v of CANDIDATE_VERSIONS) {
    try {
      const res = await fetch(`${prBase(ref)}?api-version=${v}`, {
        headers: { Authorization: header, Accept: "application/json" },
      });
      const ok = res.ok && (res.headers.get("content-type") ?? "").includes("json");
      console.log(`  api-version=${v.padEnd(4)} → ${res.status} ${res.statusText}${ok ? "  ✅" : ""}`);
      if (ok) working.push(v);
    } catch (e) {
      console.log(`  api-version=${v.padEnd(4)} → 連線失敗：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log("\n=== 結論 ===");
  if (working.length > 0) {
    console.log(`  這台伺服器接受：${working.join("、")}`);
    if (!working.includes(ADO_API_VERSION)) {
      console.log(`  你目前設的是「${ADO_API_VERSION}」，不在可用清單中。`);
      console.log(`  → 把 .env 的 PRR_ADO_API_VERSION 改成 ${working[0]}，或整行刪掉用預設值。`);
      console.log(`  → 若 .env 改了沒效，檢查 shell 是否有 export PRR_ADO_API_VERSION（見第 1 節）。`);
    } else {
      console.log("  api-version 沒問題。若 prloop 仍失敗，問題在其他階段（模型或發佈）。");
    }
  } else {
    console.log("  所有 api-version 都失敗 —— 問題不在版本號，而在認證或網路。");
    console.log("  依第 4 節的訊息判斷：登入頁=PAT 無效或 scope 不足；");
    console.log("  404=PR id 或 repo 名稱不對；連線失敗=DNS/憑證/proxy。");
  }
  console.log();
}

main().catch((e) => {
  console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
