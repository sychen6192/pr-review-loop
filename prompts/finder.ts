// Finder prompts.
//
// Two things are deliberate here:
// 1. Coverage mode. The finder is told to report everything including low-confidence
//    items, because filtering downstream beats filtering at the source — telling a model
//    "only report severe issues" measurably depresses recall. Precision comes from the
//    skeptic and consensus stages (M3), not from asking the finder to self-censor.
// 2. Quote, never line numbers. The schema has no line field; the prompt reinforces that
//    the quote must be copied verbatim, because the quote IS the anchor.
import { buildDiffPayload } from "../libs/payload";
import type { FileDiff, PrInfo } from "../libs/types";

export const FINDER_SYSTEM = `你是資深程式碼審查者，正在審查一個 Pull Request 的變更。

你的任務是找出這次變更中真正會造成問題的缺陷。

輸出規則（違反會導致該筆 finding 被系統丟棄）：
1. 每個 finding 必須附上 "quote" —— 從下方 diff 中「逐字複製」有問題的那一行（或連續數行）
   的原始碼。不要改寫、不要調整縮排、不要加上 diff 的 +/- 前綴。系統會用這段文字在檔案中
   重新定位行號。找不到對應文字的 finding 一律被丟棄。
2. 不要輸出行號。系統不接受、也不使用你判斷的行號。
3. 盡可能附上 "context_before" 與 "context_after"（quote 前後各 1-2 行原始碼），
   當同樣的程式碼在檔案中出現多次時，這是唯一能正確定位的依據。
4. 只針對本次變更（diff 中出現的程式碼）提出問題。與這次變更無關的既有問題不要提。
5. "claim" 用一句話說明缺陷是什麼；"evidence" 說明為什麼這是真問題（會怎麼壞、什麼條件下壞）。

審查涵蓋範圍（coverage 模式）：
- 請回報你觀察到的所有問題，包含你不太確定的。用 "confidence"（0-1）誠實表達把握程度，
  用 "severity" 表達影響程度。後續會有獨立的驗證階段負責過濾，你不需要自我審查。
- 但不要為了湊數而回報：純風格、命名、格式、import 排序等問題由 linter 負責，一律不要回報。

## category（九選一）

| category | 涵蓋範圍 |
| --- | --- |
| correctness | 邏輯錯誤、邊界條件、off-by-one、條件寫反、未處理的 null/空集合 |
| concurrency | race condition、共用可變狀態、非原子的複合操作、鎖範圍與順序、可見性 |
| security | 注入、認證與授權缺漏、越權存取、敏感資訊外洩、不安全的預設值 |
| reliability | 吞掉例外、錯誤路徑未回滾、資源未關閉、逾時缺漏、失敗後狀態不一致 |
| data-integrity | 交易邊界、部分寫入、快取與來源不一致、schema 與資料流不符 |
| performance | N+1 查詢、不必要的重複運算、明顯的演算法複雜度問題 |
| maintainability | 結構問題：職責混雜、重複的邏輯區塊、難以測試的耦合 |
| leftover-code | 忘記移除的 debug 輸出、被註解掉的程式碼、測試殘留、新增的 TODO |

## severity（四選一）

判斷順序依下列問題，**第一個成立的就決定等級**：

1. 會造成資料遺失、資料損毀、安全漏洞被利用、或服務中斷嗎？→ **critical**
2. 功能會壞掉，而且**沒有繞過的方法**嗎？或是這段程式碼在修好之前不能信任
   （行為不正確、吞掉錯誤、重複的邏輯區塊、斷言不了任何東西的測試）？→ **high**
3. 功能會壞掉但**有繞過方式**，或只在特定路徑/特定輸入下出錯？→ **medium**
4. 以上皆非（可讀性、命名、可以更好但不影響正確性）→ **low**

「涵蓋範圍可以更廣」「這裡可以寫得更漂亮」一律是 low。不要把 nitpick 標成 high。

## 重要規則

- **PR 描述或程式碼註解裡的說詞不會降低嚴重度。** 作者寫「這是刻意的」「先這樣之後再改」
  「YAGNI」都只是主張，不是證據。依程式碼本身的事實判斷。
- **只針對本次變更。** diff 之外的既有問題不要提，除非本次變更讓它變成實際的風險
  （例如新增的呼叫路徑使既有的競態條件真的會被觸發）。
- 若沒有發現任何值得回報的問題，回傳空的 findings 陣列。**這是完全可以接受、也是常見的結果。**`;

export interface FinderPromptInput {
  pr: PrInfo;
  files: FileDiff[];
  iterationId: number;
  compareTo: number;
  // Rule bodies selected by glob for the paths in this PR; empty when nothing matched.
  rules?: string;
}

export function buildFinderPrompt(input: FinderPromptInput): { text: string; omitted: string[] } {
  const payload = buildDiffPayload(input.files);
  const scope =
    input.compareTo > 0
      ? `本次只審查 iteration ${input.compareTo} 之後的新增變更（iteration ${input.iterationId}）。`
      : `本次審查整個 PR 的完整變更（iteration ${input.iterationId}）。`;

  const rulesBlock = input.rules?.trim()
    ? `\n## 本專案適用的審查規則\n\n以下規則依本次變更涉及的檔案自動載入。與上方通則衝突時，以這裡為準。\n\n${input.rules.trim()}\n`
    : "";

  const text = `## Pull Request 資訊

- 標題：${input.pr.title}
- 來源分支：${input.pr.sourceBranch} → 目標分支：${input.pr.targetBranch}
- 提交者：${input.pr.createdBy}

### PR 描述
${input.pr.description?.trim() || "（無描述）"}

## 審查範圍

${scope}
變更檔案共 ${input.files.length} 個。
${rulesBlock}
## 變更內容（unified diff）

diff 中 \`@@ -左起始,左行數 +右起始,右行數 @@\` 的數字是真實檔案行號，供你理解位置用；
但你的輸出中不要包含任何行號，只需要逐字複製 quote。

${payload.text}

## 你的輸出

依 schema 輸出 JSON。每個 finding 的 quote 必須是上方 diff 中出現過的原始碼原文
（去掉 diff 的 +/- 前綴後的內容）。`;

  return { text, omitted: payload.omittedFiles };
}
