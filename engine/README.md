# Render engine

Two-stage pipeline that turns a hypnosis script (segment JSON) into a finished, mono-friendly mastered track.

## Voices

- Frame / induction / deepening / resurface: ElevenLabs **Brian** (`nPczCjzI2devNBz1zQrb`), `[soft]` tag
- Suggestion phase: whisper voice (`RsoSo7Gg7GyAtGoPBiqb`), `[whispering]` tag
- Model: `eleven_v3`, stability 0.5, similarity_boost 0.75, speed 0.85

## Stage 1 — `render_track.py <track>`

Reads `<track>_tts_segments.json`, calls ElevenLabs per segment, de-harshes (6.5 kHz one-pole blend) and adds a light algorithmic reverb, writes `<track>_segments/<id>.wav`. Existing segments are skipped (idempotent reruns).

Requires `.env.local` in the working directory:

```
ELEVENLABS_API_KEY=sk_...
```

## Stage 2 — `assemble_track.py <track> "<Title>" <pad.wav> <kw1,kw2> [total_s]`

- Flattens pad energy (per-second RMS correction, clamped ±8 dB)
- Voice submix on a **smooth dB curve**: 0 → +3 → +6 → sink to −14 across deepening, hold through suggestion, +6 return on resurface
- 2 s register-change overlaps so narrator ↔ whisper crossfades
- Carrier auto-scan (300–400 Hz quietest slot) + ±10 Hz notch, then an isochronic bed on a theta→alpha arc at pad_rms −29 dB
- 30 s fade-out, master to −20 dB RMS, soft clip; writes WAV + MP3
- **Track length is bounded by the pad** — see below
- QA: per-minute RMS profile, bed-pulse check, faster-whisper transcript of the sunken suggestion layer with keyword hit count

## Track length and the pad

`total_s` is a **minimum**; the pad is the **ceiling**. The assembler wants
`MIN_OUTRO_S` (75 s) of music after the last word, but `voice_end` is the sum of
real TTS durations — non-deterministic, and unknowable until the whole track has
been bought. So the order is:

1. Take the longer of `total_s` and `voice_end + 75 s`, rounded up.
2. Clamp that down to the pad's length (rounded *down* to a whole second).
3. Refuse only if what is left cannot carry the voice plus the closing 30 s fade.

A long voice program therefore ships with a **shortened music outro** rather than
failing at assembly with the track's entire spend already gone (issue #5). The
assembler prints a `note: outro shortened to …` line whenever that happens.

The arithmetic lives in `timeline.py`, stdlib-only so it is testable without the
audio stack — `assemble_track.py` does all its work at module import time and
cannot be imported in a test at all.

### Catching it before you spend

`render_program.py --dry-run` projects each track's voice length from its
character count and checks it against the real pad duration, so an overlong
program is visible before any credits are bought:

```
pad check: pad_15.wav is 960s (projecting at 11.0 chars/s)
  track 1/4 river: voice ~926s, outro ~34s, headroom 4s  (outro under the 75s target)
```

`--dry-run` **fails** on a track that will not fit. A real render logs the same
projection but does not refuse on it — the estimate is deliberately conservative
and the assembler degrades gracefully, so blocking would forfeit a sale to avoid
a shorter music tail.

`HYPNO_CHARS_PER_SEC` overrides the assumed speaking rate (default 11.0, chosen
below the ~12.75 chars/s that `eleven_v3` at `speed: 0.85` actually delivers, so
the projection errs long). Re-derive it from real `manifest.json` durations when
you have them.

## Pads

Pad WAVs are large binary assets and are intentionally not committed (kept in Dropbox / local working dirs). Place the pad in the working directory and pass it as `<pad.wav>`.

Every goal pad is 960 s, which is what tracks 1-3 (`total_s` 780) are sized
against. If you swap a pad for a shorter one, run `--dry-run` for every goal that
uses it first.
