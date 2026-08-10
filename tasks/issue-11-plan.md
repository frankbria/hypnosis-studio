# Issue #11 — [P0.11] Stop the stale sweep declaring live workers dead

## Root cause

`STALE_MS` is 2 minutes and staleness is judged purely by how long ago
`status.json` was touched. A single segment can legitimately stall far longer
than that without a status write, and the sweep then marks the job `failed`
**without killing the child**. `anyJobRendering()` reports no render in flight, a
second POST is accepted, and two NumPy mixers run concurrently on a 4 GB box —
exactly the OOM the chunked assembler exists to avoid.

Worst failure mode in the system: two live workers, one orphaned, both writing
into the same tree.

**The window got wider in #7, not narrower.** The issue cites the old retry
structure (2 settings passes × 3 retries × 120 s ≈ 12 min). The current budget is
`MAX_ATTEMPTS` 4 × 120 s plus 5+15+30 s of backoff per settings pass — about
8.8 minutes, and up to ~17.7 minutes if a 422 sends it through the fallback
settings. Against `STALE_MS` of 2 minutes.

Assembly is the other long stage: it writes status once per track, so a single
track's mixing is one silent interval.

## Design

The issue offers a choice: raise `STALE_MS` above the worst case, **or** judge
staleness by liveness of the recorded worker rather than by timestamp. Liveness
is the right one — a timeout tuned to today's retry budget is a number that goes
stale every time the retry policy changes, and #7 just demonstrated that.

### Liveness, in two layers

1. **`liveWorkers`** (added in #10) is authoritative for jobs this process
   started. No pid-reuse ambiguity: the child is ours and we hold the handle.
2. **`worker.pid`**, a sidecar written in the job directory at spawn, covers
   jobs orphaned across a server restart — where the in-memory set is empty but
   a child may still be running. Checked with `process.kill(pid, 0)`.

A sidecar rather than a field in `status.json`, because the Python worker
rewrites that file from scratch on every transition and would erase it.

### What the sweep does

A `rendering` job is only declared dead when its worker is **not** alive. Then:

- mark `failed`, release the quota slot (#10), as now.

A job whose worker **is** alive is left alone, however old its status —
`anyJobRendering()` keeps returning true, so no second POST is accepted. That is
criterion 3, and it falls out of the liveness check rather than needing its own
mechanism.

### The hard ceiling

Liveness alone never reclaims a genuinely wedged worker — a process blocked
forever on a socket stays "alive". So a second, much larger bound:
`HARD_TIMEOUT_MS`, default 45 minutes, comfortably above a full 4-track render
(15–20 min) plus the worst-case stall.

A job past the hard ceiling is swept **and its worker killed** (criterion 2) —
SIGTERM, then SIGKILL after a grace period. This is the only path that kills, and
it cannot fire on a healthy render.

## Acceptance criteria → coverage

| Criterion | Covered by |
|---|---|
| Staleness by liveness of the recorded worker, not timestamp alone | `liveWorkers` + `worker.pid` |
| A swept job has its worker terminated | the hard-ceiling path kills; the dead-worker path has nothing to kill |
| Two workers cannot run concurrently under any sweep timing | a live worker keeps its job `rendering`, so `anyJobRendering()` still blocks |

## Decisions

1. **Liveness over a bigger `STALE_MS`.** A timeout tuned to the current retry
   budget silently goes wrong the next time that budget changes — which #7 just
   did. Liveness does not.
2. **The pid sidecar is a file, not a `status.json` field**, because the Python
   worker rewrites `status.json` wholesale.
3. **Two bounds, not one.** Liveness handles "the worker died"; the hard ceiling
   handles "the worker is alive but wedged". Neither alone is sufficient.
4. **Only the hard-ceiling path kills.** A dead worker needs no signal, and
   killing on the ordinary path is what would make a false-positive catastrophic.

## Risks

- **Pid reuse.** A recycled pid could make a dead worker look alive. Only
  reachable for jobs orphaned across a restart (`liveWorkers` is exact
  otherwise), and bounded by the hard ceiling, which fires regardless.
- The existing `'service restarted during render'` message stays accurate for
  the dead-worker case and is wrong for the hard-ceiling case, which needs its
  own wording.
