# Issue #12 — [P0.12] Dead filter pass, and the defeated float32 flag

## The two defects

`assemble_track.py:178-180` (line numbers shifted by #5/#6; the code is unchanged):

```python
pad = sosfiltfilt(sos_notch, pad)   # result never read — the next reference is `del pad`
mix = sosfiltfilt(sos_notch, mix)   # no .astype(DTYPE), unlike every other chunked op
del pad
```

**Dead work.** The filtered `pad` is never read. `pad_rms` was taken earlier and
`welch()` earlier still. On the installed SciPy, `sosfiltfilt` with float64
coefficients promotes a float32 input to float64, so this discarded line costs
several hundred MB — and that result is still live while the same storm runs for
`mix` on the next line.

**Defeated flag.** `mix = sosfiltfilt(...)` does not restore `DTYPE`, so
`HYPNO_DTYPE=float32` — added specifically to halve mixer RAM and survive an
OOM — stops working from that line on. Bed accumulation, fade, normalise, soft
clip and both writes all run float64. Compare `:128`, `:159`, `:209`, `:220`,
`:224`, which all end in `.astype(DTYPE, copy=False)`.

## A distinction the criteria blur

Criterion 1 asks for **bit-identical output**. That is true of removing the dead
line, and it is true of the dtype restore *in the default float64 mode* (where
`.astype(float64)` is a no-op).

It is **not** true of the dtype restore under `HYPNO_DTYPE=float32` — and must
not be. The whole point of that flag is to carry float32 downstream; restoring it
necessarily changes the samples relative to today's accidental float64. So:

| mode | dead line removed | dtype restored |
|---|---|---|
| float64 (default, and what production QA compares against) | bit-identical | bit-identical (no-op cast) |
| float32 (`HYPNO_DTYPE=float32`, the prod worker's setting) | bit-identical | **changes by design** — this is the flag finally working |

Production sets `HYPNO_DTYPE=float32` (`render_program.py` `env.setdefault`), so
the shipped audio *will* change slightly. That is the fix, not a regression, but
it is worth stating rather than claiming "bit-identical" without qualification.

## Measurement plan

Criterion 3 requires peak memory recorded before closing. Using the synthetic
fixture built for #5 (real pad, real segment WAVs, the real assembler), measured
with `resource.getrusage(RUSAGE_CHILDREN).ru_maxrss`:

1. `main` vs patched, `HYPNO_DTYPE=float64` — compare WAV bytes (expect identical) and peak RSS.
2. `main` vs patched, `HYPNO_DTYPE=float32` — peak RSS (expect a real drop), and report how far the audio moved rather than asserting identity.
3. Scale the fixture up so the arrays are large enough for the difference to be visible rather than lost in interpreter overhead.

## Changes

1. Delete the dead `pad = sosfiltfilt(...)` line.
2. `mix = sosfiltfilt(sos_notch, mix).astype(DTYPE, copy=False)`.
3. A test pinning that every full-rate operation restores `DTYPE`, so the next
   one added does not silently defeat the flag again.

## Decisions

1. **Keep `del pad`.** It now frees the flattened pad rather than the filtered
   copy; either way the array goes, and dropping the statement would keep a
   ~900 s buffer alive through bed synthesis.
2. **Report the float32 audio delta rather than claiming identity**, per above.
