// Renders the PR comments against synthetic data — no Azure DevOps, no model calls.
// Use it to see what a review actually looks like before pointing the tool at a real PR,
// and to eyeball comment wording after changing publish/format.ts.
import { buildHunks, diffLines } from "../libs/diff";
import { renderFindingComment, renderSummary } from "../publish/format";
import type { AnchoredFinding, FileDiff, RequirementResult } from "../libs/types";
import type { ReviewContext } from "../ado/intake";

function mkFile(path: string, rightLines: string[], changed: number[], language: string): FileDiff {
  const leftLines = rightLines.filter((_, i) => !changed.includes(i + 1));
  const { hunks, changedRightLines } = buildHunks(
    leftLines,
    rightLines,
    diffLines(leftLines, rightLines),
  );
  return {
    path,
    changeType: "edit",
    hunks,
    rightLines,
    leftLines,
    changedRightLines,
    binary: false,
    truncated: false,
    language,
  };
}

const files = [
  mkFile(
    "/src/payment/refund_service.py",
    [
      "def process_refund(order_id, amount):",
      "    order = db.get_order(order_id)",
      "    db.begin()",
      "    order.refunded += amount",
      "    gateway.refund(order.payment_id, amount)",
      "    db.commit()",
    ],
    [3, 4, 5, 6],
    "python",
  ),
  mkFile(
    "/app/checkout/page.tsx",
    [
      "export default async function CheckoutPage() {",
      "  const cart = await getCart()",
      "  console.log('cart', cart)",
      "  return <Summary cart={cart} />",
      "}",
    ],
    [3],
    "tsx",
  ),
];

const ctx = {
  ref: { org: "contoso", project: "Shop", repoId: "shop-api", prId: 4821 },
  pr: {
    title: "退款流程支援部分退款",
    description: "實作 PBI #12043 的部分退款。",
    sourceBranch: "feature/partial-refund",
    targetBranch: "main",
    createdBy: "Alice Wu",
    status: "active",
  },
  iterations: [],
  iteration: { id: 3, sourceRefCommit: "", targetRefCommit: "", commonRefCommit: "", createdDate: "" },
  compareTo: 0,
  files,
  skipped: [{ path: "/package-lock.json", reason: "generated/lock/vendor" }],
  changeTrackingIds: new Map(),
} as unknown as ReviewContext;

const req: RequirementResult = {
  workItems: [
    {
      id: 12043,
      title: "支援部分退款",
      type: "Product Backlog Item",
      state: "Active",
      description: "",
      acceptanceCriteria: "",
      url: "",
    },
  ],
  criteria: [
    {
      workItemId: 12043,
      criterion: "使用者可以對一筆訂單申請小於訂單總額的退款",
      verdict: "satisfied",
      note: "process_refund 接受 amount 參數並累加到 order.refunded。",
      file: "/src/payment/refund_service.py",
      quote: "    order.refunded += amount",
    },
    {
      workItemId: 12043,
      criterion: "累計退款金額不得超過訂單總額",
      verdict: "missing",
      note: "diff 中找不到任何檢查 order.refunded 是否超過訂單總額的程式碼。",
    },
    {
      workItemId: 12043,
      criterion: "每筆退款都要寫入稽核日誌，包含操作者與時間",
      verdict: "misunderstood",
      note: "只加了 console 輸出，不是稽核日誌，且未記錄操作者。",
      file: "/app/checkout/page.tsx",
      quote: "  console.log('cart', cart)",
    },
    {
      workItemId: 12043,
      criterion: "退款失敗時應通知使用者",
      verdict: "not-verifiable",
      note: "通知機制可能在前端或訊息佇列，無法只從本次變更判斷。",
    },
  ],
  extras: [
    { claim: "在結帳頁新增了購物車的除錯輸出，與退款需求無關。", file: "/app/checkout/page.tsx" },
  ],
};

const findings: AnchoredFinding[] = [
  {
    category: "data-integrity",
    severity: "critical",
    confidence: 0.9,
    file: "/src/payment/refund_service.py",
    quote: "    gateway.refund(order.payment_id, amount)",
    claim: "外部金流呼叫在資料庫交易之內，交易會一直持有連線直到 RPC 回應。",
    evidence:
      "若 gateway.refund 逾時或拋出例外，db.commit() 不會執行，但金流端可能已經退款成功，" +
      "造成帳款與資料庫不一致；同時整個 RPC 期間都占用一條連線，高併發下會耗盡連線池。",
    suggested_fix: "先 commit 本地狀態，再以 outbox / 事件方式觸發金流退款並處理補償。",
    sources: ["qwen3-coder"],
    fingerprint: "a1b2c3d4e5f6",
    anchor: { side: "right", startLine: 5, endLine: 5, startOffset: 1, endOffset: 46 },
  },
  {
    category: "leftover-code",
    severity: "medium",
    confidence: 0.95,
    file: "/app/checkout/page.tsx",
    quote: "  console.log('cart', cart)",
    claim: "結帳頁留下了除錯輸出，且內容包含完整購物車資料。",
    evidence: "會出現在正式環境的瀏覽器 console，購物車內容可能含個資。",
    sources: ["qwen3-coder", "devstral-small"],
    fingerprint: "f6e5d4c3b2a1",
    anchor: { side: "right", startLine: 3, endLine: 3, startOffset: 1, endOffset: 28 },
  },
];

const degraded: AnchoredFinding[] = [
  {
    category: "concurrency",
    severity: "high",
    confidence: 0.6,
    file: "/src/payment/refund_service.py",
    quote: "    order.refunded = order.refunded + amount",
    claim: "退款金額累加沒有鎖，併發退款會覆蓋彼此的結果。",
    sources: ["qwen3-coder"],
    fingerprint: "0f0f0f0f0f0f",
    anchorFailure: "quote-not-found",
  },
];

console.log("═".repeat(78));
console.log("  Sticky summary 留言（PR 頁面上方，每次執行原地更新）");
console.log("═".repeat(78));
console.log(
  renderSummary({
    ctx,
    agg: {
      inline: findings,
      belowBar: [],
      degraded,
      stats: { raw: 4, afterDedupe: 3, anchored: 3, survived: 2, inline: 2, byFailure: { "quote-not-found": 1 } },
    },
    req,
    finderErrors: [],
    omittedFiles: [],
    appliedRules: ["_base.md"],
    durationSec: 74,
    runDir: "",
  }),
);

for (const f of findings) {
  console.log(`\n${"═".repeat(78)}`);
  console.log(`  Inline 留言 → ${f.file}:${f.anchor?.startLine}`);
  console.log("═".repeat(78));
  console.log(renderFindingComment(f));
}
