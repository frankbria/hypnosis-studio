# Issue #9 — [P0.9] Cache TTS segments across jobs

> Rescoped 2026-08-09: no longer launch-blocking (the $39 catalog tier will be
> pre-rendered), but still fully required for the Personalized ($129) and
> Complete Studio ($1,499) tiers, which render on demand after taking payment.
> Must close before #78. Blocker #2 is closed.

## Root cause

The idempotency the README advertises is real but scoped to `outdir`:

```python
if os.path.exists(out_path):        # render_program.py — per-job directory
    job.update(stage, progress, f"{detail} already rendered")
    continue
```

and `server.js:195` mints a **fresh empty job directory on every POST**. So a
customer-visible retry gets none of it: one transient failure on segment 150 of
152 discards ~20 minutes of wall clock and the whole 17k–22k character spend,
and the ~150 already-voiced WAVs are stranded in the dead job directory. Because
assembly runs only after all four tracks are voiced, an assembler failure on
track 4 discards all 152 segments too.

Measured spend per goal: open_gate 152 segs / 17 015 chars · inner_studio 159 /
18 755 · polymath 152 / 19 396 · golden_thread 153 / 19 403 · river 152 / 22 201.

## Design

### Key

Segment audio is a pure function of `(voice_id, tag, text)` — not bit-identical
across calls (TTS is not deterministic), but *semantically interchangeable*,
which is what matters. Key is `sha256(voice_id \0 tag \0 text)`, fanned out one
level (`<cache>/<h[:2]>/<h>.wav`) so no directory holds thousands of entries.

### What is cached

The **treated** WAV, not the raw MP3 — that is what the assembler reads, and
`treat()` is deterministic (seeded `default_rng(7)`), so caching after treatment
loses nothing and saves the decode + reverb on every hit.

### Where

`RENDERS/segment-cache/`. Deliberately does **not** match `JOB_DIR_RE`
(`^job_[A-Za-z0-9_-]+$`), the pattern #3's retention sweep uses to decide what it
may delete — so the existing job sweep cannot eat the cache. Overridable via
`SEGMENT_CACHE_DIR`.

### Lifecycle

1. **Lookup** before calling `tts()` in the voicing loop: a hit copies from the
   cache into the job directory and skips the purchase entirely.
2. **Populate** after a segment is treated and written.
3. **Promote on prune.** `job_files.prune_intermediates` currently deletes the
   segment dirs when a job reaches `ready`; its own docstring already says this
   is where they should be *moved* into the cache instead. That is the change.
4. **Sweep** — bounded by total bytes, LRU by mtime, run at the end of a render
   (the cache only grows during one, so a periodic sweep would buy nothing).

## Acceptance criteria → coverage

| Criterion | Covered by |
|---|---|
| Segments stored in a shared cache keyed on voice id, tag and text | `segment_cache.key()` / `store()` |
| A repeat job for the same goal + voice set makes no TTS calls | lookup ahead of `tts()`; test asserts zero calls |
| A retry after mid-run failure resumes from cache | same path — a failed job's segments are promoted only on success, so this is covered by the populate-on-write step, not only by promotion |
| Cache is bounded or swept | `sweep()` with a byte ceiling, LRU by mtime |

## Decisions

1. **Populate on write, not only on promote.** If segments were only moved into
   the cache when a job reaches `ready`, a job that dies at segment 150 would
   cache nothing — which is exactly the scenario the issue opens with. Each
   segment is cached as soon as it is treated.
2. **Copy into the job dir on a hit rather than symlink.** `job_files`
   deliberately refuses to follow symlinks when pruning (deleting through one
   would destroy the cache), and the download path serves from the job dir. A
   copy keeps both simple; the cost is disk, which the sweep bounds.
3. **Sweep at end of render, in Python.** The cache is written by the Python
   worker and only grows while a render is running, so the Node sweep loop has
   nothing to add and would need a second implementation in another language.
4. **Cache is keyed on content, not on goal/voice-set.** Tracks share segments
   (the disclaimer S01 is reused), and a script edit changes the key
   automatically — no invalidation logic to get wrong.

## Risks

- **A cache hit skips the #8 validation**, since nothing is fetched. Cached
  entries were validated when written, but a truncated file could still arrive
  by other means (a partial copy). `store()` writes via a temp file and renames,
  so an entry is either complete or absent.
- Sizing: ~530 KB per treated segment × 152 ≈ 80 MB per (goal, voice set), ~800 MB
  for all ten combinations. The byte ceiling has to sit above one full goal or
  the cache thrashes.
