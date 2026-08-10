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
# deliberately — a slower assumed rate predicts a *longer* program, so the
# dry-run gate errs toward warning rather than toward silently overrunning.
#
# It stays a knob because the real rate drifts with model, voice and prompt tag,
# and there is no committed render data to calibrate against (pads and renders
# are gitignored). Re-derive it from real manifests when they exist.
DEFAULT_CHARS_PER_SEC = 11.0
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
    want_s = float(int(max(float(total_s), voice_end + MIN_OUTRO_S) + 0.999))
    # Ceil first, clamp second. Clamping before that rounding would let a 959.5 s
    # pad round back up to 960 and overrun the buffer this bound exists to
    # protect, so the pad is floored to a whole second rather than the result.
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

    The 2 s register-change overlaps the assembler applies are ignored; they only
    ever pull segments earlier, so ignoring them keeps this an over-estimate.
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
    """
    out = []
    running = None
    for value in values:
        value = float(value)
        running = value if running is None else max(running, value)
        out.append(running)
    return out
