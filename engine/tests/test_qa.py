"""Tests for qa — the gate that decides whether a rendered track is shippable.

Stdlib only, deliberately, like job_files.py and timeline.py: the decision logic
has to be reachable without numpy/soundfile so it can be tested at all.

What makes this worth gating: in production the only checks on a deliverable
were "both files exist" and "the WAV duration is readable". Neither reads a
sample, and an all-silent master passes both — silently, because the master
normalisation divides by `(rms + 1e-12)`, so zero in gives zero out with no
error anywhere (issue #6).

Thresholds here are derived from measured encoder behaviour, recorded in
tasks/issue-6-plan.md. The two that matter: libsndfile's MP3 encoder is VBR
(silence 3990 B/s, real content ~9100 B/s), and MP3 duration is header-derived
so it cannot detect truncation.
"""
import os
import sys

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ENGINE)

import qa  # noqa: E402

# A healthy master: normalised to -20 dB RMS, ~9000 B/s of MP3.
GOOD = dict(label="river_track1", rms_db=-20.0, mp3_bytes=7_000_000,
            duration_s=780.0, planned_s=780.0)


def check(**overrides):
    return qa.check_master(**{**GOOD, **overrides})


# --------------------------------------------------------------------------
# The healthy case must stay silent
# --------------------------------------------------------------------------

def test_a_healthy_master_reports_nothing():
    assert check() == []


@pytest.mark.parametrize("rms_db", [-30.0, -25.0, -20.0, -15.0, -12.0])
def test_the_whole_sane_window_passes(rms_db):
    """The master is pinned to -20 dB by construction; the window is a sanity
    band around that, not a tight tolerance. Nothing inside it may fail."""
    assert check(rms_db=rms_db) == []


def test_a_shortened_but_legitimate_track_passes():
    """#5 lets the assembler clamp a long program against the pad, so a track
    can legitimately come in under its planned length."""
    assert check(duration_s=700.0, planned_s=780.0) == []


# --------------------------------------------------------------------------
# Silence — the failure this issue exists for
# --------------------------------------------------------------------------

def test_a_silent_master_is_rejected():
    """A truly zero master measures about -240 dB with the epsilon in place."""
    problems = check(rms_db=-240.0)
    assert problems, "a silent master must not ship"
    assert "river_track1" in problems[0], "the error must name the track"


def test_near_silence_is_rejected():
    assert check(rms_db=-45.0)


def test_the_silence_error_is_readable():
    """Whoever reads this is looking at a failed paid render and needs to know
    what was wrong without re-running anything."""
    msg = check(rms_db=-240.0)[0]
    assert "-240" in msg or "240" in msg, msg
    assert "silent" in msg.lower(), msg


def test_a_runaway_master_is_rejected():
    assert check(rms_db=-3.0)


# --------------------------------------------------------------------------
# NaN — the case a naive range check waves through
# --------------------------------------------------------------------------

def test_a_nan_master_is_rejected():
    """`nan < MIN` and `nan > MAX` are both False, so a plain range check passes
    a NaN master. Finiteness has to be tested before the comparisons."""
    assert check(rms_db=float("nan")), "NaN must not pass the range check"


def test_an_infinite_master_is_rejected():
    assert check(rms_db=float("-inf"))
    assert check(rms_db=float("inf"))


def test_negative_infinity_reads_as_silence_not_as_corruption():
    """-inf is exactly what an all-zero master measures, and silence is the most
    likely reason a track fails this gate. Reporting it as "unreadable or NaN"
    would point whoever is debugging a failed paid render at the wrong thing."""
    msg = check(rms_db=float("-inf"))[0]
    assert "silent" in msg.lower(), msg
    assert "nan" not in msg.lower(), msg


def test_positive_infinity_still_reads_as_corruption():
    msg = check(rms_db=float("inf"))[0]
    assert "unreadable" in msg.lower() or "nan" in msg.lower(), msg


def test_a_missing_rms_is_rejected():
    """master_rms_db returns None for an unreadable/empty file."""
    assert check(rms_db=None)


# --------------------------------------------------------------------------
# MP3 truncation
# --------------------------------------------------------------------------

def test_a_truncated_mp3_is_rejected():
    """A 780 s master truncated to a few hundred KB."""
    problems = check(mp3_bytes=200_000)
    assert problems
    assert "river_track1" in problems[0]


def test_silence_encodes_above_the_byte_floor():
    """The floor sits below what silence itself costs (3990 B/s measured), so it
    can never reject legitimately quiet audio. Silence is caught by the RMS
    check instead — these two guards cover different failures on purpose."""
    silent_mp3 = int(3990 * 780)
    assert check(mp3_bytes=silent_mp3) == []


def test_the_byte_floor_is_below_measured_silence():
    """Pins the reasoning above: if someone raises this floor past 3990 B/s the
    gate starts failing quiet masters, which is a regression."""
    assert qa.MIN_MP3_BYTES_PER_SEC < 3990


def test_a_normal_master_has_wide_margin_over_the_floor():
    """Measured content runs ~9000 B/s against a 3000 floor."""
    assert 9000 / qa.MIN_MP3_BYTES_PER_SEC >= 2.5


def test_the_truncation_error_names_the_sizes():
    msg = [p for p in check(mp3_bytes=200_000) if "mp3" in p.lower()][0]
    assert "200000" in msg.replace(",", "") or "200,000" in msg, msg


# --------------------------------------------------------------------------
# WAV truncation — the symmetric hole
# --------------------------------------------------------------------------

def test_a_badly_truncated_wav_is_rejected():
    """The WAV and MP3 are separate writes, so a disk-full between them
    truncates one and not the other."""
    assert check(duration_s=100.0, planned_s=780.0)


def test_a_zero_length_track_is_rejected():
    assert check(duration_s=0.0)


def test_a_negative_duration_is_rejected():
    assert check(duration_s=-1.0)


# --------------------------------------------------------------------------
# Multiple problems
# --------------------------------------------------------------------------

def test_every_problem_is_reported_not_just_the_first():
    """An operator fixing one failure should not discover the next one only on
    the following run."""
    problems = check(rms_db=-240.0, mp3_bytes=1000)
    assert len(problems) >= 2, problems


def test_problems_are_strings_naming_the_track():
    for p in check(rms_db=-240.0, mp3_bytes=1000):
        assert isinstance(p, str)
        assert "river_track1" in p


# --------------------------------------------------------------------------
# MP3 truncation, exactly — the byte floor's blind spot
# --------------------------------------------------------------------------

def test_a_half_truncated_mp3_clears_the_byte_floor():
    """Documents why the decoded-duration check has to exist.

    The byte floor must sit under what silence costs (3990 B/s), so a file cut
    to half its bytes — 4539 B/s measured — sails past it.
    """
    assert check(mp3_bytes=int(4539 * 780), mp3_decoded_s=780.0) == []


def test_a_half_truncated_mp3_is_caught_by_decoded_duration():
    """Same file, now with what it really decodes to."""
    problems = check(mp3_bytes=int(4539 * 780), mp3_decoded_s=390.1)
    assert problems, "a half-length mp3 must not ship"
    assert "truncated" in problems[0].lower()


@pytest.mark.parametrize("decoded_s", [702.1, 390.1, 194.9, 77.8])
def test_every_measured_truncation_level_is_caught(decoded_s):
    """Real decode lengths measured from a 780 s master cut to 90/50/25/10% of
    its bytes. The mildest of these clears the byte floor comfortably."""
    assert check(mp3_decoded_s=decoded_s), f"{decoded_s}s should be rejected"


def test_a_full_length_mp3_passes():
    assert check(mp3_decoded_s=780.0) == []


def test_encoder_padding_does_not_trip_the_check():
    """MP3 round-trips are not sample-exact; a fraction of a percent short is
    normal and must not fail a good render."""
    assert check(mp3_decoded_s=780.0 * 0.995) == []


def test_decoded_duration_is_optional():
    """Callers that cannot decode still get every other check."""
    assert check(mp3_decoded_s=None) == []
    assert check(mp3_decoded_s=None, rms_db=-240.0)


def test_an_mp3_that_decodes_to_nothing_is_rejected():
    assert check(mp3_decoded_s=0.0)


def test_the_truncation_error_reports_the_shortfall():
    msg = [p for p in check(mp3_decoded_s=390.1) if "mp3" in p.lower()][0]
    assert "390" in msg and "780" in msg, msg
    assert "50%" in msg, msg
