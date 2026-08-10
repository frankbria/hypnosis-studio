# Issue #10 — [P0.10] Release the quota slot when a render fails

## Root cause

`bumpQuota()` fires before the worker starts and nothing ever decrements it
(`server.js:201`, `:103-107`). A failed render permanently eats one of
`MAX_JOBS_PER_DAY` (default 6). Two transient failures cost double the credit
burn *and* a third of the day's capacity, with the customer holding nothing.

The pathological case is a configuration error: a missing `ELEVENLABS_API_KEY`
fails every job a few seconds in — `load_key()` runs at
`render_program.py:213`, long after the slot is spent — silently burning all six
slots for the day while producing nothing.

## Sequencing note

**#56 (P0.13) replaces this counter outright** with a monthly character budget,
because the provider meters characters and a 6/day cap permits ~180 programs a
month. So the *unit* here is temporary.

The hard part is not: an idempotent release that the worker-exit handler and the
stale sweep cannot double-apply is needed either way — a failed render must not
consume the character budget either. This is built so #56 swaps the unit and
keeps the ledger.

## Design

### The ledger

Idempotency needs to know *which* jobs currently hold a slot, so the quota file
gains a list:

```json
{ "day": "2026-08-10", "count": 2, "jobs": ["job_abc", "job_def"] }
```

- `bumpQuota(id)` increments and appends.
- `releaseQuota(id)` returns the slot only if the id is in the list, then
  removes it. A second call finds nothing and is a no-op.

This gets day-correctness for free. `readQuota()` already discards the file when
`day` is not today, so yesterday's ids vanish with it and a job that fails after
midnight cannot refund against today's allowance — which a naive `count -= 1`
would happily do.

Legacy `{day, count}` files with no `jobs` degrade safely: the cap still applies,
releases are no-ops (nothing identifiable to refund), and the next day's file has
the ledger.

### Release points

All four go through the same idempotent call:

1. `child.on('exit')` — the worker wrote `failed`, or crashed and the handler
   wrote it.
2. `child.on('error')` — asynchronous spawn failure.
3. the synchronous `spawn` catch — the existing `return` path that writes
   `worker spawn failed`.
4. `sweepStaleJobs()` — where a `rendering` job is declared failed after a
   restart.

(1) and (4) genuinely race: a worker can exit around the moment the sweep
declares it stale. That is exactly what the ledger makes safe.

### Atomic write

`bumpQuota` uses a bare `fs.writeFileSync`. Now that the file is written on both
sides of every job, it moves to the tmp-file + rename that `writeStatus` already
uses — a torn quota file would either re-open the day's allowance or close it.

## Acceptance criteria → coverage

| Criterion | Covered by |
|---|---|
| A job that ends in `failed` releases its slot | release at all four points |
| Release is idempotent — sweep and exit handler cannot double-refund | the `jobs` ledger |
| A successful job still consumes exactly one slot | `ready` never releases; test asserts count stays 1 |

## Decisions

1. **The ledger lives in the quota file, not in `status.json`.** The Python
   worker rewrites `status.json` from scratch on every transition, so a flag
   added there by Node would be erased within seconds.
2. **`count` stays authoritative rather than being derived from `jobs.length`.**
   Deriving it would silently reopen the day's allowance for any pre-existing
   quota file, which has no `jobs` key.
3. **A crashed worker refunds.** The customer has nothing either way; whether the
   process died or reported failure cleanly is not a distinction worth charging
   for.
