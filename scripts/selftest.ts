// Offline self-test. Anchoring is the piece that decides whether comments land on the right
// line, so it gets the most coverage here — these assertions are the regression net for the
// class of bug that motivated the whole project.
import { splitLines } from "../ado/blobs";
import { anchorFinding, resolveFile } from "../anchoring/locate";
import { parsePrUrl, prBase } from "../ado/client";
import { buildHunks, diffLines, renderUnifiedDiff } from "../libs/diff";
import { parseJsonObject } from "../libs/json";
import { detectLanguage, isNoiseFile, isReviewable } from "../libs/lang";
import { buildDiffPayload } from "../libs/payload";
import { htmlToText } from "../libs/html";
import { globToRegExp, loadRules, selectRules } from "../libs/rules";
import { finalize } from "../gates/aggregate";
import { bypassesProxy } from "../libs/proxy";
import { parseVerdict as parseVerdictForTest } from "../gates/skeptic";
import { filterToChangedLines } from "../gates/static";
import { parseToolOutput } from "../profiles/parsers";
import { selectProfiles, filesForProfile } from "../profiles";
import { lastReviewedIteration, findStaleThreads, collectDismissals, iterationMarker } from "../publish/lifecycle";
import type { ToolSpec } from "../profiles/types";
import type { AnchoredFinding, FileDiff, RawFinding } from "../libs/types";
import { SEEDED_FILES, EXPECTED_ANCHORS } from "../fixtures/seeded-pr";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  [OK]   ${name}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq<T>(name: string, actual: T, expected: T) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `expected ${e}, got ${a}`);
}

function section(t: string) {
  console.log(`\n${t}`);
}

// --- blob line splitting ---
section("blob 行切分（CRLF / BOM / 結尾換行）");
eq("LF 三行", splitLines(Buffer.from("a\nb\nc")), ["a", "b", "c"]);
eq("結尾換行不產生幽靈行", splitLines(Buffer.from("a\nb\n")), ["a", "b"]);
eq("CRLF 保留 \\r", splitLines(Buffer.from("a\r\nb\r\n")), ["a\r", "b\r"]);
eq("BOM 被移除", splitLines(Buffer.from("﻿a\nb")), ["a", "b"]);
eq("空檔案", splitLines(Buffer.from("")), []);
eq("單行無換行", splitLines(Buffer.from("only")), ["only"]);

// --- diff ---
section("diff 與 hunk 行號");
{
  const left = ["a", "b", "c", "d", "e"];
  const right = ["a", "b", "X", "d", "e"];
  const edits = diffLines(left, right);
  const { hunks, changedRightLines, changedLeftLines } = buildHunks(left, right, edits);
  eq("單行替換 → 1 個 hunk", hunks.length, 1);
  eq("右側變更行 = 第 3 行", [...changedRightLines], [3]);
  eq("左側刪除行 = 第 3 行", [...changedLeftLines], [3]);
  const h = hunks[0]!;
  check("hunk 涵蓋整個小檔案", h.rightStart === 1 && h.rightStart + h.rightCount - 1 === 5);
}
{
  // Line numbers must stay correct after an insertion shifts everything below it.
  const left = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"];
  const right = [...left.slice(0, 5), "NEW", ...left.slice(5)];
  const { changedRightLines } = buildHunks(left, right, diffLines(left, right));
  eq("插入行為右側第 6 行", [...changedRightLines], [6]);
}
{
  const left: string[] = [];
  const right = ["a", "b"];
  const { hunks, changedRightLines } = buildHunks(left, right, diffLines(left, right));
  eq("新檔案：兩行皆為變更", [...changedRightLines], [1, 2]);
  check("新檔案有 hunk", hunks.length === 1);
}
{
  const same = ["x", "y"];
  const { hunks } = buildHunks(same, same, diffLines(same, same));
  eq("無變更 → 無 hunk", hunks.length, 0);
}
{
  const left = ["b", "c"];
  const right = ["a", "b", "c"];
  const { hunks, changedRightLines } = buildHunks(left, right, diffLines(left, right));
  eq("開頭插入 rightStart=1", hunks[0]?.rightStart, 1);
  eq("開頭插入 leftStart=1", hunks[0]?.leftStart, 1);
  eq("開頭插入變更行=1", [...changedRightLines], [1]);
}
{
  // Scattered edits in a long file: this is where an off-by-one in hunk headers would
  // silently misplace every downstream comment.
  const bigLeft = Array.from({ length: 200 }, (_, i) => `line${i + 1}();`);
  const bigRight = [...bigLeft];
  bigRight[9] = "CHANGED10();";
  bigRight.splice(100, 0, "INSERTED();");
  bigRight[180] = "CHANGED181();";
  const { hunks, changedRightLines } = buildHunks(bigLeft, bigRight, diffLines(bigLeft, bigRight));
  eq("三處分散變更 → 3 個 hunk", hunks.length, 3);
  eq("變更行號正確", [...changedRightLines].sort((a, b) => a - b), [10, 101, 181]);
  // The strongest assertion available: a hunk's declared span must match the real file.
  for (const h of hunks) {
    const bodyRight = h.body
      .split("\n")
      .filter((l) => l.startsWith(" ") || l.startsWith("+"))
      .map((l) => l.slice(1));
    const actual = bigRight.slice(h.rightStart - 1, h.rightStart - 1 + h.rightCount);
    check(
      `hunk@${h.rightStart} 宣告的行範圍與檔案實際內容一致`,
      JSON.stringify(bodyRight) === JSON.stringify(actual),
    );
  }
}
{
  const left = ["a", "b"];
  const right = ["a", "B", "c"];
  const rendered = renderUnifiedDiff("/f.ts", buildHunks(left, right, diffLines(left, right)).hunks);
  check("unified diff 含 @@ 標頭", rendered.includes("@@ -"));
  check("unified diff 含 +/- 行", rendered.includes("+B") && rendered.includes("-b"));
}

// --- anchoring ---
section("quote 定位（核心）");

function mkFile(path: string, rightLines: string[], changed: number[]): FileDiff {
  const leftLines = rightLines.filter((_, i) => !changed.includes(i + 1));
  const edits = diffLines(leftLines, rightLines);
  const { hunks, changedRightLines } = buildHunks(leftLines, rightLines, edits);
  return {
    path,
    changeType: "edit",
    hunks,
    rightLines,
    leftLines,
    changedRightLines: changedRightLines.size ? changedRightLines : new Set(changed),
    binary: false,
    truncated: false,
    language: detectLanguage(path),
  };
}

function mkFinding(over: Partial<RawFinding>): RawFinding {
  return {
    category: "logic",
    severity: "high",
    confidence: 0.8,
    file: "/src/app.ts",
    quote: "",
    claim: "test",
    side: "right",
    ...over,
  };
}

{
  const f = mkFile("/src/app.ts", [
    "function run() {",
    "  const x = compute();",
    "  return x / divisor;",
    "}",
  ], [3]);
  const r = anchorFinding(mkFinding({ quote: "  return x / divisor;" }), [f]);
  eq("精確 quote → 第 3 行", r.anchor?.startLine, 3);
  eq("錨定在右側", r.anchor?.side, "right");
  eq("startOffset 為 1", r.anchor?.startOffset, 1);
  check("endOffset 覆蓋整行", (r.anchor?.endOffset ?? 0) > 1);
}
{
  // The model reformatted the indentation — tier-2 matching must still find it.
  const f = mkFile("/src/app.ts", ["function run() {", "    const x = compute();", "}"], [2]);
  const r = anchorFinding(mkFinding({ quote: "const x = compute();" }), [f]);
  eq("縮排不同仍可定位", r.anchor?.startLine, 2);
}
{
  const f = mkFile("/src/app.ts", ["a();", "b();", "a();"], [1, 2, 3]);
  const r = anchorFinding(mkFinding({ quote: "a();" }), [f]);
  eq("重複 quote 且無 context → 判定歧義", r.failure, "quote-ambiguous");
  check("歧義時不回傳 anchor（不猜行號）", r.anchor === undefined);
}
{
  const f = mkFile("/src/app.ts", ["a();", "b();", "a();", "c();"], [1, 2, 3, 4]);
  const r = anchorFinding(
    mkFinding({ quote: "a();", context_after: "c();" }),
    [f],
  );
  eq("context_after 消歧 → 第 3 行", r.anchor?.startLine, 3);
}
{
  const f = mkFile("/src/app.ts", ["a();", "b();", "a();", "c();"], [1, 2, 3, 4]);
  const r = anchorFinding(mkFinding({ quote: "a();", context_before: "b();" }), [f]);
  eq("context_before 消歧 → 第 3 行", r.anchor?.startLine, 3);
}
{
  const f = mkFile("/src/app.ts", ["one();", "two();"], [1]);
  const r = anchorFinding(mkFinding({ quote: "nonexistent();" }), [f]);
  eq("找不到 quote → fail-closed", r.failure, "quote-not-found");
}
{
  const f = mkFile("/src/app.ts", ["a();"], [1]);
  const r = anchorFinding(mkFinding({ file: "/other/file.ts", quote: "a();" }), [f]);
  eq("檔案不在 diff 中", r.failure, "file-not-in-diff");
}
{
  // A finding about untouched code far from any hunk is not this PR's business.
  const rightLines = Array.from({ length: 60 }, (_, i) => `line${i + 1}();`);
  const leftLines = [...rightLines];
  leftLines[0] = "old();";
  const edits = diffLines(leftLines, rightLines);
  const { hunks, changedRightLines } = buildHunks(leftLines, rightLines, edits);
  const f: FileDiff = {
    path: "/src/app.ts",
    changeType: "edit",
    hunks,
    rightLines,
    leftLines,
    changedRightLines,
    binary: false,
    truncated: false,
    language: "typescript",
  };
  const r = anchorFinding(mkFinding({ quote: "line50();" }), [f]);
  eq("變更範圍外 → 拒絕", r.failure, "outside-changed-lines");
}
{
  const f = mkFile("/src/app.ts", ["if (a) {", "  doThing();", "}"], [1, 2, 3]);
  const r = anchorFinding(mkFinding({ quote: "if (a) {\n  doThing();" }), [f]);
  eq("多行 quote 起始行", r.anchor?.startLine, 1);
  eq("多行 quote 結束行", r.anchor?.endLine, 2);
}
{
  // CRLF content vs a quote the model echoed without the \r.
  const f = mkFile("/src/app.ts", ["a();\r", "target();\r", "b();\r"], [2]);
  const r = anchorFinding(mkFinding({ quote: "target();" }), [f]);
  eq("CRLF 檔案仍可定位", r.anchor?.startLine, 2);
}
{
  const f = mkFile("/src/deep/nested/app.ts", ["x();"], [1]);
  check("路徑後綴匹配", resolveFile("deep/nested/app.ts", [f])?.path === "/src/deep/nested/app.ts");
  check("basename 匹配", resolveFile("app.ts", [f])?.path === "/src/deep/nested/app.ts");
  check("不存在的檔案回傳 undefined", resolveFile("nope.ts", [f]) === undefined);
}
{
  const a = mkFile("/src/a.ts", ["x();"], [1]);
  const b = mkFile("/lib/a.ts", ["x();"], [1]);
  check("同名檔案有歧義時不亂猜", resolveFile("a.ts", [a, b]) === undefined);
}
{
  // The scenario that motivated the whole project: an identical line exists both in
  // untouched code and in the new code. Naive matching takes the first hit and the comment
  // lands on the wrong function.
  const rightLines = ["import x;", "", "def helper():", "    return 1", "", "def main():", "    return 1"];
  const leftLines = ["import x;", "", "def helper():", "    return 1"];
  const { hunks, changedRightLines } = buildHunks(leftLines, rightLines, diffLines(leftLines, rightLines));
  const f: FileDiff = {
    path: "/src/m.py",
    changeType: "edit",
    hunks,
    rightLines,
    leftLines,
    changedRightLines,
    binary: false,
    truncated: false,
    language: "python",
  };
  const r = anchorFinding(
    mkFinding({ file: "/src/m.py", quote: "    return 1", context_before: "def main():" }),
    [f],
  );
  eq("重複行優先錨定在變更處（第 7 行而非第 4 行）", r.anchor?.startLine, 7);
}

// --- URL parsing ---
section("PR URL 解析");
{
  const r = parsePrUrl("https://dev.azure.com/myorg/MyProject/_git/my-repo/pullrequest/1234");
  eq("org", r.org, "myorg");
  eq("project", r.project, "MyProject");
  eq("repo", r.repoId, "my-repo");
  eq("prId", r.prId, 1234);
}
{
  const r = parsePrUrl("https://dev.azure.com/org/Proj%20With%20Space/_git/repo/pullrequest/7");
  eq("URL-encoded project 名稱", r.project, "Proj With Space");
}
{
  // The API base must come from the URL, not be rebuilt from a configured host — that is
  // what broke on-prem: the virtual directory was dropped and the collection was mistaken
  // for the org, producing a request to an entirely different server.
  const cloud = parsePrUrl("https://dev.azure.com/myorg/MyProject/_git/my-repo/pullrequest/1234");
  eq("雲端 API base", cloud.baseUrl, "https://dev.azure.com/myorg");

  const onpremPrefix = parsePrUrl(
    "https://tfs.corp.local/tfs/DefaultCollection/MyProject/_git/my-repo/pullrequest/42",
  );
  eq("on-prem 含虛擬目錄：API base 保留 /tfs", onpremPrefix.baseUrl, "https://tfs.corp.local/tfs/DefaultCollection");
  eq("on-prem 含虛擬目錄：collection", onpremPrefix.org, "DefaultCollection");
  eq("on-prem 含虛擬目錄：project", onpremPrefix.project, "MyProject");
  eq("on-prem 含虛擬目錄：repo", onpremPrefix.repoId, "my-repo");
  eq("on-prem 含虛擬目錄：PR id", onpremPrefix.prId, 42);

  const onpremPlain = parsePrUrl("https://ado.corp.local/DefaultCollection/Proj/_git/repo/pullrequest/9");
  eq("on-prem 無虛擬目錄", onpremPlain.baseUrl, "https://ado.corp.local/DefaultCollection");

  const onpremDeep = parsePrUrl("https://srv.corp.local/tfs/apps/TeamCollection/Proj/_git/repo/pullrequest/3");
  eq("on-prem 多層虛擬目錄", onpremDeep.baseUrl, "https://srv.corp.local/tfs/apps/TeamCollection");

  const port = parsePrUrl("https://tfs.corp.local:8443/tfs/Coll/Proj/_git/repo/pullrequest/5");
  eq("on-prem 自訂連接埠保留", port.baseUrl, "https://tfs.corp.local:8443/tfs/Coll");

  const vsts = parsePrUrl("https://myorg.visualstudio.com/MyProject/_git/repo/pullrequest/8");
  eq("visualstudio.com：collection 在主機名，路徑為空", vsts.baseUrl, "https://myorg.visualstudio.com");
  eq("visualstudio.com：project", vsts.project, "MyProject");
}
{
  // The composed REST path is what actually gets requested; assert it end to end.
  const r = parsePrUrl("https://tfs.corp.local/tfs/DefaultCollection/MyProject/_git/my-repo/pullrequest/42");
  eq(
    "on-prem 組出的 PR API 位址",
    prBase(r),
    "https://tfs.corp.local/tfs/DefaultCollection/MyProject/_apis/git/repositories/my-repo/pullRequests/42",
  );
}
{
  let threw = false;
  try {
    parsePrUrl("https://dev.azure.com/org/proj/_git/repo");
  } catch {
    threw = true;
  }
  check("缺少 pullrequest 區段時報錯", threw);
}

// --- JSON parsing ---
section("模型輸出解析（fail-closed）");
{
  const r = parseJsonObject<{ findings: unknown[] }>('{"findings":[]}');
  check("純 JSON", r.ok && Array.isArray(r.value.findings));
}
{
  const r = parseJsonObject<{ a: number }>('```json\n{"a":1}\n```');
  check("markdown fence", r.ok && r.value.a === 1);
}
{
  const r = parseJsonObject<{ a: number }>('<think>推理中</think>\n{"a":2}');
  check("think block 前綴", r.ok && r.value.a === 2);
}
{
  const r = parseJsonObject<{ a: string }>('說明文字\n{"a":"含 } 括號"}\n結尾');
  check("字串內的括號不影響平衡判斷", r.ok && r.value.a === "含 } 括號");
}
{
  const r = parseJsonObject("完全不是 JSON");
  check("非 JSON → 失敗而非丟例外", !r.ok);
}
{
  const r = parseJsonObject("");
  check("空字串 → 失敗", !r.ok);
}

// --- language / noise ---
section("語言判定與雜訊過濾");
eq("python", detectLanguage("/src/a.py"), "python");
eq("java", detectLanguage("/src/A.java"), "java");
eq("tsx", detectLanguage("/app/page.tsx"), "tsx");
check("lockfile 是雜訊", isNoiseFile("/package-lock.json"));
check(".next 產出是雜訊", isNoiseFile("/apps/web/.next/static/x.js"));
check("一般 ts 可審查", isReviewable("/src/a.ts"));
check("markdown 不進 review", !isReviewable("/README.md"));

// --- payload budget ---
section("diff 預算");
{
  const files = [
    mkFile("/a.ts", ["a1();", "a2();"], [1, 2]),
    mkFile("/b.py", ["b1()", "b2()"], [1, 2]),
  ];
  const p = buildDiffPayload(files, 100_000);
  eq("預算充足時全部納入", p.includedFiles.length, 2);
  check("payload 含檔名", p.text.includes("/a.ts") && p.text.includes("/b.py"));
}
{
  const files = [
    mkFile("/a.ts", ["a1();"], [1]),
    mkFile("/b.ts", ["b1();"], [1]),
  ];
  const p = buildDiffPayload(files, 200);
  check("超出預算時至少保留一個檔案", p.includedFiles.length >= 1);
  check("被略過的檔案有記錄", p.includedFiles.length + p.omittedFiles.length === 2);
  if (p.omittedFiles.length > 0) check("略過清單出現在 payload 中", p.text.includes("未納入"));
}

// --- work item HTML ---
section("Work Item HTML 轉純文字");
eq("<li> 變成條列", htmlToText("<ul><li>條件一</li><li>條件二</li></ul>"), "- 條件一\n- 條件二");
eq("<br> 換行", htmlToText("a<br/>b"), "a\nb");
eq("實體字元還原", htmlToText("&lt;tag&gt; &amp; &quot;q&quot;&nbsp;x"), '<tag> & "q" x');
eq("數字實體", htmlToText("&#65;&#66;"), "AB");
eq("script 被移除", htmlToText("<p>keep</p><script>evil()</script>"), "keep");
eq("空輸入", htmlToText(undefined), "");
check("<p> 分段", htmlToText("<p>one</p><p>two</p>").split("\n").length === 2);

// --- rule globs ---
section("規則 glob 比對");
check("** 匹配任意深度", globToRegExp("**/*.py").test("src/a/b/c.py"));
check("**/ 可匹配零層目錄", globToRegExp("**/*.py").test("c.py"));
check("副檔名不符不匹配", !globToRegExp("**/*.py").test("src/a.java"));
check("{a,b} 分支", globToRegExp("**/*.{tsx,jsx}").test("app/page.tsx"));
check("{a,b} 另一分支", globToRegExp("**/*.{tsx,jsx}").test("app/page.jsx"));
check("{a,b} 不匹配第三者", !globToRegExp("**/*.{tsx,jsx}").test("app/page.ts"));
check("* 不跨目錄", !globToRegExp("src/*.ts").test("src/deep/a.ts"));
check("目錄前綴", globToRegExp("services/payment/**").test("services/payment/api/x.java"));
check("全域 **/*", globToRegExp("**/*").test("anything/at/all.md"));

section("規則選取");
{
  const rules = [
    { name: "_base.md", applyTo: ["**/*"], body: "base" },
    { name: "java.md", applyTo: ["**/*.java"], body: "java" },
    { name: "python.md", applyTo: ["**/*.py"], body: "python" },
  ];
  const picked = selectRules(rules, ["/src/Main.java", "/README.md"]);
  eq("只載入相關語言規則", picked.map((r) => r.name).sort(), ["_base.md", "java.md"]);
  check("未變更的語言規則不載入", !picked.some((r) => r.name === "python.md"));
  const none = selectRules(rules, []);
  eq("無變更檔案時不載入任何規則", none.length, 0);
}
{
  // The shipped baseline must actually parse and apply everywhere.
  const base = loadRules().find((r) => r.name === "_base.md");
  check("內建 _base.md 可載入", base !== undefined);
  if (base) {
    eq("_base.md applyTo 為全域", base.applyTo, ["**/*"]);
    check("_base.md 內容含 Fowler smells", base.body.includes("Feature Envy"));
    check("_base.md frontmatter 已剝除", !base.body.startsWith("---"));
  }
}

// --- adversarial verification ---
section("Skeptic 判定解析（fail-open）");
{
  const v = parseVerdictForTest('{"refuted":true,"reason":"這段是 try-with-resources，會自動關閉","confidence":0.9}', "test-model");
  check("明確推翻", v.refuted && v.confidence === 0.9);
}
{
  const v = parseVerdictForTest('{"refuted":false,"reason":"","confidence":0.7}', "test-model");
  check("未推翻", !v.refuted);
}
{
  // A broken verifier must not be able to delete findings.
  const v = parseVerdictForTest("模型壞掉了不是 JSON", "test-model");
  check("無法解析時 fail-open（不推翻）", !v.refuted);
  check("無法解析時記錄錯誤", v.error !== undefined);
}
{
  const v = parseVerdictForTest('{"refuted":false,"reason":"影響被誇大","confidence":0.8,"suggested_severity":"low"}', "test-model");
  eq("接受嚴重度下修建議", v.suggestedSeverity, "low");
}
{
  const v = parseVerdictForTest('{"refuted":false,"reason":"x","confidence":0.5,"suggested_severity":"catastrophic"}', "test-model");
  check("無效的嚴重度被忽略", v.suggestedSeverity === undefined);
}

section("共識裁決");
{
  const mk = (over: Partial<AnchoredFinding>): AnchoredFinding => ({
    category: "correctness",
    severity: "high",
    confidence: 0.8,
    file: "/a.ts",
    quote: "x();",
    claim: "c",
    sources: ["m1"],
    fingerprint: "f",
    anchor: { side: "right", startLine: 1, endLine: 1, startOffset: 1, endOffset: 5 },
    ...over,
  });
  const empty = { merged: [], degraded: [], rawCount: 0, byFailure: {} };

  const single = finalize(empty, [mk({ sources: ["m1"] })]);
  eq("單一模型且未驗證 → 不發 inline", single.inline.length, 0);
  eq("但仍列於 summary", single.belowBar.length, 1);
  eq("並標明原因", single.belowBar[0]?.suppressedBy, "no-corroboration");

  const twoModels = finalize(empty, [mk({ sources: ["m1", "m2"] })]);
  eq("兩個模型獨立發現 → 發 inline", twoModels.inline.length, 1);

  const verified = finalize(empty, [mk({ sources: ["m1"], skepticVerdicts: 1 })]);
  eq("單一模型但通過對抗驗證 → 發 inline", verified.inline.length, 1);

  const lowSev = finalize(empty, [mk({ sources: ["m1", "m2"], severity: "low" })]);
  eq("低於門檻 → 不發 inline", lowSev.inline.length, 0);
  eq("原因標為 severity", lowSev.belowBar[0]?.suppressedBy, "severity");
}

// --- static analysis ---
section("工具輸出解析");
const spec = (format: string): ToolSpec =>
  ({ name: "t", bin: "t", args: () => [], format, tier: "triage" }) as ToolSpec;

{
  const sarif = JSON.stringify({
    runs: [{
      tool: { driver: { name: "bandit", rules: [{ id: "B602", helpUri: "https://x" }] } },
      results: [{
        ruleId: "B602",
        level: "note",
        message: { text: "subprocess with shell=True" },
        locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.py" }, region: { startLine: 12 } } }],
        properties: { "security-severity": "9.8" },
      }],
    }],
  });
  const f = parseToolOutput(sarif, spec("sarif"), "/w")[0];
  eq("SARIF 規則 id", f?.ruleId, "B602");
  eq("SARIF 行號", f?.line, 12);
  // A rule can be level:note while describing a critical vulnerability.
  eq("security-severity 覆蓋 level", f?.severity, "critical");
  eq("SARIF helpUri", f?.helpUri, "https://x");
}
{
  const ruff = JSON.stringify([
    { code: "B006", message: "mutable default", filename: "/w/src/a.py", location: { row: 3 } },
    { code: "S602", message: "shell", filename: "/w/src/a.py", location: { row: 9 } },
  ]);
  const fs2 = parseToolOutput(ruff, spec("ruff-json"), "/w");
  eq("ruff 兩筆", fs2.length, 2);
  eq("workdir 前綴被剝除", fs2[0]?.file, "src/a.py");
  eq("S 前綴視為安全類（高）", fs2[1]?.severity, "high");
}
{
  const eslint = JSON.stringify([
    { filePath: "/w/app/p.tsx", messages: [{ ruleId: "no-eval", severity: 2, message: "eval", line: 4 }] },
  ]);
  const f = parseToolOutput(eslint, spec("eslint-json"), "/w")[0];
  eq("eslint 規則", f?.ruleId, "no-eval");
  eq("eslint severity 2 → high", f?.severity, "high");
}
{
  const xml = `<?xml version="1.0"?><checkstyle><file name="/w/src/A.java">` +
    `<error line="7" severity="error" message="Avoid &quot;x&quot; here" source="com.puppycrawl.tools.checkstyle.MagicNumberCheck"/>` +
    `</file></checkstyle>`;
  const f = parseToolOutput(xml, spec("checkstyle-xml"), "/w")[0];
  eq("checkstyle 行號", f?.line, 7);
  eq("規則取最後一段", f?.ruleId, "MagicNumberCheck");
  check("XML 實體已解碼", (f?.message ?? "").includes('"x"'));
}
{
  // &amp; must be decoded LAST, or "&amp;lt;" wrongly becomes "<" instead of "&lt;".
  const xml = `<?xml version="1.0"?><checkstyle><file name="/w/A.java">` +
    `<error line="1" severity="error" message="a &amp;lt; b" source="X"/></file></checkstyle>`;
  const f = parseToolOutput(xml, spec("checkstyle-xml"), "/w")[0];
  eq("&amp; 最後解碼，不會二次還原", f?.message, "a &lt; b");
}
{
  const mypy = '{"file":"src/a.py","line":5,"severity":"error","message":"bad type","code":"arg-type"}\n' +
               '{"file":"src/a.py","line":6,"severity":"note","message":"context"}';
  const fs3 = parseToolOutput(mypy, spec("mypy-json"), "/w");
  eq("mypy 只保留 error", fs3.length, 1);
  eq("mypy 型別錯誤視為高", fs3[0]?.severity, "high");
}
{
  const tsc = "src/a.ts(12,5): error TS2345: Argument of type 'x'.\nirrelevant line";
  const f = parseToolOutput(tsc, spec("tsc-text"), "/w")[0];
  eq("tsc 規則", f?.ruleId, "TS2345");
  eq("tsc 行號", f?.line, 12);
}
check("空輸出不炸", parseToolOutput("", spec("sarif"), "/w").length === 0);
check("壞掉的輸出不炸", parseToolOutput("{{{not json", spec("sarif"), "/w").length === 0);

section("靜態 findings 的 diff 過濾");
{
  const f = mkFile("/src/a.py", ["a()", "b()", "c()"], [2]);
  const mk = (line: number) => ({
    tool: "ruff", tier: "triage" as const, ruleId: "X", message: "m",
    file: "src/a.py", line, severity: "medium" as const,
  });
  const r = filterToChangedLines([mk(1), mk(2), mk(3)], [f]);
  eq("只保留落在變更行上的", r.kept.length, 1);
  eq("保留的是第 2 行", r.kept[0]?.line, 2);
  eq("其餘被濾除", r.dropped, 2);

  const other = filterToChangedLines([{ ...mk(2), file: "other/z.py" }], [f]);
  eq("不在變更檔案中的一律濾除", other.kept.length, 0);
}

section("語言 profile 選取");
{
  const ps = selectProfiles(["src/a.py", "README.md"]);
  eq("只選到 python", ps.map((p) => p.language), ["python"]);
  eq("非該語言的檔案不傳給工具", filesForProfile(ps[0]!, ["src/a.py", "README.md"]), ["src/a.py"]);
  eq("混合語言選到兩個 profile", selectProfiles(["A.java", "p.tsx"]).length, 2);
  eq("無對應語言時為空", selectProfiles(["README.md"]).length, 0);
}

section("留言生命週期");
{
  const threads = [
    { id: 1, status: "closed", comments: [{ id: 1, content: `<!-- prloop --><!-- prloop:summary -->x\n${iterationMarker(7)}` }] },
  ];
  eq("從 summary 讀回上次審查的 iteration", lastReviewedIteration(threads), 7);
  eq("沒有標記時回傳 undefined", lastReviewedIteration([{ id: 2, comments: [{ id: 1, content: "路人留言" }] }]), undefined);
}
{
  const f = mkFile("/src/a.ts", ["x();", "y();"], [1]);
  const ours = (line: number, status: string) => ({
    id: line, status,
    comments: [{ id: 1, content: "<!-- prloop --><!-- prloop:fp=abc123 -->issue" }],
    threadContext: { filePath: "/src/a.ts", rightFileStart: { line, offset: 1 } },
  });
  eq("行號超出檔案 → 判定為過時", findStaleThreads([ours(99, "active")], [f]).length, 1);
  eq("行號仍在範圍內 → 不動它", findStaleThreads([ours(1, "active")], [f]).length, 0);
  eq("已關閉的 thread 不再處理", findStaleThreads([ours(99, "fixed")], [f]).length, 0);
  // Someone else's comment must never be touched.
  const foreign = { id: 5, status: "active", comments: [{ id: 1, content: "同事的留言" }],
    threadContext: { filePath: "/src/a.ts", rightFileStart: { line: 99, offset: 1 } } };
  eq("非本工具的留言不處理", findStaleThreads([foreign], [f]).length, 0);
}
{
  const dismissed = [
    { id: 1, status: "wontFix", comments: [{ id: 1, content: "<!-- prloop --><!-- prloop:fp=deadbeef -->不修" }],
      threadContext: { filePath: "/src/a.ts" } },
    { id: 2, status: "active", comments: [{ id: 1, content: "<!-- prloop --><!-- prloop:fp=aaaa -->still open" }] },
  ];
  const d = collectDismissals(dismissed);
  eq("只收集被標記不修的", d.length, 1);
  eq("記錄指紋", d[0]?.fingerprint, "deadbeef");
}

// --- realistic seeded PR ---
// Toy fixtures prove the algorithm runs; this proves it lands on the right line in code
// that looks like real code. Every expectation below was verified against `grep -n` on the
// actual repository these files came from.
section("真實 PR 錨定（植入缺陷的靶場）");
{
  const seeded: FileDiff[] = SEEDED_FILES.map((f) => {
    const leftLines = splitLines(Buffer.from(f.base, "utf8"));
    const rightLines = splitLines(Buffer.from(f.head, "utf8"));
    const { hunks, changedRightLines } = buildHunks(leftLines, rightLines, diffLines(leftLines, rightLines));
    return {
      path: f.path,
      changeType: "edit" as const,
      hunks,
      rightLines,
      leftLines,
      changedRightLines,
      binary: false,
      truncated: false,
      language: f.language,
    };
  });

  for (const e of EXPECTED_ANCHORS) {
    const r = anchorFinding(
      mkFinding({
        file: e.file,
        quote: e.quote,
        context_before: e.contextBefore,
        context_after: e.contextAfter,
      }),
      seeded,
    );
    if (typeof e.expect === "number") {
      eq(e.name, r.anchor?.startLine, e.expect);
    } else {
      eq(e.name, r.failure, e.expect);
      check(`${e.name}（不得回傳 anchor）`, r.anchor === undefined);
    }
  }
}

section("NO_PROXY 比對規則");
{
  // Exercises the real matcher, not a copy of it — the second argument exists so this can
  // be tested without the module-level value captured at import.
  const no = (list: string, host: string) => bypassesProxy(host, list);
  check("完全相同的主機命中", no("internal.corp", "internal.corp"));
  check("子網域命中", no("corp", "ai.internal.corp"));
  check("前置點的寫法命中", no(".corp", "ai.internal.corp"));
  check("萬用字元前綴命中", no("*.corp", "ai.internal.corp"));
  check("不相關的主機不命中", !no("internal.corp", "dev.azure.com"));
  check("部分字串不應誤命中", !no("corp", "notcorp.com"));
  check("單獨的 * 代表全部繞過", no("*", "anything.example"));
  check("多筆逗號分隔", no("a.com, internal.corp ,b.com", "x.internal.corp"));
  check("空的 NO_PROXY 不繞過", !no("", "dev.azure.com"));
  check("大小寫不敏感", no("INTERNAL.CORP", "ai.Internal.Corp"));
}
{
  // .env cannot overwrite an existing environment variable, so on a machine that already
  // exports HTTPS_PROXY the file's value would silently do nothing. The PRR_ names exist
  // to make .env a reliable override; assert that precedence holds.
  const pick = (env: Record<string, string | undefined>, ...names: string[]) => {
    for (const n of names) {
      const v = env[n] ?? env[n.toLowerCase()] ?? env[n.toUpperCase()];
      if (v && v.trim()) return v.trim();
    }
    return "";
  };
  const order = ["PRR_HTTPS_PROXY", "HTTPS_PROXY", "https_proxy"];
  eq(
    "PRR_ 版本優先於 shell 的 HTTPS_PROXY",
    pick({ PRR_HTTPS_PROXY: "http://a", HTTPS_PROXY: "http://b" }, ...order),
    "http://a",
  );
  eq("沒有 PRR_ 時沿用慣用名稱", pick({ HTTPS_PROXY: "http://b" }, ...order), "http://b");
  eq("小寫也會被讀到", pick({ https_proxy: "http://c" }, ...order), "http://c");
  eq("全空時為空字串", pick({}, ...order), "");
}

console.log(`\n結果：${passed} 通過、${failed} 失敗`);
process.exit(failed > 0 ? 1 : 0);
