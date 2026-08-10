"""Shippability checks on a finished master.

Stdlib only, on purpose — same reason as job_files.py and timeline.py. The
decision logic has to be testable without numpy/soundfile; the caller does the
audio I/O and hands the measurements in.

Before this existed, the entire production check on a deliverable was "both
files exist" and "the WAV duration is readable". Neither read a sample, so an
all-silent track shipped clean — and silence is produced *silently*, because the
master normalisation divides by `(rms + 1e-12)`: zero in, zero out, no error
anywhere (issue #6).

Thresholds are measured, not guessed. See tasks/issue-6-plan.md for the table.
Two measurements drive the numbers here:

  * libsndfile's MP3 encoder is **VBR**. Silence costs ~3990 bytes/s, real
    content ~9100. A byte floor set between those would reject legitimately
    quiet audio, so the floor sits below silence and the RMS check covers
    silence instead. The two guards deliberately catch different failures.
  * MP3 duration is read from the Xing header, not the frames. A file truncated
    to 20% still reports its full length, so duration cannot detect truncation
    and size is the only cheap signal.
"""
import math

# The master is normalised to -20 dB RMS as its last-but-one step, so this is a
# sanity band around a value fixed by construction rather than a tolerance on
# something that naturally varies.
MIN_RMS_DB = -30.0
MAX_RMS_DB = -12.0

# Below what silence itself encodes to (3990 B/s measured), so this cannot
# false-positive on quiet audio. Normal masters run ~9000 B/s.
#
# This only catches gross truncation: because the floor has to sit under
# silence, a file cut to half its bytes still clears it (4539 B/s measured).
# MIN_MP3_DURATION_FRACTION is the real truncation check; this one is a cheap
# sanity bound that needs no decode.
MIN_MP3_BYTES_PER_SEC = 3000

# How much of the WAV's length the MP3 must actually decode to. The MP3 is a
# re-encode of the same master, so anything short means a partial write.
#
# Header duration cannot do this job — a file cut to 10% still reports its full
# length, because MP3 duration comes from the Xing header rather than the
# frames. Only a real decode reveals the truth (measured: 90% of bytes decodes
# to 702 s of a 780 s track, 10% to 78 s).
MIN_MP3_DURATION_FRACTION = 0.98

# #5 lets the assembler clamp a long voice program against the pad, so a track
# can legitimately finish under its planned length. This only catches gross
# truncation, not that.
MIN_DURATION_FRACTION = 0.5


def check_master(label, rms_db, mp3_bytes, duration_s, planned_s=None,
                 mp3_decoded_s=None):
    """Problems that make this track unshippable, as readable strings.

    Empty list means ship it. Every problem is reported rather than the first,
    so an operator fixing one does not discover the next on the following run.
    """
    problems = []

    if duration_s is None or not math.isfinite(duration_s) or duration_s <= 0:
        problems.append(
            f"{label}: master duration is {duration_s}, so there is no audio to ship")
        return problems  # every other check divides by duration

    if planned_s and duration_s < planned_s * MIN_DURATION_FRACTION:
        problems.append(
            f"{label}: master is {duration_s:.0f}s against a planned {planned_s:.0f}s "
            f"(under {MIN_DURATION_FRACTION:.0%}) — the WAV looks truncated")

    # NaN and +inf first: `nan < MIN` and `nan > MAX` are both False, so a plain
    # range check waves a NaN master straight through.
    #
    # -inf is deliberately *not* caught here. It is what an all-zero master
    # measures, and `-inf < MIN_RMS_DB` is True, so it falls into the silence
    # branch below and gets the error an operator can act on. Reporting the most
    # likely failure as "unreadable or NaN" would send them looking in the wrong
    # place.
    if rms_db is None or math.isnan(rms_db) or rms_db == math.inf:
        problems.append(
            f"{label}: master RMS is {rms_db}, not a usable level — the audio is "
            f"unreadable or contains NaN/Inf samples")
    elif rms_db < MIN_RMS_DB:
        problems.append(
            f"{label}: master RMS is {rms_db:.1f} dB, below the {MIN_RMS_DB:.0f} dB "
            f"floor — the track is silent or near-silent")
    elif rms_db > MAX_RMS_DB:
        problems.append(
            f"{label}: master RMS is {rms_db:.1f} dB, above the {MAX_RMS_DB:.0f} dB "
            f"ceiling — the master did not normalise")

    bytes_per_sec = mp3_bytes / duration_s
    if bytes_per_sec < MIN_MP3_BYTES_PER_SEC:
        problems.append(
            f"{label}: mp3 is {mp3_bytes} bytes for {duration_s:.0f}s "
            f"({bytes_per_sec:.0f} B/s, floor {MIN_MP3_BYTES_PER_SEC}) — "
            f"the file looks truncated")

    if mp3_decoded_s is not None:
        if not math.isfinite(mp3_decoded_s) or mp3_decoded_s <= 0:
            problems.append(
                f"{label}: mp3 decodes to no audio ({mp3_decoded_s})")
        elif mp3_decoded_s < duration_s * MIN_MP3_DURATION_FRACTION:
            problems.append(
                f"{label}: mp3 decodes to {mp3_decoded_s:.0f}s against a "
                f"{duration_s:.0f}s master — the mp3 is truncated "
                f"({mp3_decoded_s / duration_s:.0%} of the track)")

    return problems
