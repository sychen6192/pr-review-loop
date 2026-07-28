---
applyTo: "**/*.tsx", "**/*.jsx", "**/app/**", "**/pages/**"
---

# React / Next.js 審查規則

eslint（含 `react-hooks` 與 `@next/next`）與 `tsc` 已涵蓋的**不要重複回報**。
以下是它們抓不到的。

## Server Action 安全性（最高優先）

- **Server Action 必須自己重新驗證授權。** 這是最常見也最嚴重的錯誤：
  Server Action 一旦被建立並匯出，**就可以被直接 POST 呼叫**，不必經過你的 UI。
  page 層或 layout 層的驗證**不會**延伸進 action 內部。
  → 每個 action 內都要重新確認身分（authentication）**與資源歸屬（authorization）**。
- **只驗證身分不驗證歸屬**。確認「你是誰」不等於確認「這筆資料是你的」。
  任何吃 id 參數的 action 都要檢查該資源屬於當前使用者。
- **action 參數未驗證**。來自客戶端的輸入一律要 schema 驗證。
- **回傳完整的資料庫 record**。只回傳 UI 需要的欄位，不要把整筆 row 丟出去。
- **只在 middleware / proxy 做驗證**。CVE-2025-29927 可透過偽造
  `x-middleware-subrequest` 標頭完全跳過 middleware，因此驗證不能只存在於此。

## Server / Client 邊界

- **`'use client'` 放在 layout 或 barrel 檔案**。該檔案的**所有 import 與它直接 render 的
  元件都會被拉進 client bundle**，一個位置錯誤會讓整棵子樹變成 client 元件。
  → 把 `'use client'` 放在盡可能深的葉節點；用 children/props 傳入 Server Component。
- **傳不可序列化的值給 Client Component**：函式、class instance、Date 以外的複雜物件。
- **在 Client Component 中存取伺服器端的機密**。只有 `NEXT_PUBLIC_` 前綴的環境變數
  會進入客戶端——反過來說，帶這個前綴的東西一定會外洩。
- **在 Server Component 中使用 client hook**（useState、useEffect、useContext）。

## Hydration

出現 hydration 不匹配時，成因幾乎必定是下列之一：

- render 期間使用 `Date.now()`、`Math.random()`、`new Date()` 或使用者語系的日期格式化
- render 期間讀取 `typeof window !== 'undefined'` 或瀏覽器專屬 API
- HTML 巢狀不合法（`<p>` 裡放 `<div>`、`<a>` 裡放 `<a>`、`<button>` 裡放 `<button>`）
- 未隨 HTML 一起送出快照的外部變動資料

`suppressHydrationWarning` 是逃生口，只作用一層，不要拿來蓋住真正的問題。

## useEffect

大多數 useEffect 是不必要的。看到 effect 先問是不是下列情形：

- **依 props/state 計算衍生值** → 直接在 render 期間算，不要用 effect + state
- **prop 變了要重設所有 state** → 傳不同的 `key`，不要在 effect 裡重設
- **事件處理器之間共用邏輯** → 抽成函式，不要用 effect
- **送出 POST（使用者操作觸發的）** → 放在事件處理器裡
- **訂閱外部 store** → `useSyncExternalStore`

真正需要 effect 的資料抓取，**必須處理 race condition**：先發的請求可能後回來。
→ cleanup 中設 `ignore` 旗標。

## 其他

- **用 index 當 list 的 key**，或用 `Math.random()` 當 key（後者會重建整個 DOM 並清空使用者輸入）。
- **`dangerouslySetInnerHTML` 內容未消毒**。除非來源完全可信，否則就是 XSS。
- **`useSearchParams()` 沒有包 Suspense**，會讓**整個頁面**退化成客戶端渲染。
- **`export const dynamic = 'force-static'` 會讓 `cookies()`、`headers()`、
  `useSearchParams()` 靜默回傳空值**，這是很難查的 bug 來源。
- **同一個元件內連續 await 多個獨立請求**會形成 waterfall。→ `Promise.all`。
- **layout 讀取 runtime 資料**（`cookies()`、未快取的 fetch）時**不會**退回同層的
  `loading.js`，而是直接阻塞導航。
