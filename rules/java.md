---
applyTo: "**/*.java"
---

# Java review rules

Patterns already covered by SpotBugs / PMD / Error Prone **must not be reported again**. The
focus below is problems that need context to judge, or that tool rules do not cover.

## Concurrency

- **Compound operations on a volatile field** (`count++`, `x += 1`). volatile guarantees
  visibility, not atomicity.
  → `AtomicInteger` or a lock.
- **Non-atomic compound operations on a concurrent collection**:
  `if (!map.containsKey(k)) map.put(k, v)`. Each call is atomic on its own; together they
  are not. → `putIfAbsent` / `computeIfAbsent` / `merge`.
- **static `SimpleDateFormat` or `Calendar`.** Neither is thread safe.
  → `DateTimeFormatter` (immutable).
- **Synchronizing on a field that gets reassigned**, or on a boxed primitive or interned
  String (those objects may be shared by other code, so the lock's scope widens
  unexpectedly).
- **Calling foreign code while holding a lock** (RPC, callbacks, I/O). Lock hold time becomes
  uncontrollable, and lock-order inversion becomes easy.
- **`synchronized` inside a virtual thread** causes pinning and cancels out the benefit of
  virtual threads.
  → `ReentrantLock`.

## Two classes the static tools have no rules for — always judge these by hand

- **`Collectors.toMap` without a merge function.** A duplicate key throws
  `IllegalStateException: Duplicate key`; and because it is built on `HashMap::merge`, a
  **null value causes an NPE** (unlike `HashMap.put`).
- **Shared mutable state accessed inside a parallel stream.** Parallel streams share the
  whole JVM's `ForkJoinPool.commonPool()`, so one blocking task drags down every parallel
  stream in the process.

## Stream

- **Reusing a consumed stream** → `IllegalStateException: stream has already been operated upon or closed`.
- **`peek` can be skipped entirely.** If the source is SIZED and the terminal operation is
  `count()`, the implementation may elide the whole pipeline. Do not put side-effecting logic
  in `peek`.
- **`Files.lines` / `Files.walk` hold a file handle** and must be used in try-with-resources.
- **Side effects in a behavioral parameter.** The javadoc states explicitly that
  implementations may elide operations and that side effects are not guaranteed visible to
  other threads.

## Spring `@Transactional`

- **Self-invocation**: calling your own `@Transactional` method from inside the same class.
  The proxy cannot intercept it, so no transaction is ever started.
- **Checked exceptions do not roll back by default.** Only `RuntimeException` and `Error`
  trigger a rollback.
  → `rollbackFor = Exception.class`.
- **`readOnly = true` sets Hibernate to `FlushMode.MANUAL`**, so modifications made inside
  are silently discarded.
- **Calling external HTTP/RPC inside a transaction.** A database connection is held for the
  entire RPC.
- **`@Transactional` combined with `@Async`.** Transaction synchronization is ThreadLocal
  bound and does not propagate to the new thread.
- **Triggering side effects before commit** (sending messages, writing to cache). If the
  transaction rolls back, the side effect has already happened.
  → `@TransactionalEventListener(phase = AFTER_COMMIT)`.
- **Non-public methods** are not intercepted under JDK proxy mode.

## JPA / Hibernate

- **N+1 queries.** → `JOIN FETCH`, `@EntityGraph`, `@BatchSize`, or a DTO projection.
- **Pagination combined with `JOIN FETCH` on a collection** → Hibernate loads the whole
  result set into memory and paginates there (the `HHH000104` warning); with enough data,
  straight to OOM.
- **Fetching several List-typed associations at once** → `MultipleBagFetchException`.
- **Entity `equals`/`hashCode` based on a generated ID.** Before flush the ID is null, so an
  object put into a `HashSet` can no longer be found.
- **`FetchType.EAGER`** is almost always the wrong default.

## Resources and exceptions

- **Not using try-with-resources.** Streams, connections, and readers are not closed on
  exception paths.
- **Swallowing `InterruptedException`.** At minimum call
  `Thread.currentThread().interrupt()`.
- **`Optional.get()` without a preceding `isPresent()`**, and using `Optional` as a parameter
  type.
