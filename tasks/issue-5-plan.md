# Issue #5 — [P0.5] Bound ACTUAL_S by real pad length

## Root cause

`assemble_track.py` computes `ACTUAL_S` from the voice program alone:

```python
ACTUAL_S = float(int(max(float(TOTAL_S), voice_end + MIN_OUTRO_S) + 0.999))   # :91
...
assert len(pad) >= ACTUAL_S * SR                                              # :96
```

`voice_end` is the sum of real TTS durations — non-deterministic and unknowable
until every segment has been paid for. Pads are a fixed 960 s. When the voice
program runs long, the bare assert fires at the assembly stage, *after* the
entire TTS spend for that track. `--dry-run` cannot catch it: it checks pad
existence only (`render_program.py:196-198`), never length.

Measured: river track 1 is 6457 tagged characters with 337 s of scripted pauses.
Working back from the issue's "~40 s of headroom" gives an implied ~12.75 chars/s,
consistent with ElevenLabs `eleven_v3` at `speed: 0.85`. The margin is real.

## Changes

### 1. New `engine/timeline.py` (stdlib only)

Pure duration math, no numpy/soundfile — so it is testable without the audio
stack, following the pattern `job_files.py` already establishes. A separate
module rather than growing `job_files.py`, whose stated scope is *per-job
filesystem helpers*; timeline arithmetic is not that.

- `LEAD_IN_S = 1.5`, `MIN_OUTRO_S = 75.0`, `FADE_S = 30.0`
- `DEFAULT_CHARS_PER_SEC = 11.0` (env override `HYPNO_CHARS_PER_SEC`)
- `resolve_actual_s(total_s, voice_end, pad_s)` — ceil the desired length, then
  clamp down to `floor(pad_s)`. Raise `ValueError` naming *both* durations when
  the result cannot cover `voice_end + FADE_S`.
- `estimate_voice_end(segments, chars_per_sec)` —
  `LEAD_IN_S + chars/rate + sum(pauses[:-1])`, honouring the suggestion-phase
  pause doubling and the `[soft] ` / `[whispering] ` tag lengths.

Ordering matters: ceil first, clamp second. Clamping before the ceil can push
`ACTUAL_S` back *above* the pad (pad 959.5 s → `int(960.499)` = 960) and
reintroduce the overflow this issue is about.

### 2. `engine/assemble_track.py`

- Move the pad `sf.read` above the `ACTUAL_S` computation so the real pad length
  is available; call `resolve_actual_s`. A long voice program now shortens the
  music outro instead of failing.
- The bare `assert` becomes an explicit `raise` (inside `resolve_actual_s`) —
  asserts are stripped under `python -O`.
- **Guard the `np.interp` breakpoints.** `TRAJ` references `ACTUAL_S - 60` and
  `ACTUAL_S - 5`; once `ACTUAL_S` can be clamped to as little as
  `voice_end + 30`, `ACTUAL_S - 60` falls *behind* `RES_START + 10` and the
  breakpoint times stop increasing. `np.interp` does not validate this — it
  silently returns a garbage envelope (the exact failure mode
  `.github/workflows/glm-review.yml` §3 instructs reviewers to flag). Enforce
  monotonicity with `np.maximum.accumulate` on `TRAJ` and, for the same reason,
  on `GAIN_BP` (where `RES_START + 25` can already exceed `voice_end` on a short
  resurface phase — a latent instance of the same bug).
- Clamp the "outro, no voice" QA window to the real music tail so it does not
  silently start measuring voiced audio.

### 3. `engine/render_program.py`

`--dry-run` reads the real pad length via `sf.info` (no decode), estimates each
track's `voice_end`, and prints pad / estimate / headroom per track. It raises
when the estimate cannot cover voice + fade, and warns when the projected outro
falls below `MIN_OUTRO_S`. This makes the overflow catchable before any credits
are spent.

### 4. Tests — `engine/tests/test_timeline.py`, written first

pytest, stdlib only, matching the existing `engine/tests/` conventions:
clamping, the ceil/clamp ordering, the abort threshold and its message, the
estimator against the real committed scripts, and a monotonicity regression
test for the breakpoint guard.

## Acceptance criteria → coverage

| Criterion | Covered by |
|---|---|
| `ACTUAL_S` clamped to pad; long program shortens the outro | `resolve_actual_s` + assemble_track call site |
| Aborts only when pad cannot cover voice + fade, naming both durations | `resolve_actual_s` raise |
| Bare `assert` replaced by explicit raise | `resolve_actual_s` |
| `--dry-run` validates pad length against planned worst case | `render_program.run` dry-run branch |

## Decisions taken autonomously

1. **`DEFAULT_CHARS_PER_SEC = 11.0`, env-overridable.** Derived from the ~12.75
   chars/s implied by this issue's own headroom figure, with ~15% conservative
   margin (slower estimate ⇒ longer predicted program ⇒ fails safe). Left as a
   knob because real TTS rate drifts with model, voice and prompt tag, and there
   is no committed render data to calibrate against — pads and renders are
   gitignored. Tune the constant when real manifests exist.
2. **New module rather than extending `job_files.py`** — see above.
3. **Monotonic breakpoint guard is in scope** even though the issue does not name
   it: the clamp is what makes the non-monotonic case reachable, so shipping the
   clamp without it would trade a loud failure for silent audio corruption.
