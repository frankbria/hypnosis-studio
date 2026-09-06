"""Tests for timeline — the duration math that decides how long a track is.

Stdlib only, deliberately, for the same reason job_files.py is: assemble_track.py
imports numpy/scipy/soundfile and does its work at module level, so nothing that
lives there can be imported in a test environment at all. Pulling the arithmetic
into its own module is what makes it reachable.

The behaviour under test is a money path. `voice_end` is the sum of real TTS
durations, so it is unknowable until every segment of the track has been paid
for. Getting the bound wrong means the job dies at assembly with the whole spend
already gone (issue #5).
"""
import json
import glob
import os
import sys

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ENGINE)

import timeline  # noqa: E402

SR = 44100


# --------------------------------------------------------------------------
# resolve_actual_s — the clamp
# --------------------------------------------------------------------------

def test_short_program_is_unchanged_by_the_clamp():
    """The common case must behave exactly as it did before the fix.

    780 s requested, a short voice program and a 960 s pad: nothing is
    constrained, so the old formula's answer stands.
    """
    assert timeline.resolve_actual_s(total_s=780, voice_end=600.0, pad_s=960.0) == 780.0


def test_voice_longer_than_target_extends_up_to_the_pad():
    """A voice program past TOTAL_S still gets its full minimum outro when it fits."""
    # 800 + 75 = 875, comfortably inside a 960 s pad.
    assert timeline.resolve_actual_s(total_s=780, voice_end=800.0, pad_s=960.0) == 875.0


def test_outro_shortens_instead_of_failing():
    """The headline behaviour: degrade the music outro, do not kill the job.

    A 900 s voice program wants 975 s of program. The pad has 960 s. Before the
    fix this raised after the entire TTS spend; now it clamps and the customer
    gets a 60 s outro instead of nothing.
    """
    actual = timeline.resolve_actual_s(total_s=780, voice_end=900.0, pad_s=960.0)
    assert actual == 960.0
    assert actual - 900.0 == 60.0  # outro degraded from 75 s, not failed


def test_clamp_never_exceeds_the_pad_on_a_fractional_pad():
    """Ceil-then-clamp ordering, not clamp-then-ceil.

    The desired length is rounded up (`int(x + 0.999)`). Clamping before that
    rounding lets a 959.5 s pad produce ACTUAL_S = 960 — back over the pad, which
    is the exact overflow this issue is about. The pad must be floored.
    """
    actual = timeline.resolve_actual_s(total_s=780, voice_end=900.0, pad_s=959.5)
    assert actual <= 959.5
    assert actual == 959.0


@pytest.mark.parametrize("pad_s", [960.0, 959.9, 900.0, 800.5, 700.0])
def test_result_always_fits_inside_the_pad(pad_s):
    """Whatever else happens, the returned length must be sliceable from the pad."""
    actual = timeline.resolve_actual_s(total_s=780, voice_end=650.0, pad_s=pad_s)
    assert actual <= pad_s
    assert int(actual * SR) <= int(pad_s * SR)


# --------------------------------------------------------------------------
# resolve_actual_s — the abort
# --------------------------------------------------------------------------

def test_aborts_when_the_pad_cannot_carry_voice_plus_fade():
    """Below voice + 30 s there is not even room for the fade, so there is no
    graceful degradation left — this one has to fail."""
    with pytest.raises(ValueError):
        timeline.resolve_actual_s(total_s=780, voice_end=950.0, pad_s=960.0)


def test_abort_is_a_raise_not_an_assert():
    """`assert` is stripped under `python -O`, which would turn this guard into a
    silent buffer overflow. It must be a real exception type."""
    with pytest.raises(ValueError) as exc:
        timeline.resolve_actual_s(total_s=780, voice_end=950.0, pad_s=960.0)
    assert not isinstance(exc.value, AssertionError)


def test_abort_message_names_both_durations():
    """The operator has to be able to tell which side was too big without
    re-running anything — the spend is already gone by the time this fires."""
    with pytest.raises(ValueError) as exc:
        timeline.resolve_actual_s(total_s=780, voice_end=950.0, pad_s=960.0)
    msg = str(exc.value)
    assert "960" in msg, f"pad length missing from message: {msg}"
    assert "950" in msg, f"voice length missing from message: {msg}"
    assert "30" in msg, f"fade length missing from message: {msg}"


def test_exactly_enough_room_for_the_fade_is_accepted():
    """The boundary is inclusive: voice + fade exactly equal to the pad is fine."""
    assert timeline.resolve_actual_s(total_s=780, voice_end=930.0, pad_s=960.0) == 960.0


# --------------------------------------------------------------------------
# estimate_voice_end — the dry-run projection
# --------------------------------------------------------------------------

def reference_voice_end(segments, rate):
    """Independent restatement of assemble_track.py's timeline arithmetic.

    assemble_track builds it as: t starts at 1.5; each segment occupies
    [t, t+dur]; then t advances by dur + pause, where the pause is doubled for
    suggestion segments. voice_end is the *end of the last segment*, so the last
    segment's trailing pause is not part of it.
    """
    t = 1.5
    ends = []
    for seg in segments:
        tag = "[whispering] " if seg.get("phase") == "suggestion" else "[soft] "
        dur = len(tag + seg["text"]) / rate
        ends.append(t + dur)
        pause = seg["pause_after_s"] * (2 if seg.get("phase") == "suggestion" else 1)
        t += dur + pause
    return ends[-1]


def test_estimate_matches_the_assembler_timeline():
    segments = [
        {"id": "S01", "text": "a" * 100, "pause_after_s": 2.0, "phase": "induction"},
        {"id": "S02", "text": "b" * 200, "pause_after_s": 3.0, "phase": "suggestion"},
        {"id": "S03", "text": "c" * 50, "pause_after_s": 9.0, "phase": "resurface"},
    ]
    got = timeline.estimate_voice_end(segments, chars_per_sec=10.0)
    assert got == pytest.approx(reference_voice_end(segments, 10.0))


def test_estimate_doubles_suggestion_pauses():
    """The assembler doubles pause_after_s in the suggestion phase; an estimate
    that misses this under-predicts the program by minutes."""
    base = {"text": "x" * 10, "pause_after_s": 10.0}
    quiet = [dict(base, id="a", phase="induction"), dict(base, id="b", phase="induction")]
    loud = [dict(base, id="a", phase="suggestion"), dict(base, id="b", phase="induction")]
    # Only the first segment's pause counts (the last one's is dropped), so the
    # pause contributes exactly one doubling: +10 s. Flipping that segment to the
    # suggestion phase also swaps its prompt tag, which is longer and therefore
    # more spoken time — both effects belong in the estimate.
    tag_delta = (len(timeline.WHISPER_TAG) - len(timeline.SOFT_TAG)) / 10.0
    assert timeline.estimate_voice_end(loud, 10.0) - \
           timeline.estimate_voice_end(quiet, 10.0) == pytest.approx(10.0 + tag_delta)


def test_estimate_excludes_the_trailing_pause():
    """voice_end is where the audio stops, not where the last pause ends."""
    segs = [{"id": "a", "text": "x" * 10, "pause_after_s": 60.0, "phase": "induction"}]
    assert timeline.estimate_voice_end(segs, 10.0) == pytest.approx(1.5 + (10 + 7) / 10.0)


def test_estimate_counts_the_prompt_tag():
    """The tag is sent to ElevenLabs and is spoken time too — `[whispering] ` is
    13 characters that the naive len(text) estimate would miss."""
    segs = [{"id": "a", "text": "hello", "pause_after_s": 0.0, "phase": "suggestion"}]
    expected = 1.5 + len("[whispering] hello") / 10.0
    assert timeline.estimate_voice_end(segs, 10.0) == pytest.approx(expected)


def test_estimate_rejects_a_nonsense_rate():
    segs = [{"id": "a", "text": "x", "pause_after_s": 0.0, "phase": "induction"}]
    with pytest.raises(ValueError):
        timeline.estimate_voice_end(segs, chars_per_sec=0.0)


# --------------------------------------------------------------------------
# The real scripts — this is what actually ships
# --------------------------------------------------------------------------

def load_script(name):
    with open(os.path.join(ENGINE, "scripts", f"{name}_tts_segments.json"),
              encoding="utf-8") as f:
        return json.load(f)["segments"]


def test_river_track1_is_the_tight_one():
    """The issue names river as the longest program. If some other script
    overtakes it, the headroom analysis behind DEFAULT_CHARS_PER_SEC is stale."""
    def projected(path):
        with open(path, encoding="utf-8") as f:
            return timeline.estimate_voice_end(json.load(f)["segments"], 10.0)

    longest = max(
        glob.glob(os.path.join(ENGINE, "scripts", "*_tts_segments.json")),
        key=projected,
    )
    assert os.path.basename(longest) == "river_tts_segments.json"


def test_every_shipped_script_fits_its_pad_at_the_default_rate():
    """A regression fence around the scripts themselves.

    Every committed script must still leave room for the fade inside the 960 s
    pad at the default estimate. If someone lengthens a script past this, the
    dry-run gate would start rejecting that goal in production — better to fail
    here, in CI, than at purchase time.
    """
    pad_s = 960.0
    for path in sorted(glob.glob(os.path.join(ENGINE, "scripts", "*_tts_segments.json"))):
        with open(path, encoding="utf-8") as f:
            segments = json.load(f)["segments"]
        est = timeline.estimate_voice_end(segments)
        assert est + timeline.FADE_S <= pad_s, (
            f"{os.path.basename(path)} projects {est:.0f}s of voice; "
            f"a {pad_s:.0f}s pad cannot also carry the {timeline.FADE_S:.0f}s fade"
        )


def test_default_rate_is_conservative_relative_to_the_measured_one():
    """DEFAULT_CHARS_PER_SEC must under-predict speed (over-predict duration).

    The issue's "~40 s of headroom" for river track 1 implies ~12.75 chars/s.
    The default has to sit below that or the dry-run gate is not conservative.
    """
    assert timeline.DEFAULT_CHARS_PER_SEC < 12.75


# --------------------------------------------------------------------------
# monotonic — the np.interp guard
# --------------------------------------------------------------------------

def test_monotonic_leaves_an_increasing_series_alone():
    assert timeline.monotonic([0.0, 30.0, 200.0, 900.0]) == [0.0, 30.0, 200.0, 900.0]


def test_monotonic_flattens_a_backwards_step():
    """np.interp does not validate that its breakpoints increase — it silently
    returns a garbage curve. A clamped ACTUAL_S pulls the tail breakpoints
    backwards past the resurface ones, which is exactly how that happens here."""
    assert timeline.monotonic([0.0, 500.0, 400.0, 450.0]) == [0.0, 500.0, 500.0, 500.0]


def test_monotonic_result_is_never_decreasing():
    series = timeline.monotonic([0, 30, 700, 690, 660, 655, 900, 100])
    assert all(b >= a for a, b in zip(series, series[1:]))


def test_clamped_track_still_yields_usable_breakpoints():
    """End-to-end shape check for the failure this issue creates.

    With ACTUAL_S clamped hard against the pad, the assembler's TRAJ tail
    (ACTUAL_S - 60, ACTUAL_S - 5) lands behind the resurface breakpoint. Guarded,
    the series stays sortable; unguarded it would feed np.interp backwards.
    """
    # A 930 s voice program clamped to a 960 s pad: the resurface phase runs to
    # the very end, so RES_START + 10 (910) lands *after* ACTUAL_S - 60 (900).
    actual_s, res_start, sug_end = 960.0, 900.0, 890.0
    raw = [0, 30, 300, 600, 780, sug_end, res_start + 10, actual_s - 60, actual_s - 5]
    assert raw != sorted(raw), "fixture no longer reproduces the backwards case"
    guarded = timeline.monotonic(raw)
    assert guarded == sorted(guarded)


# --------------------------------------------------------------------------
# The rate knob
# --------------------------------------------------------------------------

def test_rate_defaults_when_env_is_unset(monkeypatch):
    monkeypatch.delenv("HYPNO_CHARS_PER_SEC", raising=False)
    assert timeline.chars_per_sec() == timeline.DEFAULT_CHARS_PER_SEC


def test_rate_reads_the_env_override(monkeypatch):
    monkeypatch.setenv("HYPNO_CHARS_PER_SEC", "13.5")
    assert timeline.chars_per_sec() == 13.5


@pytest.mark.parametrize("bad", ["0", "-3", "fast", "1e-9x"])
def test_bad_rate_override_is_rejected_not_silently_ignored(monkeypatch, bad):
    """Silently falling back would make a mis-set knob look like it worked."""
    monkeypatch.setenv("HYPNO_CHARS_PER_SEC", bad)
    with pytest.raises(ValueError):
        timeline.chars_per_sec()


def test_empty_rate_override_falls_back_to_the_default(monkeypatch):
    """An empty value is 'unset', not 'invalid' — exporting an unset shell
    variable is a normal thing to do and should not fail a render."""
    monkeypatch.setenv("HYPNO_CHARS_PER_SEC", "")
    assert timeline.chars_per_sec() == timeline.DEFAULT_CHARS_PER_SEC


# --------------------------------------------------------------------------
# project_positions / phase_span — locating a phase, for #60's samples
# --------------------------------------------------------------------------
#
# Cutting a two-minute sample means answering "where in this 13-minute master
# does the whisper layer actually exist?". The whisper voice is used for, and
# only for, the suggestion phase (render_program.py), so the answer is a phase
# span — and the only thing that knows the shape of the timeline is this module.

def test_projection_ends_where_the_estimate_says_it_does():
    """One timeline, not two. The last segment's end IS voice_end.

    If these ever disagree, the sample cutter is locating phases on a timeline
    the pre-spend gate does not believe in — and the two would drift silently,
    because nothing else compares them.
    """
    segments = [
        {"id": "S01", "text": "a" * 100, "pause_after_s": 2.0, "phase": "induction"},
        {"id": "S02", "text": "b" * 200, "pause_after_s": 3.0, "phase": "suggestion"},
        {"id": "S03", "text": "c" * 50, "pause_after_s": 9.0, "phase": "resurface"},
    ]
    positions = timeline.project_positions(segments, chars_per_sec=10.0)
    assert positions[-1].end == pytest.approx(
        timeline.estimate_voice_end(segments, chars_per_sec=10.0))


def test_projection_opens_on_the_lead_in():
    segs = [{"id": "a", "text": "x" * 10, "pause_after_s": 1.0, "phase": "induction"}]
    assert timeline.project_positions(segs, 10.0)[0].start == pytest.approx(
        timeline.LEAD_IN_S)


def test_projection_carries_the_id_and_phase_through():
    segs = [{"id": "S07", "text": "x", "pause_after_s": 0.0, "phase": "deepening"}]
    (only,) = timeline.project_positions(segs, 10.0)
    assert (only.id, only.phase) == ("S07", "deepening")


def test_projection_advances_by_the_doubled_suggestion_pause():
    """Same rule as the estimate, checked where it is visible: the *gap* between
    two segments, which a summed total cannot show."""
    segs = [
        {"id": "a", "text": "x" * 10, "pause_after_s": 10.0, "phase": "suggestion"},
        {"id": "b", "text": "x" * 10, "pause_after_s": 10.0, "phase": "induction"},
    ]
    first, second = timeline.project_positions(segs, 10.0)
    assert second.start - first.end == pytest.approx(20.0)


def test_projection_of_nothing_is_nothing():
    assert timeline.project_positions([], 10.0) == []


def test_projection_rejects_a_nonsense_rate():
    segs = [{"id": "a", "text": "x", "pause_after_s": 0.0, "phase": "induction"}]
    with pytest.raises(ValueError):
        timeline.project_positions(segs, chars_per_sec=0.0)


def test_phase_span_covers_first_start_to_last_end():
    segs = [
        {"id": "a", "text": "x" * 10, "pause_after_s": 1.0, "phase": "induction"},
        {"id": "b", "text": "x" * 10, "pause_after_s": 1.0, "phase": "suggestion"},
        {"id": "c", "text": "x" * 10, "pause_after_s": 1.0, "phase": "suggestion"},
        {"id": "d", "text": "x" * 10, "pause_after_s": 1.0, "phase": "resurface"},
    ]
    positions = timeline.project_positions(segs, 10.0)
    start, end = timeline.phase_span(positions, "suggestion")
    assert start == pytest.approx(positions[1].start)
    assert end == pytest.approx(positions[2].end)


def test_phase_span_of_an_absent_phase_is_none():
    segs = [{"id": "a", "text": "x", "pause_after_s": 0.0, "phase": "induction"}]
    assert timeline.phase_span(timeline.project_positions(segs, 10.0),
                               "suggestion") is None


def sampled_scripts(suffix):
    """The committed scripts for one track number, as (name, segments).

    Track I has no suffix; the rest are `_trackN`. Globbing all of them would
    sweep in tracks 2 and 4, which the sampler never reads — track 4's induction
    is a third of the length, because it is a 7-minute integration track rather
    than a 13-minute one.
    """
    pattern = os.path.join(ENGINE, "scripts", f"*{suffix}_tts_segments.json")
    for path in sorted(glob.glob(pattern)):
        name = os.path.basename(path)
        if suffix == "" and "_track" in name:
            continue
        with open(path, encoding="utf-8") as f:
            yield name, json.load(f)["segments"]


@pytest.mark.parametrize("suffix,phase,needed", [
    ("", "induction", 60.0),         # Track I  — the bespoke metaphor
    ("_track3", "suggestion", 45.0),  # Track III — the only place the whisper is
])
def test_every_sampled_script_has_room_for_its_window(suffix, phase, needed):
    """#60 cuts ~60 s of Track I's induction and ~45 s of Track III's suggestion
    phase. A script whose phase is shorter than its window would make the
    generator silently produce a sample of something else."""
    checked = 0
    for name, segments in sampled_scripts(suffix):
        span = timeline.phase_span(timeline.project_positions(segments), phase)
        assert span is not None, f"{name} has no {phase} phase"
        assert span[1] - span[0] >= needed, (
            f"{name}: the {phase} phase projects only {span[1] - span[0]:.0f}s, "
            f"less than the {needed:.0f}s window #60 cuts from it")
        checked += 1
    # A glob that silently matches nothing would pass every assertion above.
    assert checked == 5, f"expected 5 scripts for track {suffix or '1'}, saw {checked}"


@pytest.mark.parametrize("phase", ["induction", "suggestion"])
def test_the_sampled_phases_are_one_contiguous_run_in_every_script(phase):
    """`phase_span` reports first-start to last-end, which is only the same
    thing as "this phase is what you hear throughout" if the phase does not come
    in two pieces with something else in between. A sample cut from a span with
    a hole in it plays the hole."""
    for path in sorted(glob.glob(os.path.join(ENGINE, "scripts", "*_tts_segments.json"))):
        with open(path, encoding="utf-8") as f:
            segments = json.load(f)["segments"]
        phases = [s["phase"] for s in segments]
        if phase not in phases:
            continue
        first = phases.index(phase)
        last = len(phases) - 1 - phases[::-1].index(phase)
        assert phases[first:last + 1] == [phase] * (last - first + 1), (
            f"{os.path.basename(path)}: the {phase} phase is interrupted")
