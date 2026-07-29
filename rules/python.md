---
applyTo: "**/*.py"
---

# Python review rules

The linters (ruff / mypy / bandit) already catch the following. **Do not report them again:**
formatting, import ordering, unused variables, line length, type errors, bandit's security
pattern matches.

Below are the problems the tools miss, or flag but which need context to judge.

## Mutable defaults and closures

- **Mutable default arguments** (`def f(x=[])`, `def f(x={})`). One object shared for the
  whole life of the process.
  → Use `None` and build it inside the function.
- **Mutable class attribute defaults.** Every instance shares one copy, and it is not
  obvious.
  → Build it in `__init__`, mark it `ClassVar`, or use an immutable type.
- **Loop variable captured by a closure.** A lambda or nested function capturing a loop
  variable inside a loop: all of them get the last value.
  → Bind via a default argument, or `functools.partial`.

## async

- **Blocking APIs called inside an async function**: `time.sleep`, `requests`, synchronous
  `open()`, `subprocess.run`, the `os.path` family. They stall the whole event loop.
  → Use the async equivalent, or `run_in_executor`.
- **Fire-and-forget `asyncio.create_task()`.** The event loop holds only a weak reference to
  the task; a task with no reference kept can be garbage collected before it completes.
  → Store it in a set and remove it via `add_done_callback`.
- **await inside `except` or `finally`** can swallow `CancelledError` and defeat
  cancellation.
- **Forgetting await.** An un-awaited return value from an `async def` is a coroutine that
  never runs, and it usually fails silently.

## Exceptions and resources

- **`except: pass` or `except Exception: pass`.** A bare except even eats
  `KeyboardInterrupt`.
  → Log it at minimum; to ignore something, narrow to the specific exception type and state
  why.
- **Raising a new exception inside `except` without `from`** loses the original traceback.
- **Logging an exception with `logging.error` instead of `logging.exception`** means the
  traceback is not recorded.
- **Opening a file without a context manager.** Closing is not guaranteed when an exception
  occurs. Same for `tempfile`, `socket`, and database connections.

## Types and equality

- **`__eq__` implemented without `__hash__`.** Python sets `__hash__` to `None`, the object
  becomes unhashable, and putting it in a set or using it as a dict key breaks outright.
- **`datetime.now()` / `utcnow()` without a timezone.** Produces hard-to-trace skew in
  cross-timezone deployments.

## pandas (if used)

- **Chained assignment** (`df[df.a > 1]['b'] = 3`). From pandas 3.0, Copy-on-Write is the
  only mode, and this raises `ChainedAssignmentError`. → Use `.loc`.
- **`inplace=True` on a chained operation** only mutates the temporary object; the original
  DataFrame is unchanged.
- **`df.to_numpy()` returns a read-only array**; assigning to it raises `ValueError`.
