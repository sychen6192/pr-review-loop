---
applyTo: "**/*.py"
---

# Python 審查規則

linter（ruff / mypy / bandit）已經會抓下列規則，**不要重複回報**：
格式、import 排序、未使用變數、行長度、型別錯誤、bandit 的安全樣式比對。

以下是工具抓不到、或抓到但需要脈絡判斷的問題。

## 可變預設值與閉包

- **函式參數的可變預設值**（`def f(x=[])`、`def f(x={})`）。整個程式生命週期共用同一個物件。
  → 改成 `None` 再於函式內建立。
- **class 屬性的可變預設值**。所有 instance 共用同一份，而且不明顯。
  → 在 `__init__` 建立、標為 `ClassVar`、或改用不可變型別。
- **迴圈變數被閉包捕獲**。lambda 或巢狀函式在迴圈中捕獲迴圈變數，全部會拿到最後一次的值。
  → 用預設參數綁定，或 `functools.partial`。

## async

- **在 async 函式中呼叫阻塞 API**：`time.sleep`、`requests`、同步的 `open()`、
  `subprocess.run`、`os.path` 系列。會卡住整個 event loop。
  → 改用 async 對應版本，或 `run_in_executor`。
- **fire-and-forget 的 `asyncio.create_task()`**。event loop 只持有 task 的弱參考，
  沒保留參考的 task 可能在完成前就被 GC。
  → 存進一個 set，並用 `add_done_callback` 移除。
- **在 `except` 或 `finally` 中 await**，可能吞掉 `CancelledError` 導致取消失效。
- **忘記 await**。`async def` 的回傳值沒被 await 就是一個從未執行的 coroutine，
  而且通常靜默無錯。

## 例外與資源

- **`except: pass` 或 `except Exception: pass`**。裸 except 連 `KeyboardInterrupt` 都吃掉。
  → 至少記錄；要忽略請縮小到具體例外型別並寫明理由。
- **在 `except` 中 raise 新例外卻沒有 `from`**，原始 traceback 會遺失。
- **記錄例外用 `logging.error` 而非 `logging.exception`**，traceback 不會被記錄。
- **開檔沒用 context manager**。例外發生時不保證關閉。`tempfile`、`socket`、
  資料庫連線同理。

## 型別與相等性

- **實作了 `__eq__` 卻沒有 `__hash__`**。Python 會把 `__hash__` 設為 `None`，
  物件變成不可雜湊，放進 set 或當 dict key 會直接壞掉。
- **`datetime.now()` / `utcnow()` 沒有指定時區**。跨時區部署時會產生難以追查的偏差。

## pandas（若有使用）

- **鏈式賦值**（`df[df.a > 1]['b'] = 3`）。pandas 3.0 起 Copy-on-Write 是唯一模式，
  這種寫法會拋 `ChainedAssignmentError`。→ 用 `.loc`。
- **`inplace=True` 搭配鏈式操作**只會修改暫時物件，原始 DataFrame 不變。
- **`df.to_numpy()` 回傳唯讀陣列**，對它賦值會拋 `ValueError`。
