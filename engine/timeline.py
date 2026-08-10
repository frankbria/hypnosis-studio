"""Track duration arithmetic: how long a program is, and whether the pad fits it.

Stdlib only, on purpose — the same reason job_files.py is. assemble_track.py
imports numpy/scipy/soundfile *and does its work at module import time*, so
nothing that lives there is reachable from a test without the whole audio stack
and a real render. This module is where the arithmetic that decides a track's
length lives so it can be tested on its own.

The numbers here are a money path. `voice_end` is the sum of real TTS segment
durations: non-deterministic run to run, and unknowable until every segment of
the track has been bought. The old code assumed it would fit a fixed 960 s pad
and asserted afterwards, which killed the job at the assembly stage with the
entire spend already gone (issue #5). The rule now is: shorten the music outro
to fit the pad, and only refuse when there is not even room for the fade.
"""
import os

# Every offset in the assembler is computed at this rate, so a pad or segment at
# any other rate silently mis-measures the whole timeline. Defined here so the
# pre-spend gate and the assembler cannot disagree about it.
SR = 44100

# The assembler opens on 1.5 s of pad before the first word.
LEAD_IN_S = 1.5

# Preferred music tail after the last word. A target, not a guarantee — it is
# the first thing given up when the pad is tight.
MIN_OUTRO_S = 75.0

# The master fade at the end of every track (assemble_track.py: `fade_n`). This
# is the real floor: below it the fade would chew into voiced audio, so there is
# no graceful degradation left and the job has to fail.
FADE_S = 30.0

# Prompt tags prepended to every segment before it is sent to ElevenLabs. They
# are spoken time, so they count toward the estimate.
SOFT_TAG = "[soft] "
WHISPER_TAG = "[whispering] "

# Characters of tagged script per second of rendered speech, used only to
# project a program length *before* buying it.
#
# Calibration: river track 1 is 6457 tagged characters over 337 s of scripted
# pauses. Working back from the ~40 s of headroom reported in issue #5 implies
# about 12.75 chars/s for eleven_v3 at speed 0.85. The default sits below that
# so a slower-than-expected render is predicted rather than missed.
#
# Not *far* below, though. This projection only warns; the real protection is
# resolve_actual_s, which bounds the program at render time whatever the rate
# turns out to be. Over-tightening it here just makes the gate flag scripts that
# ship fine today — at 11.0 it called river tracks 1 and 3 short-outro when at
# the true rate both get the full 75 s — and a warning that cries wolf is one
# operators learn to skip past.
#
# It stays a knob because the real rate drifts with model, voice and prompt tag,
# and there is no committed render data to calibrate against (pads and renders
# are gitignored). Re-derive it from real manifests when they exist.
DEFAULT_CHARS_PER_SEC = 12.0
CHARS_PER_SEC_ENV = "HYPNO_CHARS_PER_SEC"


def chars_per_sec():
    """The speaking-rate estimate, honouring the env override."""
    raw = os.environ.get(CHARS_PER_SEC_ENV)
    if not raw:
        return DEFAULT_CHARS_PER_SEC
    try:
        rate = float(raw)
    except ValueError:
        raise ValueError(
            f"{CHARS_PER_SEC_ENV} must be a positive number, got {raw!r}")
    if rate <= 0:
        raise ValueError(
            f"{CHARS_PER_SEC_ENV} must be a positive number, got {raw!r}")
    return rate


# estimate_voice_end takes a `chars_per_sec` argument, which shadows the function
# above inside its body; this alias keeps the default reachable from there.
_rate_from_env = chars_per_sec


def resolve_actual_s(total_s, voice_end, pad_s):
    """The whole-second program length to render, bounded by the real pad.

    `total_s` is the target length, `voice_end` where the last word ends, and
    `pad_s` how much pad audio actually exists. The result is the longest whole
    second that is at least the target, prefers `MIN_OUTRO_S` of music after the
    voice, and never exceeds the pad.

    Raises ValueError — not an assert, which `python -O` strips — when the pad
    cannot carry the voice program plus the closing fade.
    """
    # min(ceil(want), floor(pad)) — round the two sides in opposite directions.
    # Rounding the *result* up instead would let a 959.5 s pad land on 960 and
    # overrun the buffer this bound exists to protect, so the pad is floored.
    want_s = float(int(max(float(total_s), voice_end + MIN_OUTRO_S) + 0.999))
    actual_s = min(want_s, float(int(pad_s)))
    if actual_s < voice_end + FADE_S:
        raise ValueError(
            f"pad too short: {pad_s:.1f}s of pad leaves a {actual_s:.1f}s program, "
            f"which cannot carry {voice_end:.1f}s of voice plus the "
            f"{FADE_S:.0f}s fade (needs at least {voice_end + FADE_S:.1f}s)"
        )
    return actual_s


def estimate_voice_end(segments, chars_per_sec=None):
    """Project where the last word lands, without calling ElevenLabs.

    Mirrors the timeline assemble_track.py builds: the program opens at
    `LEAD_IN_S`, each segment runs for its own duration, and the gap that follows
    is `pause_after_s` — doubled through the suggestion phase. `voice_end` is the
    end of the last segment, so that segment's trailing pause is not part of it.

    What makes this an over-estimate is the conservative rate, nothing else. The
    assembler's 2 s register-change overlaps are ignored because they do not move
    `voice_end`: they shift the *first* suggestion and resurface segments earlier
    and leave the positions after them alone, so the last segment only moves when
    the resurface phase is a single segment — and then only earlier.
    """
    rate = chars_per_sec if chars_per_sec is not None else _rate_from_env()
    if rate <= 0:
        raise ValueError(f"chars_per_sec must be positive, got {rate!r}")

    chars = 0
    pauses = []
    for seg in segments:
        suggestion = seg.get("phase") == "suggestion"
        tag = WHISPER_TAG if suggestion else SOFT_TAG
        chars += len(tag) + len(seg["text"])
        pauses.append(float(seg["pause_after_s"]) * (2 if suggestion else 1))

    return LEAD_IN_S + chars / rate + sum(pauses[:-1])


def monotonic(values):
    """The series, with any backwards step flattened to the running maximum.

    np.interp does not check that its breakpoint times increase — handed a
    series that goes backwards it returns a garbage curve with no error at all,
    which in this pipeline means bad audio nobody notices. The assembler's
    trajectories are built from phase boundaries and from ACTUAL_S, and a program
    clamped tight against the pad puts the ACTUAL_S-relative tail *behind* the
    resurface breakpoints. Run every breakpoint series through this first.

    IMPORTANT for anyone adding a breakpoint: flattening is only silent-safe
    because every pair that can currently invert carries the *same* y-value —
    `(RES_START + 25, 6.0)` against `(voice_end, 6.0)` in GAIN_BP, and
    `(ACTUAL_S - 60, 10.0)` against `(RES_START + 10, 10.0)` in TRAJ. Collapsing
    those to a duplicate x is a flat segment, which np.interp handles cleanly. A
    new breakpoint that can invert against a neighbour with a *different* y would
    instead collapse to a step discontinuity — an audible click, again with no
    error. Keep inverting pairs equal-valued, or bound the new breakpoint so it
    cannot cross its neighbour in the first place.
    """
    out = []
    running = None
    for value in values:
        value = float(value)
        running = value if running is None else max(running, value)
        out.append(running)
    return out
