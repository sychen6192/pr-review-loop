// Triage prompt: an LLM judging whether a high-false-positive tool finding is real.
//
// This is the best-evidenced hybrid pattern in the research — Semgrep 560 false positives
// down to 64, CodeQL's false-discovery rate improved by triaging alerts in context. The
// tool supplies recall (it never forgets a pattern); the model supplies the context the
// pattern matcher can't see: whether the tainted value is actually attacker-controlled,
// whether an earlier guard makes the path unreachable, whether the API is used correctly.
//
// Note the asymmetry with the skeptic: there the default is "refute", here the default is
// "drop". A tool finding nobody can justify is noise, and noise is what gets bots muted.
import type { FileDiff } from "../libs/types";

export const TRIAGE_SYSTEM = `你在判斷靜態分析工具回報的問題是否值得讓開發者看到。

這些工具（bandit、SpotBugs、PMD、eslint 等）以規則比對運作：它們看得到模式，
看不到脈絡。因此誤報率高。你的工作是補上脈絡判斷。

## 判定標準

對每一筆，判斷它是否為 **真實且值得回報** 的問題：

- \`keep: true\` —— 在這段程式碼的實際脈絡下，這個問題會造成真正的影響。
- \`keep: false\` —— 屬於下列任一情形：
  - 觸發路徑實際上走不到（有前置檢查、型別限制、或呼叫端保證）
  - 資料來源不受外部控制（寫死的常數、內部設定、測試資料）
  - 規則誤判了語言或框架的語意
  - 純風格或慣例偏好，對正確性與安全性沒有影響
  - 在這個檔案的用途下是慣例做法（例如測試檔中的 assert、腳本中的 subprocess）

## 嚴重度

工具給的嚴重度通常沒有脈絡。請依實際影響重新給：

- critical：資料遺失、可被利用的安全漏洞、服務中斷
- high：功能會壞且無繞過方式
- medium：功能會壞但有繞過方式，或只在特定路徑出錯
- low：其他

## 重要

- 保守判斷。**不確定就 keep: false。** 誤報的代價是開發者不再閱讀留言，
  這比漏掉一筆低嚴重度的問題嚴重得多。
- reason 要具體說明你的判斷依據，不要重複工具的訊息。
- 只判斷給你的這些筆，不要自行新增問題。`;

export interface TriageItem {
  index: number;
  tool: string;
  ruleId: string;
  message: string;
  file: string;
  line: number;
  severity: string;
}

export function buildTriagePrompt(items: TriageItem[], files: FileDiff[], contextLines: number): string {
  const byPath = new Map<string, FileDiff>();
  for (const f of files) byPath.set(f.path.replace(/^\/+/, ""), f);

  const blocks = items.map((it) => {
    const fd = byPath.get(it.file.replace(/^\/+/, ""));
    let snippet = "（找不到對應的檔案內容）";
    if (fd) {
      const from = Math.max(1, it.line - contextLines);
      const to = Math.min(fd.rightLines.length, it.line + contextLines);
      const lines: string[] = [];
      for (let l = from; l <= to; l++) {
        const marker = l === it.line ? ">" : " ";
        const changed = fd.changedRightLines.has(l) ? "+" : " ";
        lines.push(`${marker}${changed} ${String(l).padStart(4)} | ${fd.rightLines[l - 1] ?? ""}`);
      }
      snippet = lines.join("\n");
    }
    return `### [${it.index}] ${it.tool} ${it.ruleId}

- 檔案：\`${it.file}\`:${it.line}
- 工具訊息：${it.message}
- 工具給的嚴重度：${it.severity}

\`\`\`
${snippet}
\`\`\``;
  });

  return `## 待判定的工具回報（共 ${items.length} 筆）

行首標記：\`>\` = 工具指向的行，\`+\` = 本次 PR 變更的行。

${blocks.join("\n\n")}

## 你的輸出

依 schema 輸出 JSON。results 陣列中每一筆的 index 必須對應上方的編號，全部都要給判定。`;
}
