# Issue #3 — [P0.3] Age-based retention sweep

**Branch:** `feature/issue-3-retention-sweep` · **Base:** `main`
**Plan source:** self-authored. The issue's one comment is the recorded 30-day decision, not a plan.

## Problem

`renders/` grows without bound. #2 removed the ~230 MB of per-job intermediates, but the ~290 MB of
masters per job is still never reclaimed. On a box shared with unrelated vhosts, this app filling the
volume takes the neighbours down with it.

## This deletes customer purchases

Everything below is shaped by that. A retention sweep that is slightly too eager destroys something a
customer paid for and cannot be undone. So the rule is **delete only what is unambiguously safe to
delete, and skip anything uncertain** — an orphan directory costing a few KB forever is a far better
outcome than one wrongly-reaped order.

A directory is reaped only if **all** of these hold:

1. It sits directly under `renders/` and is a real directory (not a symlink — `rm -rf` through one
   destroys the target instead).
2. Its name matches `SAFE_ID`, so `.quota.json` and any stray file can never be selected.
3. It has a parseable `status.json`.
4. That status is in a **terminal** state (`ready` or `failed`) — never `rendering`.
5. `updatedAt` parses to a real time.
6. That time is older than the window.

Anything failing any check is left alone. No exception can propagate: a sweep failure must never take
the process down, for the same reason `writeStatus` is guarded.

## Steps

1. **`RENDERS_DIR` env override** for the renders root (see decisions below).
2. **`sweepExpiredJobs()`** implementing the rules above, called from the existing 60 s timer
   alongside `sweepStaleJobs()`.
3. **`RETENTION_DAYS`** (default **30**, per the decision on the issue) and **`RETENTION_DRY_RUN`**.
4. **Audit logging** — one line per reap with job id, state, age, and bytes freed.
5. **Tests** covering every skip rule, not just the happy path.

## Decisions taken autonomously

- **Separate function, shared timer.** The issue suggests folding the pass into `sweepStaleJobs()`. I
  am keeping them separate and calling both from the one interval: `sweepStaleJobs` is existing,
  working, tested code, and a second `readdir` every 60 s costs nothing. Smaller diff, each testable
  alone.
- **`updatedAt`, not filesystem mtime.** `updatedAt` is written by us and means "when this job last
  changed state". `mtime` can be moved by anything that touches the directory.
- **`RENDERS_DIR` env override — the one production change made for testability.** It is justified
  twice over: without it, running the test suite locally would point an aggressive retention window
  at the developer's real `renders/` directory and could delete their own output. It is also required
  by #86, where `renders/` becomes a mounted volume at an arbitrary path. One line, default unchanged.
- **`RETENTION_DRY_RUN`.** For a destructive feature the first production run should be verifiable
  rather than trusted. Three lines, and it turns "it should be fine" into evidence.
- **Non-terminal jobs are never reaped**, even though a 30-day-old `rendering` job cannot exist in
  practice (`sweepStaleJobs` fails it within 2 minutes). Defence in depth: the cost of the check is
  nothing and the cost of being wrong is a destroyed in-flight render.

## Interaction worth knowing

`sweepStaleJobs()` marks a stale `rendering` job as `failed` via `writeStatus`, which sets
`updatedAt` to now. So a job that has just been failed by the sweep restarts its retention clock
rather than being reaped in the same pass. That is correct — age should run from the terminal state —
and it is asserted in the tests so nobody "fixes" it later.

## Acceptance criteria (from the issue)

- [ ] Job directories whose `updatedAt` is older than the configured window are removed entirely
- [ ] The window is configurable via env, with a documented default
- [ ] Requests for files belonging to a swept job return 404/410 rather than crashing (needs #1 — merged)
- [ ] A dry-run or log line records what was reaped, so the first production run is auditable
