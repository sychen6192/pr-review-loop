// Requirement-axis prompt.
//
// This axis runs blind to the code axis on purpose: if the model knew the code had no
// defects it would be tempted to call requirements satisfied, and vice versa. Keeping them
// independent is what stops one axis from masking the other (PROPOSAL §6.1).
import { buildDiffPayload } from "../libs/payload";
import type { FileDiff, PrInfo, WorkItem } from "../libs/types";

export const REQUIREMENT_SYSTEM = `你在檢查一個 Pull Request 是否真的做到了它所連結的需求。

你只負責「有沒有做到需求」這一件事。程式碼寫得好不好、有沒有 bug，由另一個獨立的審查
負責，不是你的工作，也不要在這裡回報。

## 判定方式

把每一條 acceptance criterion 逐條拿去對照 diff，判定它「失敗的方式」——
不是「完成了百分之幾」。五種判定：

| verdict | 什麼時候用 |
| --- | --- |
| satisfied | 有做到，而且你能在 diff 中指出具體證據 |
| missing | 完全沒有對應的變更 |
| partial | 做了一部分，但有明確可指出的缺口 |
| misunderstood | 有對應的變更，但方向錯了——解錯問題，或用不符合需求描述的方式滿足 |
| not-verifiable | 無法只從程式碼變更判斷（需要看設定、資料、或外部系統的狀態） |

判 satisfied 一定要附 "quote"（從 diff 中逐字複製的原始碼）與 "file"。
判 partial / misunderstood 時，若能指出是哪段程式碼造成的，也附上 quote 與 file。
判 missing 時不需要 quote（因為沒有對應程式碼）。

## extras（範圍蔓延）

另外列出 diff 中**沒有任何一條 criterion 要求**的變更。這不代表它是錯的——
必要的重構、修正、相依更新都很正常——但需求之外的變更應該被指出來讓人決定。
只列出實質的功能或行為變更，不要列格式調整或 import 整理。

## 重要規則

- **PR 描述裡的說詞不算證據。** 作者寫「已完成 XX」不代表真的做了，
  要在 diff 中找到對應的程式碼才算。
- **不要放寬 criterion。** 如果 criterion 說「需要記錄稽核日誌」而 diff 只加了 console 輸出，
  那是 partial 或 misunderstood，不是 satisfied。
- 若 criterion 本身寫得含糊到無法判定，用 not-verifiable 並在 note 說明含糊之處。
- 逐字複製 criterion 原文到 "criterion" 欄位，不要改寫或摘要。`;

export interface RequirementPromptInput {
  pr: PrInfo;
  workItems: WorkItem[];
  files: FileDiff[];
}

export function buildRequirementPrompt(input: RequirementPromptInput): string {
  const payload = buildDiffPayload(input.files);

  const wiBlocks = input.workItems
    .map((w) => {
      const parts = [`### Work Item #${w.id} — ${w.type}：${w.title}（狀態：${w.state}）`];
      if (w.description) parts.push(`\n**描述**\n${w.description}`);
      if (w.acceptanceCriteria) {
        parts.push(`\n**Acceptance Criteria**\n${w.acceptanceCriteria}`);
      } else {
        parts.push("\n（此 work item 沒有填寫 acceptance criteria）");
      }
      return parts.join("\n");
    })
    .join("\n\n");

  return `## Pull Request

- 標題：${input.pr.title}
- ${input.pr.sourceBranch} → ${input.pr.targetBranch}

### PR 描述（僅供理解脈絡，不能當作已完成的證據）
${input.pr.description?.trim() || "（無描述）"}

## 需要驗證的需求

${wiBlocks}

## 實際的程式碼變更

${payload.text}

## 你的輸出

依 schema 輸出 JSON。把上方每一條 acceptance criterion 都列進 criteria 陣列並給出判定；
若某個 work item 沒有 acceptance criteria，就用它的描述當作需求來判定。`;
}
