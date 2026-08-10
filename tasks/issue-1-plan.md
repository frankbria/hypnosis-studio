# Issue #1 — [P0.1] Crash-proof the HTTP handler

**Branch:** `feature/issue-1-crash-proof-http-handler` · **Base:** `main`
**Plan source:** self-authored (issue had no plan comment)

## Problem

`serveStatic()` calls `decodeURIComponent()` on the raw URL with no guard, inside an `async` request
handler. Malformed percent-encoding throws `URIError`; nothing awaits the handler's promise, so the
rejection is unhandled and Node exits 1. One anonymous GET kills production.

Verified: `decodeURIComponent('/%80')` throws `URIError: URI malformed`, and an unhandled async
rejection exits Node with code 1. `%80` is *syntactically valid* percent-encoding, so nginx forwards
it untouched.

Three sibling holes share the root cause — an unguarded synchronous throw on the request path:

| # | Location | Trigger |
|---|---|---|
| 1 | `server.js:154` | `decodeURIComponent` on a malformed escape → `URIError` |
| 2 | `server.js:159` | `fs.readFile` with a `\0` in the path → synchronous `ERR_INVALID_ARG_VALUE` |
| 3 | `server.js:235` | `fs.statSync` on a manifest-listed file missing from disk → `ENOENT` |
| 4 | `server.js:238` | `createReadStream(...).pipe(res)` — file deleted between stat and open → unhandled `'error'` event |

(4) is not named in the issue but is the same failure in the same code path, and becomes reachable the
moment retention deletion exists (#3). Fixing 3 without 4 leaves a narrower version of the same crash.

## Steps

1. **Guard the decode in `serveStatic`** — catch `URIError` and return `400`, before any filesystem work.
2. **Wrap the request handler body** in try/catch → `500`, so any unexpected synchronous throw on the
   request path cannot take the process down. This is the root-cause fix; steps 1, 3 and 4 are the
   specific paths that also deserve correct status codes rather than a generic 500.
3. **Guard `statSync`** on the download route → `404` when the file is gone.
4. **Attach an `error` listener to the read stream** → destroy the response rather than throw.
5. **Add a regression test** (`test/server.crash.test.js`, `node:test`) that spawns a real server,
   fires each malformed request, and asserts both the status code and that the process is still
   listening afterwards.
6. **Add `npm test`** wired to `node --test`.

## Decisions taken autonomously (no architectural fork)

- **`node:test`, not jest/vitest.** The root `package.json` has zero dependencies by design; Node 22/24
  ships a test runner. Adding a framework to test a zero-dep server is the wrong trade.
- **Test by spawning a child process**, not by importing `server.js`. The defect *is* process death,
  which an in-process test cannot observe. Also `server.js` calls `listen()` at module load and exports
  nothing, so it is not importable without side effects.
- **No global `process.on('unhandledRejection')` net.** It would mask future defects rather than fix
  them, and the handler-level try/catch already covers every request-path rejection. Noted as a Known
  Limitation instead.
- Plan persisted here rather than `tasks/todo.md` so the launch-readiness plan is not clobbered.

## Added after cross-family review (opencode / GLM)

The review confirmed the request promise chain was fully closed, and found the backstop does **not**
cover `writeStatus` (`server.js:75-81`): three of its four call sites run in async callbacks outside
the chain — the worker's `error` and `exit` handlers, and the sweep timer — where a throw is an
`uncaughtException`, not a rejection.

One is HTTP-reachable: `POST /api/programs` spawns a worker, and if that worker exits while the disk
is full, `writeStatus` throws `ENOSPC` and the process dies. Same defect class as the issue, so it is
in scope rather than deferred.

7. **Guard `writeStatus` internally** — once, where all four callers route through, rather than at
   each call site.
8. **Add an `error` listener for the pipe destination** so a client aborting mid-download cannot leak
   the read stream.
9. **Test it** — a read-only job directory makes the boot sweep's status write fail; without the
   guard the process exits at startup.

Declined from the review: the `fs.readFile` callbacks in `serveStatic` are structurally outside the
chain, but every value reaching `send`/`writeHead` there is a hardcoded literal, and the reviewer
could not construct a throw path. Flagged as fragile-to-future-edits, not a live bug — left alone.

## Acceptance criteria (from the issue)

- [x] `GET /%80`, `/%e0%80`, `/%f0%9f` and `/%00` each return 400 and the process stays up
- [x] A `GET` for a manifest-listed file deleted from disk returns 404, not a crash
- [x] Any unexpected throw inside the handler produces a 500 and the process stays up
- [x] A regression check exists that issues these requests and asserts the server is still listening
