# Issue #6 — [P0.6] Add a real QA gate on the delivered audio

## Root cause

In production (`HYPNO_SKIP_QA=1`) the entire check on a deliverable is: both
files exist, and the WAV duration is readable (`render_program.py:287,290`).
Neither reads a sample. An all-silent track passes both, and silence is produced
*silently* — the master normalisation is
`mix *= 10**(-20/20) / (sqrt(mean(mix**2)) + 1e-12)`, so a zero input gives a
zero output with no error.

QA gates nothing even when it runs: every check is a bare `print()`, the keyword
hit count is never thresholded, and the masters are written at `:206-207`
*before* the QA block at `:212`. And it cannot be turned on in production —
`faster_whisper` is not in the venv, so `HYPNO_SKIP_QA=0` raises `ImportError`
and fails a job whose masters are fine.

## Measurements taken first

Thresholds are derived from real encoder behaviour, not guessed:

| Content (60 s, mono 44.1 kHz) | MP3 bytes/s | kbps | WAV RMS |
|---|---|---|---|
| silence | 3990 | 32 | −240 dB |
| quiet 220 Hz tone | 3998 | 32 | −43 dB |
| white noise | 9103 | 73 | −10.5 dB |
| music-ish | 9037 | 72 | −11.7 dB |

Two things follow:

1. **The encoder is VBR.** Silence costs 3990 B/s, real content ~9100 B/s. A
   byte floor between those would reject legitimately quiet audio; below 3990 it
   cannot false-positive at all.
2. **MP3 duration cannot detect truncation — via most APIs.** This one took
   three attempts to get right, and the wrong answers were all plausible:

   | Reading a 780 s MP3 cut to 50 % of its bytes | Reports |
   |---|---|
   | `sf.info(path).duration` (header) | 780.0 s — the Xing header, not the frames |
   | `sf.blocks(path)` | 780.0 s, **and normal RMS** — it repeats content past the real end |
   | `sf.read(path)` / chunked `SoundFile.read` | **390.1 s** — the truth |

   `sf.blocks` returning full-length, full-energy audio for a half-missing file
   is the dangerous one: a check built on it looks like it works and never
   fires. `measure_audio` therefore uses `SoundFile.read` in a loop.

   For **WAV** all four agree (a truncated WAV reports its true 390.0 s
   everywhere), so this is an MP3-container problem, not a general one.

Real masters are pinned to −20.0 dB RMS by the normalisation step, so the
loudness window is a sanity band around a value fixed by construction.

## Changes

### 1. New `engine/qa.py` (stdlib only)

Same testability rationale as `job_files.py` and `timeline.py`: the decision
logic must be reachable in a test without numpy/soundfile.

- `MIN_RMS_DB = -30.0`, `MAX_RMS_DB = -12.0` — ±10 dB around the −20 dB the
  master is normalised to.
- `MIN_MP3_BYTES_PER_SEC = 3000` — under what silence itself encodes to (3990),
  so it cannot false-positive; normal masters run ~9000. Because the floor has
  to sit under silence, it only catches gross truncation: a file cut to half its
  bytes measures 4539 B/s and clears it.
- `MIN_MP3_DURATION_FRACTION = 0.98` — the real truncation check. The MP3 is a
  re-encode of the same master, so it must decode to (almost) the WAV's length.
  Measured against a 780 s track: 90 % of bytes → 702 s, 50 % → 390 s, 25 % →
  195 s, 10 % → 78 s. All rejected; the 90 % case clears the byte floor easily.
- `MIN_DURATION_FRACTION = 0.5` — a WAV far shorter than planned is truncated.
- `check_master(label, rms_db, mp3_bytes, duration_s, planned_s)` returning a
  list of human-readable problems.

**NaN is handled explicitly.** A NaN master would make both `rms_db < MIN` and
`rms_db > MAX` false and sail through a naive range check, so finiteness is
tested before the comparisons.

### 2. `engine/render_program.py`

- `master_rms_db(wav_path)` — exact RMS, streamed via `sf.blocks` so a 780 s
  master never lands in memory whole (the prod box is 4 GB and the assembler is
  already carefully chunked for it).
- Run `check_master` for every track in the `mastering-qa` stage, **before the
  manifest is written**. Any problem raises, which means: no manifest, job goes
  to `failed`, and the intermediates survive for debugging — `prune_intermediates`
  sits after the manifest write and is therefore unreachable on this path.

### 3. `engine/assemble_track.py`

Guard the `faster_whisper` import so `HYPNO_SKIP_QA=0` degrades to "transcript
check skipped" instead of failing a job whose masters are correct.

### 4. Tests — `engine/tests/test_qa.py`, written first

Plus render_program integration tests driving a real silent WAV through the gate.

## Acceptance criteria → coverage

| Criterion | Covered by |
|---|---|
| Each track sampled; rejected on RMS window or implausibly small MP3 | `check_master` + call site before the manifest write |
| A deliberately silenced master fails with a clear per-track error | integration test writing a real silent master |
| Gate runs in production by default, no `faster_whisper` | pure soundfile/numpy; no env flag guards it |
| A passing job is unaffected | integration test on a healthy master |

## Decisions taken autonomously

1. **Thresholds derived from measurement** (table above) rather than round
   numbers. The VBR discovery moved the byte floor by ~3×.
2. **The MP3 check is on decoded duration as well as size.** The issue asks only
   for "implausibly small", which the byte floor delivers — but measurement
   showed that floor is blind between roughly 33 % and 100 % truncation, because
   it must sit under what silence costs. A real decode closes that gap exactly
   for ~0.4 s per track against a 15-20 minute render, so it was worth taking.
   Both checks are kept: the byte floor needs no decode and covers a file that
   fails to open at all.
3. **A WAV duration floor is included** even though the issue lists only silence,
   dead mix and truncated MP3. The MP3 and WAV are separate writes, so a disk-full
   between them truncates one and not the other; guarding only the MP3 would leave
   the symmetric hole open. Threshold kept loose (50 % of planned) because #5's
   clamp legitimately shortens a track.
4. **The `faster_whisper` transcript block stays diagnostic, not gating.**
   Criterion 3 explicitly wants a gate that does not need it, and whisper
   transcription of deliberately-whispered, −14 dB audio is too unreliable to
   fail a paid render on. It is made non-crashing so it can actually be used in
   development, which is the problem the issue names.
