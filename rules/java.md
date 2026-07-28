---
applyTo: "**/*.java"
---

# Java 審查規則

SpotBugs / PMD / Error Prone 已涵蓋的樣式**不要重複回報**。以下著重在需要脈絡判斷、
或工具規則覆蓋不到的問題。

## 併發

- **volatile 欄位做複合運算**（`count++`、`x += 1`）。volatile 保證可見性，不保證原子性。
  → `AtomicInteger` 或加鎖。
- **在 concurrent 集合上做非原子的複合操作**：`if (!map.containsKey(k)) map.put(k, v)`。
  兩個呼叫各自原子，合起來不是。→ `putIfAbsent` / `computeIfAbsent` / `merge`。
- **static 的 `SimpleDateFormat` 或 `Calendar`**。兩者都不是執行緒安全的。
  → `DateTimeFormatter`（不可變）。
- **同步在會被重新賦值的欄位上**，或同步在 boxed primitive、interned String 上
  （這些物件可能被別的程式碼共用，鎖的範圍會意外擴大）。
- **持有鎖時呼叫外部程式碼**（RPC、callback、I/O）。鎖的持有時間變成不可控，
  而且容易形成鎖順序反轉。
- **虛擬執行緒中使用 `synchronized`** 會造成 pinning，抵銷虛擬執行緒的效益。
  → `ReentrantLock`。

## 這兩類靜態工具沒有規則，一定要人工判斷

- **`Collectors.toMap` 沒給 merge function**。遇到重複 key 直接拋
  `IllegalStateException: Duplicate key`；而且它底層是 `HashMap::merge`，
  **value 為 null 時會 NPE**（跟 `HashMap.put` 行為不同）。
- **parallel stream 中存取共用可變狀態**。parallel stream 共用整個 JVM 的
  `ForkJoinPool.commonPool()`，一個阻塞任務會拖累整個行程中所有的 parallel stream。

## Stream

- **重複使用已消費的 stream** → `IllegalStateException: stream has already been operated upon or closed`。
- **`peek` 可能被完全略過**。若來源是 SIZED 且終端操作是 `count()`，實作可以省略整個管線。
  不要在 `peek` 裡放有副作用的邏輯。
- **`Files.lines` / `Files.walk` 會持有檔案 handle**，必須在 try-with-resources 中使用。
- **behavioral parameter 有副作用**。javadoc 明確說明實作可以省略操作、
  也不保證副作用對其他執行緒可見。

## Spring `@Transactional`

- **self-invocation**：同一個 class 內部呼叫自己的 `@Transactional` 方法，
  proxy 攔不到，交易根本沒開。
- **checked exception 預設不回滾**。只有 `RuntimeException` 和 `Error` 會觸發回滾。
  → `rollbackFor = Exception.class`。
- **`readOnly = true` 會把 Hibernate 設為 `FlushMode.MANUAL`**，在其中做的修改會被靜默丟棄。
- **交易中呼叫外部 HTTP/RPC**。整個 RPC 期間都占用一條資料庫連線。
- **`@Transactional` 搭配 `@Async`**。交易同步是 ThreadLocal 綁定的，不會傳播到新執行緒。
- **在 commit 前觸發副作用**（發訊息、寫快取）。交易若回滾，副作用已經發生。
  → `@TransactionalEventListener(phase = AFTER_COMMIT)`。
- **非 public 方法**在 JDK proxy 模式下不會被攔截。

## JPA / Hibernate

- **N+1 查詢**。→ `JOIN FETCH`、`@EntityGraph`、`@BatchSize` 或 DTO projection。
- **分頁搭配 `JOIN FETCH` 抓集合** → Hibernate 會把整個結果集載入記憶體再分頁
  （`HHH000104` 警告），資料量大時直接 OOM。
- **同時 fetch 多個 List 型別的關聯** → `MultipleBagFetchException`。
- **entity 的 `equals`/`hashCode` 用產生的 ID**。flush 前 ID 是 null，
  物件放進 `HashSet` 後會找不回來。
- **`FetchType.EAGER`** 幾乎總是錯的預設。

## 資源與例外

- **未使用 try-with-resources**。stream、connection、reader 在例外路徑上不會被關閉。
- **吞掉 `InterruptedException`**。至少要 `Thread.currentThread().interrupt()`。
- **`Optional.get()` 沒有先 `isPresent()`**，以及把 `Optional` 當參數型別。
