# Issue #56 — [P0.13] Monthly character budget instead of a daily job cap

## Root cause

The throttle protecting spend is **daily**; the constraint it protects is
**monthly**. `MAX_JOBS_PER_DAY=6` permits ~180 programs a month, far beyond any
plan allocation — so the cap does not bound spend, it only spreads it out. On
anything below the Business plan a busy first week exhausts the month, and every
subsequent render fails *after payment*.

## Design

### The unit

Characters, taken from the real scripts rather than an average. The server
computes per-goal totals at boot by reading `engine/scripts/<goal>[_trackN]_tts_segments.json`
and summing `len(tag) + len(text)` — the exact string `tts()` sends, with
`[soft] ` (7) or `[whispering] ` (13) per segment. Computed rather than
committed as a constant, so editing a script cannot silently desynchronise the
budget from what will actually be spent.

Measured today: open_gate 17,015 · inner_studio 18,755 · polymath 19,396 ·
golden_thread 19,403 · river 22,201.

### The ledger, reused

`.budget.json` keyed on the month, with the same `jobs` ledger #10 introduced:

```json
{ "month": "2026-08", "chars": 41597, "jobs": { "job_abc": 22201 } }
```

A map rather than a list, because a release now has to give back *that job's*
character count, not a fixed 1. Everything else carries over: only a job in the
ledger can release, a stale month is discarded wholesale on read, and the
release is idempotent against the exit handler / stale sweep race.

**The GC note from #10's review applies here.** With the per-day cap no longer
the binding limit, the ledger spans a month — successful jobs are never removed,
so it can reach a few hundred entries. That is small, but it is now bounded by
the month rather than by 6, so the reset-on-month-change is what keeps it finite.

### The gate

Refused **before** payment, with `503 budget_exhausted`, distinct from the
existing `429 daily_cap`. This is the same preflight #25 needs, so it goes in one
function both call.

The daily cap stays as a secondary burst control — the issue explicitly allows
it, and it still protects against a single day draining the month.

### Visibility

`/api/health` gains remaining characters, remaining programs at the largest
goal's size, and the month. That is the cheapest thing to watch, and the deploy
gate already polls it.

## Acceptance criteria → coverage

| Criterion | How |
|---|---|
| Spend bounded by a configurable monthly character budget | `MONTHLY_CHAR_BUDGET`, default sized to the Pro plan |
| Tracked in characters, using each goal's real script length | computed at boot from the scripts |
| Refused before payment, clear "temporarily unavailable" | `503 budget_exhausted` in the shared preflight |
| Daily cap may remain as secondary | it does |
| Remaining budget visible | `/api/health` |
| `DEPLOYMENT.md` documents it | yes, including the plan relationship |

## Decisions

1. **Compute per-goal characters at boot, not commit them.** A committed table
   goes stale the moment a script is edited, and the failure is silent.
2. **Default budget sized to the Pro plan (~500k characters).** The issue's table
   gives ~25 programs there. Configurable, and documented against the plan tiers
   so the operator can match it to what they actually pay for.
3. **Refuse with 503, not 429.** They mean different things to a caller: 429 is
   "come back tomorrow", 503 is "this is unavailable until the plan resets or is
   upgraded". #25 needs the second.
4. **Keep the daily cap.** Removing it would let one day drain the month, which
   is the failure the issue describes from the other direction.
