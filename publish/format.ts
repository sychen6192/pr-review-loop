// Comment rendering. Every comment carries hidden markers so re-runs can recognise their
// own threads: the bot marker identifies authorship, the fingerprint identifies the issue.
import { BOT_MARKER, MAX_INLINE_COMMENTS, MIN_INLINE_SEVERITY } from "../config";
import type { AnchoredFinding, ReqVerdict, RequirementResult } from "../libs/types";
import type { AggregateResult } from "../gates/aggregate";
import type { ReviewContext } from "../ado/intake";

export const SUMMARY_MARKER = "<!-- prloop:summary -->";
export const fpMarker = (fp: string) => `<!-- prloop:fp=${fp} -->`;

const SEVERITY_LABEL: Record<string, string> = {
  critical: "🔴 Critical",
  high: "🟠 High",
  medium: "🟡 Medium",
  low: "⚪ Low",
};

const CATEGORY_LABEL: Record<string, string> = {
  correctness: "🎯 正確性",
  concurrency: "🔀 併發",
  security: "🔒 安全",
  reliability: "🩺 穩定性",
  "data-integrity": "🗄️ 資料完整性",
  performance: "🚀 效能",
  maintainability: "📐 可維護性",
  "leftover-code": "🧹 殘留程式碼",
  "req-mismatch": "📋 需求未滿足",
};

const FAILURE_LABEL: Record<string, string> = {
  "quote-not-found": "引用的程式碼在檔案中找不到",
  "quote-ambiguous": "引用的程式碼出現多次，無法確定位置",
  "file-not-in-diff": "檔案不在本次變更中",
  "outside-changed-lines": "位置落在本次變更範圍之外",
};

// ADO's markdown renderer drops the disclosure widget if the <summary> tag spans more than
// one line, so the whole opening tag has to be emitted as a single string.
const detailsOpen = (title: string) => `<details><summary>${title}</summary>`;

export function renderFindingComment(f: AnchoredFinding): string {
  const parts: string[] = [
    `${BOT_MARKER}${fpMarker(f.fingerprint)}`,
    `**${SEVERITY_LABEL[f.severity] ?? f.severity}** · ${CATEGORY_LABEL[f.category] ?? f.category}`,
    "",
    f.claim,
  ];
  if (f.evidence) parts.push("", f.evidence);
  if (f.suggested_fix) {
    parts.push("", "**建議修正**", "", "```", f.suggested_fix.trim(), "```");
  }
  const conf = Math.round(f.confidence * 100);
  const src = f.sources.length > 1 ? `${f.sources.length} 個模型獨立發現` : f.sources[0] ?? "";
  parts.push("", `<sub>信心 ${conf}%｜${src}</sub>`);
  return parts.join("\n");
}

export interface SummaryInput {
  ctx: ReviewContext;
  agg: AggregateResult;
  req?: RequirementResult;
  finderErrors: Array<{ model: string; error: string }>;
  omittedFiles: string[];
  appliedRules: string[];
  durationSec: number;
  runDir: string;
}

const REQ_LABEL: Record<ReqVerdict, string> = {
  satisfied: "✅ 已滿足",
  missing: "❌ 未實作",
  partial: "⚠️ 部分完成",
  misunderstood: "🔄 方向錯誤",
  "not-verifiable": "❓ 無法從程式碼判定",
};

// The requirement axis gets its own block above the code axis, with its own verdict.
// Deliberately not merged into the findings table: a shared ranking lets code findings
// bury "this requirement was never implemented" (PROPOSAL §6.1).
function renderRequirementSection(req: RequirementResult | undefined): string[] {
  const lines: string[] = ["### 📋 需求檢查", ""];

  if (!req || req.skipped) {
    lines.push(`_${req?.skipped ?? "未執行"}_`, "");
    return lines;
  }
  if (req.error) {
    lines.push(`_需求檢查未能完成：${req.error}_`, "");
    return lines;
  }
  if (req.criteria.length === 0) {
    lines.push("_沒有可比對的 acceptance criteria_", "");
    return lines;
  }

  const unmet = req.criteria.filter(
    (c) => c.verdict === "missing" || c.verdict === "partial" || c.verdict === "misunderstood",
  );
  const wiList = req.workItems.map((w) => `#${w.id}`).join("、");
  lines.push(
    unmet.length === 0
      ? `✅ **${wiList} 的 ${req.criteria.length} 條驗收條件都有對應的實作。**`
      : `⚠️ **${wiList} 有 ${unmet.length}/${req.criteria.length} 條驗收條件尚未滿足。**`,
    "",
    "| 狀態 | 驗收條件 | 說明 |",
    "| --- | --- | --- |",
  );
  for (const c of req.criteria) {
    const loc = c.file ? ` (\`${c.file}\`)` : "";
    lines.push(
      `| ${REQ_LABEL[c.verdict]} | ${escapeCell(c.criterion)} | ${escapeCell(c.note)}${loc} |`,
    );
  }
  lines.push("");

  if (req.extras.length > 0) {
    lines.push(
      detailsOpen(`需求之外的變更（${req.extras.length}）—— 不一定是問題，但值得確認是否有意為之`),
      "",
    );
    for (const e of req.extras) lines.push(`- \`${e.file}\` — ${e.claim}`);
    lines.push("", "</details>", "");
  }
  return lines;
}

export function renderSummary(input: SummaryInput): string {
  const { ctx, agg } = input;
  const lines: string[] = [
    `${BOT_MARKER}${SUMMARY_MARKER}`,
    `## 🔍 prloop 自動審查`,
    "",
  ];

  const scope =
    ctx.compareTo > 0
      ? `iteration ${ctx.compareTo} → ${ctx.iteration.id}（增量）`
      : `iteration ${ctx.iteration.id}（完整 PR）`;
  lines.push(
    `審查範圍：${scope}｜變更檔案 ${ctx.files.length} 個｜耗時 ${input.durationSec}s`,
    "",
  );

  lines.push(...renderRequirementSection(input.req));

  lines.push("### 🔍 程式碼檢查", "");

  // The no-comment path is a feature: silence on a clean PR is what makes the noisy runs
  // worth reading.
  if (agg.inline.length === 0 && agg.belowBar.length === 0 && agg.degraded.length === 0) {
    lines.push("✅ **未發現需要處理的問題。**", "");
  } else if (agg.inline.length === 0) {
    lines.push("✅ **未發現達到回報門檻的問題。**", "");
  } else {
    lines.push(`發現 **${agg.inline.length}** 個需要注意的問題，已在對應程式碼行留言。`, "");
    const bySeverity = new Map<string, number>();
    for (const f of agg.inline) bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);
    const order = ["critical", "high", "medium", "low"];
    const counts = order
      .filter((s) => bySeverity.has(s))
      .map((s) => `${SEVERITY_LABEL[s]} ${bySeverity.get(s)}`)
      .join("｜");
    if (counts) lines.push(counts, "");
    lines.push("| 嚴重度 | 檔案 | 問題 |", "| --- | --- | --- |");
    for (const f of agg.inline) {
      const loc = f.anchor ? `${f.file}:${f.anchor.startLine}` : f.file;
      lines.push(`| ${SEVERITY_LABEL[f.severity] ?? f.severity} | \`${loc}\` | ${escapeCell(f.claim)} |`);
    }
    lines.push("");
  }

  if (agg.belowBar.length > 0) {
    lines.push(
      detailsOpen(
        `未留言的其他 findings（${agg.belowBar.length}）—— 低於 ${MIN_INLINE_SEVERITY} 門檻或超過每次 ${MAX_INLINE_COMMENTS} 則上限`,
      ),
      "",
    );
    for (const f of agg.belowBar) {
      const loc = f.anchor ? `${f.file}:${f.anchor.startLine}` : f.file;
      lines.push(`- **${f.severity}** \`${loc}\` — ${f.claim}`);
    }
    lines.push("", "</details>", "");
  }

  // Degraded findings are surfaced rather than dropped, but never posted inline: the whole
  // point is that we don't guess a line when the quote didn't locate.
  if (agg.degraded.length > 0) {
    lines.push(
      detailsOpen(`無法定位到具體行號的 findings（${agg.degraded.length}）—— 已避免貼到錯誤的行`),
      "",
    );
    for (const f of agg.degraded) {
      const why = FAILURE_LABEL[f.anchorFailure ?? ""] ?? f.anchorFailure ?? "未知原因";
      lines.push(`- **${f.severity}** \`${f.file}\` — ${f.claim}`, `  <sub>${why}</sub>`);
    }
    lines.push("", "</details>", "");
  }

  const notes: string[] = [];
  if (input.omittedFiles.length > 0) {
    notes.push(`因 diff 篇幅限制，${input.omittedFiles.length} 個檔案未納入本次分析：${input.omittedFiles.slice(0, 10).join("、")}${input.omittedFiles.length > 10 ? " 等" : ""}`);
  }
  if (ctx.skipped.length > 0) {
    notes.push(`略過 ${ctx.skipped.length} 個非程式碼/產生檔案`);
  }
  if (input.appliedRules.length > 0) {
    notes.push(`套用的審查規則：${input.appliedRules.join("、")}`);
  }
  for (const e of input.finderErrors) {
    notes.push(`模型 ${e.model} 本次未產出結果：${e.error}`);
  }
  if (agg.stats.raw > 0) {
    notes.push(
      `原始 findings ${agg.stats.raw} → 去重 ${agg.stats.afterDedupe} → 成功定位 ${agg.stats.anchored}`,
    );
  }
  if (notes.length > 0) {
    lines.push(detailsOpen("本次執行說明"), "");
    for (const n of notes) lines.push(`- ${n}`);
    lines.push("", "</details>", "");
  }

  lines.push(`<sub>prloop · 每次推送後會更新這則留言</sub>`);
  return lines.join("\n");
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}
