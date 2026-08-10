# Render engine

Two-stage pipeline that turns a hypnosis script (segment JSON) into a finished, mono-friendly mastered track.

## Voices

- Frame / induction / deepening / resurface: ElevenLabs **Brian** (`nPczCjzI2devNBz1zQrb`), `[soft]` tag
- Suggestion phase: whisper voice (`RsoSo7Gg7GyAtGoPBiqb`), `[whispering]` tag
- Model: `eleven_v3`, stability 0.5, similarity_boost 0.75, speed 0.85

## Stage 1 — `render_track.py <track>`

Reads `<track>_tts_segments.json`, calls ElevenLabs per segment, de-harshes (6.5 kHz one-pole blend) and adds a light algorithmic reverb, writes `<track>_segments/<id>.wav`. Existing segments in the working directory are skipped (idempotent reruns), and since #9 anything already bought in a *previous* job is served from the shared segment cache — see below.

Requires `.env.local` in the working directory:

```
ELEVENLABS_API_KEY=sk_...
```

### When a TTS call fails

`tts()` classifies every failure (`tts_policy.py`) and the classification reaches
`status.json`, so a failed job says *why*:

| kind | Meaning | Behaviour |
|---|---|---|
| `transient` | network drop, timeout, 408/429/5xx, Cloudflare 520-524, `IncompleteRead` | retried on a 5/15/30 s backoff, 4 attempts |
| `auth` | 401/403 — the key was rejected | stops immediately, **1 request** |
| `quota` | the account is out of credits | stops immediately, **1 request** |
| `unsupported_settings` | 422 — the API rejected `speed` | retried once with the reduced settings |
| `fatal` | anything else, including a local write failure | stops immediately |

Two rules worth knowing, because both cost money when broken:

- **Only the network call is classified.** The file write sits outside it, so a
  full disk raises `fatal` rather than being retried — retrying would buy the
  same audio again and fail to save it again.
- **Quota is read from the response body, not the status code.** ElevenLabs
  report exhaustion inside the JSON detail and under more than one status, so a
  quota failure would otherwise look like a retryable 429 and burn the whole
  backoff waiting for credits only a purchase can supply.

The standalone CLI (`render_track.py <track>`) skips past a single failed
segment but stops after `MAX_CONSECUTIVE_FAILURES` in a row — a sustained
outage would otherwise spend 152 × (4 × 120 s + 50 s) proving the network is
still down, and a full disk would buy all 152 segments and save none.
`render_program.py` does not need this: it fails the job on the first error.

## Stage 2 — `assemble_track.py <track> "<Title>" <pad.wav> <kw1,kw2> [total_s]`

- Flattens pad energy (per-second RMS correction, clamped ±8 dB)
- Voice submix on a **smooth dB curve**: 0 → +3 → +6 → sink to −14 across deepening, hold through suggestion, +6 return on resurface
- 2 s register-change overlaps so narrator ↔ whisper crossfades
- Carrier auto-scan (300–400 Hz quietest slot) + ±10 Hz notch, then an isochronic bed on a theta→alpha arc at pad_rms −29 dB
- 30 s fade-out, master to −20 dB RMS, soft clip; writes WAV + MP3
- **Track length is bounded by the pad** — see below
- Diagnostics (`HYPNO_SKIP_QA=0`, off in production): per-minute RMS profile, bed-pulse check, faster-whisper transcript of the sunken suggestion layer with keyword hit count. These **print**; they do not gate anything, and the transcript step is skipped with a notice when `faster_whisper` is not installed. The gate that decides whether a track ships is in `render_program.py` — see below.

## The segment cache

Every rendered segment is copied into a shared cache keyed on
`sha256(voice_id, tag, text)`, so a segment is bought from ElevenLabs at most
once no matter how many jobs need it.

This matters because the per-job idempotency above is scoped to the job
directory, and the server mints a fresh one on every POST — so before #9 a
customer-visible retry re-bought the entire program. One transient failure on
segment 150 of 152 discarded ~20 minutes and the whole 17k-22k character spend.

- **Cached on write**, as soon as each segment is treated — not promoted when
  the job succeeds. Promoting on success would cache nothing for the job that
  died at segment 150, which is the case the cache exists for.
- **Content-keyed**, so editing a script misses the cache automatically. There
  is no invalidation step to forget.
- **Location**: `RENDERS/segment-cache/`, overridable with `SEGMENT_CACHE_DIR`.
  The name deliberately does not match the `^job_` pattern the retention sweep
  uses to choose what it may delete.
- **Bounded** by `SEGMENT_CACHE_MAX_BYTES` (default 4 GB — one goal/voice-set
  pair is ~80 MB, all ten ~800 MB). Least-recently-used entries are evicted by
  a sweep that runs *after* the job is marked ready.
- **Never fatal.** A cache that cannot be read, written or swept produces a
  slower render, never a failed one — every render reaching this code has
  already been paid for.

A cached entry is checked for a RIFF header on the way out and discarded if it
is not one: `store()` is atomic so this module cannot create a partial entry,
but nothing else re-validates one, and a corrupt entry would otherwise be served
to every future render for that key. One bad segment in 152 is ~0.7% of a
master, far under the QA gate's dead-air tolerance, so nothing downstream would
notice.

## The delivery QA gate

`render_program.py` opens every finished master and refuses to publish a job
whose audio is not shippable. It runs in production by default — there is no
flag to turn it off — and needs nothing beyond soundfile/numpy.

It runs in the `mastering-qa` stage **before the manifest is written**, so a
rejected job is never listed as deliverable, and its per-segment intermediates
survive for debugging (cleanup sits after the manifest write and is unreachable
on that path). Thresholds live in `qa.py`:

| Check | Threshold | Catches |
|---|---|---|
| WAV RMS | −30 to −12 dB | silence, near-silence, failed normalisation |
| WAV RMS finiteness | NaN / +inf rejected | corrupt audio |
| WAV duration | ≥ 50 % of planned | a badly truncated WAV |
| MP3 size | ≥ 3000 bytes/s | a grossly truncated MP3, without decoding |
| MP3 decoded length | ≥ 98 % of the WAV | any partial MP3 truncation |

Why the audio has to be opened at all: the master normalisation divides by
`(rms + 1e-12)`, so a zero input yields a zero output with no error. Before this
gate existed the only checks were "both files exist" and "the duration is
readable", and an all-silent track passed both.

Two measured facts drive the MP3 numbers, both counter-intuitive:

- **The MP3 encoder is VBR.** Silence costs ~3990 bytes/s, real content ~9100.
  The byte floor therefore has to sit *below* silence, which means it only
  catches gross truncation — a file cut to half its bytes still measures
  4539 bytes/s.
- **MP3 length lies.** For a 780 s track cut to 50 %, `sf.info().duration`
  reports 780.0 s (it reads the Xing header) and `sf.blocks()` yields 780.0 s of
  full-energy audio, repeating content past the real end so even the RMS looks
  normal. Only `SoundFile.read` in a loop stops at the true 390.1 s, which is
  what `measure_audio()` uses. WAV is unaffected — every API agrees there.

The gate does **not** verify that the audio is the *right* audio. A pad-only
render with the voice layer missing normalises to the same −20 dB and passes.

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
