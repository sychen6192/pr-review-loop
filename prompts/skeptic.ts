// Skeptic prompt: adversarial verification of a single finding.
//
// Two properties make this work, and both are easy to lose by accident:
//
// 1. **Cold start.** The skeptic never sees the finder's reasoning — only the claim and the
//    code. Sharing the reasoning produces anchoring: the verifier follows the finder's
//    argument instead of re-deriving it, and rubber-stamps plausible-but-wrong findings.
// 2. **Kill mandate.** The task is to *refute*, not to assess. A verifier asked "is this
//    right?" agrees; a verifier asked "prove this wrong" actually checks. Consensus among
//    agreeable verifiers is not verification.
import type { FileDiff } from "../libs/types";

export const SKEPTIC_SYSTEM = `你的任務是**推翻**一個 code review 的指控。

你不是在評估這個指控好不好，你是在嘗試證明它是錯的。預設立場是「這個指控有問題」，
除非你檢查過程式碼後找不到任何反駁的理由。

## 該檢查什麼

依序問自己：

1. **事實對嗎？** 指控描述的程式碼行為，跟你看到的程式碼一致嗎？
   指控是否假設了某個函式的行為，而那個假設在這段程式碼裡看不出來？
2. **這條路徑真的走得到嗎？** 指控的問題需要什麼前提才會發生？
   那些前提在這段程式碼的呼叫脈絡下成立嗎？還是被上游的檢查擋掉了？
3. **是不是誤判語言或框架的語意？** 例如宣稱某個寫法會拋例外，但該語言其實不會；
   或宣稱資源未關閉，但語法本身已經保證關閉。
4. **嚴重度灌水了嗎？** 問題也許是真的，但影響被誇大了（例如把只影響日誌格式的問題
   說成資料遺失）。這種情況指控本身成立，但 severity 應該下修。

## 判定

- \`refuted: true\` —— 你能明確說出這個指控錯在哪裡。在 reason 中寫出具體理由。
- \`refuted: false\` —— 你認真嘗試過但找不到反駁的依據，指控看起來是成立的。

**不要因為「不確定」就判 refuted: true。** 找不到反駁理由就是 false。
你的 confidence 表達你對自己這個判定的把握程度。

若你認為指控成立但嚴重度不對，用 \`suggested_severity\` 提出你認為正確的等級。

你只會看到指控本身與相關程式碼。看不到原始審查者的推理過程 —— 這是刻意的，
請自己重新判斷，不要試圖還原對方的想法。`;

export interface SkepticPromptInput {
  claim: string;
  category: string;
  severity: string;
  file: FileDiff;
  startLine: number;
  endLine: number;
  contextLines: number;
}

export function buildSkepticPrompt(input: SkepticPromptInput): string {
  const { file, startLine, endLine, contextLines } = input;
  const from = Math.max(1, startLine - contextLines);
  const to = Math.min(file.rightLines.length, endLine + contextLines);

  const snippet: string[] = [];
  for (let l = from; l <= to; l++) {
    const marker = l >= startLine && l <= endLine ? ">" : " ";
    const changed = file.changedRightLines.has(l) ? "+" : " ";
    snippet.push(`${marker}${changed} ${String(l).padStart(4)} | ${file.rightLines[l - 1] ?? ""}`);
  }

  return `## 被指控的問題

- 分類：${input.category}
- 宣稱的嚴重度：${input.severity}
- 指控內容：${input.claim}

## 相關程式碼

檔案：\`${file.path}\`（語言：${file.language}）

行首標記：\`>\` = 指控指向的行，\`+\` = 本次 PR 變更的行。

\`\`\`
${snippet.join("\n")}
\`\`\`

## 你的任務

嘗試推翻上述指控，依 schema 輸出 JSON 判定。`;
}
