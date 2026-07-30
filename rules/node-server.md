---
applyTo: "**/*.ts", "**/*.mts", "**/*.cts"
---

# Node server review rules

**These rules apply only to server-side code that handles external requests.** Judge each
file separately: for a file that is a library, a CLI, a build script, or a client-side
component, none of these rules apply to that file and none may be cited against it.

## Request-scoped data in module scope

One Node process serves every concurrent request. A module-level binding is shared by all of
them.

- **Caching the current user, tenant, session, or request object at module scope** leaks one
  user's data into another user's request. No static tool catches this, and the failure only
  shows under concurrent load. → `AsyncLocalStorage`, or state attached to the request
  object itself.
- **Exception — the deliberate client singleton.** A connection pool or client instance
  intentionally stored on `globalThis` (the standard Prisma-under-Next.js pattern, guarded by
  `NODE_ENV`) exists to survive dev-mode hot reload without exhausting database connections.
  It is process-wide infrastructure, not request state. **Do not report it.**

## Error handling on async request paths

- **An async route handler that can reject, in Express 4.** Express 4 does **not** route a
  rejected handler promise to error middleware — the request hangs until the client times
  out. Express 5 does call `next(err)` automatically. Check which major version the project
  uses before reporting. → in Express 4, wrap handlers or `try`/`catch` + `next(err)`.
- **Writing to the response after it may already have been sent.** A second
  `res.send`/`res.json` on any path (often: forgetting `return` after an early error
  response) throws `ERR_HTTP_HEADERS_SENT`. Error middleware must check `res.headersSent`
  and delegate.
- **A `catch` that logs and continues** as if the operation succeeded, letting the handler
  respond 200 with half-done state.

## The trust boundary

Server Action argument validation and over-returning are covered by the Next.js rules; the
items below concern every other entry point (REST/RPC handlers, queue consumers, webhooks).

- **Request input reaching business logic without schema validation.** A query parameter can
  arrive as a string, an array, or a nested object depending on URL syntax alone.
- **Mass assignment**: spreading the request body into a persistence call
  (`create({ ...req.body })`) lets the client set any column, including `role` or `isAdmin`.
  → pick the allowed fields explicitly.
- **Returning whole database rows.** Password hashes, tokens, and internal flags ride along.
  → select or map to the fields the response needs.
- **Raw SQL built with template literals** around user input. → parameterized queries; ORM
  raw-query escape hatches included.
- **User input reaching `fs` paths** (path traversal) **or `child_process`.** → validate
  and resolve paths against a fixed root; `execFile` with an argument array, never `exec`
  with an interpolated string.
- **Secret or token comparison with `===`** leaks length and prefix through timing.
  → `crypto.timingSafeEqual`.

## Event loop and unbounded work

- **Synchronous work on the request path**: `fs.*Sync`, `zlib.*Sync`, synchronous crypto
  (`pbkdf2Sync`, `scryptSync`), or `JSON.parse`/`stringify` of large payloads. One request
  stalls every other request in the process.
- **A regex with nested or overlapping quantifiers applied to user input** can backtrack for
  seconds (ReDoS) — same effect as the above, triggered remotely.
- **`Promise.all` over an array whose length the caller controls** (ids from the request,
  rows from an unbounded query) fans out unbounded concurrent work. → cap with a pool or
  batch.
- **A module-level `Map` used as a cache with no eviction** grows for the life of the
  process. → an LRU with a size bound, or at least a TTL.

## Shutdown

- **No graceful shutdown handling**: on `SIGTERM`, stop accepting connections, let in-flight
  requests finish, close pools, then exit. Without it every deploy drops whatever was in
  flight.
