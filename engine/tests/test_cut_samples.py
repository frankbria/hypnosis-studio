"""Tests for cut_samples — the two-minute mixed program samples (#60).

Stdlib only, deliberately, for the same reason timeline.py and catalog.py are:
the window arithmetic decides *what a prospective customer hears before paying*,
and that has to be testable without ffmpeg, without numpy, and without a real
master on disk.

What is actually at risk here is subtle. A sample cut from the wrong offset does
not fail — it produces a perfectly clean two minutes of the wrong thing, most
likely narration with no whisper under it, which is exactly the deficiency #60
was opened to fix. So the tests are about *where* the windows land, not about
whether ffmpeg ran.
"""
import glob
import json
import os
import sys

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ENGINE)

import cut_samples  # noqa: E402
import timeline  # noqa: E402


def load_segments(name):
    with open(os.path.join(ENGINE, "scripts", f"{name}_tts_segments.json"),
              encoding="utf-8") as f:
        return json.load(f)["segments"]


def program(key="polymath__male", goal="polymath", publishable=True,
            durations=(812.4, 830.0, 805.5, 441.1)):
    """A catalog.json program entry, shaped as prerender_catalog.py writes one."""
    return {
        "key": key,
        "goal": goal,
        "voiceSet": key.split("__")[-1],
        "publishable": publishable,
        "tracks": [
            {"n": n, "id": f"{goal}_track{n}", "durationSec": d,
             "mp3": f"{key}/{goal}_track{n}.mp3",
             "wav": f"{key}/{goal}_track{n}.wav"}
            for n, d in enumerate(durations, start=1)
        ],
    }


# --------------------------------------------------------------------------
# script_path — which script describes which track
# --------------------------------------------------------------------------

def test_track_one_script_has_no_suffix():
    assert cut_samples.script_path(ENGINE, "river", 1).endswith(
        os.path.join("scripts", "river_tts_segments.json"))


def test_track_three_script_is_suffixed():
    assert cut_samples.script_path(ENGINE, "river", 3).endswith(
        os.path.join("scripts", "river_track3_tts_segments.json"))


def test_script_naming_still_matches_the_renderer():
    """The renderer owns this naming; this module restates it to stay stdlib-only.

    Restating it is only safe while the two agree, so the agreement is pinned
    rather than assumed. render_program imports numpy and soundfile at module
    level, so this is the one test here that needs the audio stack.
    """
    pytest.importorskip("numpy")
    pytest.importorskip("soundfile")
    import render_program

    by_n = {t["n"]: t["script_suffix"] for t in render_program.TRACKS}
    for n, suffix in by_n.items():
        assert cut_samples.script_path(ENGINE, "river", n).endswith(
            f"river{suffix}_tts_segments.json")


# --------------------------------------------------------------------------
# plan_window — the arithmetic that decides what a visitor hears
# --------------------------------------------------------------------------

def synthetic(phases_and_lengths, pause=1.0):
    """Segments with one phase each, `chars` characters of text."""
    return [{"id": f"S{i:02d}", "text": "x" * chars, "pause_after_s": pause,
             "phase": phase}
            for i, (phase, chars) in enumerate(phases_and_lengths)]


def test_window_starts_at_the_phase_when_aligned_to_its_start():
    segs = synthetic([("induction", 600), ("suggestion", 6000)])
    positions = timeline.project_positions(segs)
    span = timeline.phase_span(positions, "induction")
    # A measured duration that makes the scale exactly 1: voice_end plus the
    # outro resolve_actual_s prefers.
    measured = positions[-1].end + timeline.MIN_OUTRO_S
    window = cut_samples.plan_window(segs, measured, "induction", 10.0, "start")
    assert window.start == pytest.approx(span[0])
    assert window.duration == pytest.approx(10.0)


def test_window_is_centred_in_the_phase_when_aligned_to_its_centre():
    segs = synthetic([("induction", 600), ("suggestion", 6000)])
    positions = timeline.project_positions(segs)
    span = timeline.phase_span(positions, "suggestion")
    measured = positions[-1].end + timeline.MIN_OUTRO_S
    window = cut_samples.plan_window(segs, measured, "suggestion", 40.0, "center")
    midpoint = window.start + window.duration / 2
    assert midpoint == pytest.approx((span[0] + span[1]) / 2)


def test_window_never_runs_past_the_phase_it_names():
    """The whole point of locating a phase is that the audio stays inside it."""
    segs = synthetic([("induction", 600), ("suggestion", 6000), ("resurface", 600)])
    positions = timeline.project_positions(segs)
    measured = positions[-1].end + timeline.MIN_OUTRO_S
    span = timeline.phase_span(positions, "induction")
    window = cut_samples.plan_window(segs, measured, "induction", 10_000.0, "start")
    assert window.start >= span[0] - 1e-6
    assert window.start + window.duration <= span[1] + 1e-6


def test_a_phase_shorter_than_the_window_yields_the_phase_not_an_overrun():
    """Asking for 60 s of a 40 s phase gets 40 s, not 60 s that bleeds out of it.

    The alternative — refusing — would drop a title from the storefront over a
    sample that is twenty seconds short, which is the worse trade for a page
    whose job is to let someone hear the product at all.
    """
    segs = synthetic([("induction", 200), ("suggestion", 6000)])
    positions = timeline.project_positions(segs)
    span = timeline.phase_span(positions, "induction")
    measured = positions[-1].end + timeline.MIN_OUTRO_S
    window = cut_samples.plan_window(segs, measured, "induction", 600.0, "start")
    assert window.duration == pytest.approx(span[1] - span[0])


def test_windows_scale_with_the_measured_master_not_the_projection():
    """The projection's chars/sec rate is deliberately conservative, so a real
    master runs *shorter* than projected. A window placed at the projected
    offset would drift progressively later through the file — by the suggestion
    phase, tens of seconds — so offsets are scaled onto the measured length."""
    segs = load_segments("polymath_track3")
    positions = timeline.project_positions(segs)
    projected_voice_end = positions[-1].end

    slow = cut_samples.plan_window(
        segs, projected_voice_end + timeline.MIN_OUTRO_S, "suggestion", 45.0, "center")
    # The same program, whose voice really runs 20% shorter than projected.
    short_voice = (projected_voice_end - timeline.LEAD_IN_S) * 0.8
    fast = cut_samples.plan_window(
        segs, short_voice + timeline.LEAD_IN_S + timeline.MIN_OUTRO_S,
        "suggestion", 45.0, "center")
    assert fast.start < slow.start
    # The *midpoint* is what scales. The window keeps its 45 s length whatever
    # the master's length, so its edges cannot scale with the phase and only the
    # point it is centred on can.
    def midpoint(w):
        return w.start + w.duration / 2

    assert midpoint(fast) == pytest.approx(
        timeline.LEAD_IN_S + (midpoint(slow) - timeline.LEAD_IN_S) * 0.8, rel=1e-6)


def test_a_window_never_leaves_the_file():
    """A master shorter than the outro allowance must not produce a negative
    start or a window past the end — ffmpeg would happily emit near-silence."""
    segs = load_segments("river_track3")
    window = cut_samples.plan_window(segs, 40.0, "suggestion", 45.0, "center")
    assert window.start >= 0.0
    assert window.start + window.duration <= 40.0 + 1e-6


def test_a_missing_phase_is_refused_rather_than_guessed():
    segs = synthetic([("induction", 600)])
    with pytest.raises(ValueError, match="suggestion"):
        cut_samples.plan_window(segs, 800.0, "suggestion", 45.0, "center")


# --------------------------------------------------------------------------
# plan_sample — the two windows together, against the real scripts
# --------------------------------------------------------------------------

GOALS = sorted({os.path.basename(p).replace("_tts_segments.json", "")
                for p in glob.glob(os.path.join(ENGINE, "scripts", "*_tts_segments.json"))
                if "_track" not in os.path.basename(p)})


def test_the_five_committed_goals_are_all_here():
    assert len(GOALS) == 5, GOALS


@pytest.mark.parametrize("goal", GOALS)
def test_the_track_three_window_lands_inside_the_suggestion_phase(goal):
    """The acceptance criterion with teeth: the whisper layer only exists in the
    suggestion phase, so a Track III window outside it samples the one thing #60
    says is already previewable — narration on its own."""
    plan = cut_samples.plan_sample(ENGINE, program(goal=goal, key=f"{goal}__male"))
    window = plan.windows[cut_samples.TRACK_THREE]

    segs = load_segments(f"{goal}_track3")
    positions = timeline.project_positions(segs)
    span = timeline.phase_span(positions, "suggestion")
    measured = next(t["durationSec"] for t in program(goal=goal)["tracks"] if t["n"] == 3)
    scale = ((measured - timeline.MIN_OUTRO_S - timeline.LEAD_IN_S)
             / (positions[-1].end - timeline.LEAD_IN_S))
    real = [timeline.LEAD_IN_S + (t - timeline.LEAD_IN_S) * scale for t in span]

    assert window.start >= real[0] - 1e-6
    assert window.start + window.duration <= real[1] + 1e-6


@pytest.mark.parametrize("goal", GOALS)
def test_both_windows_are_the_lengths_the_issue_asks_for(goal):
    plan = cut_samples.plan_sample(ENGINE, program(goal=goal, key=f"{goal}__male"))
    assert plan.windows[cut_samples.TRACK_ONE].duration == pytest.approx(
        cut_samples.TRACK_ONE_SECONDS)
    assert plan.windows[cut_samples.TRACK_THREE].duration == pytest.approx(
        cut_samples.TRACK_THREE_SECONDS)


@pytest.mark.parametrize("goal", GOALS)
def test_the_sample_is_about_two_minutes(goal):
    plan = cut_samples.plan_sample(ENGINE, program(goal=goal, key=f"{goal}__male"))
    assert 95.0 <= plan.duration <= 125.0


def test_the_expected_duration_accounts_for_the_crossfade():
    """The join overlaps the two excerpts, so the sample is shorter than their
    sum. Quoting the sum would make the ffprobe check reject every good file."""
    plan = cut_samples.plan_sample(ENGINE, program())
    assert plan.duration == pytest.approx(
        sum(w.duration for w in plan.windows.values()) - cut_samples.CROSSFADE_S)


def test_a_plan_too_short_to_be_a_sample_is_refused():
    """Both windows clamp to the phase they name, so a master far shorter than
    its manifest says plans a few seconds instead of failing — and the duration
    check cannot catch that, because a four-second cut of a four-second plan
    agrees perfectly."""
    with pytest.raises(ValueError, match="floor"):
        cut_samples.plan_sample(ENGINE, program(durations=(9.0, 9.0, 9.0, 9.0)))


def test_a_program_missing_a_sampled_track_is_refused():
    p = program()
    p["tracks"] = [t for t in p["tracks"] if t["n"] != 3]
    with pytest.raises(ValueError, match="track 3"):
        cut_samples.plan_sample(ENGINE, p)


# --------------------------------------------------------------------------
# ffmpeg_command — the shape of the call, without running it
# --------------------------------------------------------------------------

def test_the_command_seeks_each_input_to_its_own_window():
    plan = cut_samples.plan_sample(ENGINE, program())
    argv = cut_samples.ffmpeg_command(
        {1: "/m/t1.mp3", 3: "/m/t3.mp3"}, plan, "/m/sample.mp3")
    for n, source in ((cut_samples.TRACK_ONE, "/m/t1.mp3"),
                      (cut_samples.TRACK_THREE, "/m/t3.mp3")):
        at = argv.index(source)
        # -ss VALUE -t VALUE -i SOURCE, so the window sits immediately before it.
        assert argv[at - 5] == "-ss"
        # Millisecond precision on the wire, so the comparison is to the same.
        assert float(argv[at - 4]) == pytest.approx(plan.windows[n].start, abs=1e-3)
        assert argv[at - 3] == "-t"
        assert float(argv[at - 2]) == pytest.approx(plan.windows[n].duration, abs=1e-3)


def test_the_command_crossfades_rather_than_butt_joining():
    """A hard cut between two unrelated points of a hypnosis program is an
    audible click on the one file whose job is to sound trustworthy."""
    plan = cut_samples.plan_sample(ENGINE, program())
    argv = cut_samples.ffmpeg_command({1: "a.mp3", 3: "b.mp3"}, plan, "out.mp3")
    graph = argv[argv.index("-filter_complex") + 1]
    assert f"acrossfade=d={cut_samples.CROSSFADE_S:g}" in graph


def test_the_command_never_overwrites_without_being_told_to():
    """`-y` is passed because the driver has already decided to replace the file
    (--force, or there was none). ffmpeg blocking on a stdin prompt inside a
    ten-program loop would hang the run with no output."""
    plan = cut_samples.plan_sample(ENGINE, program())
    argv = cut_samples.ffmpeg_command({1: "a.mp3", 3: "b.mp3"}, plan, "out.mp3")
    assert "-nostdin" in argv and "-y" in argv


def test_the_output_is_the_last_argument():
    plan = cut_samples.plan_sample(ENGINE, program())
    argv = cut_samples.ffmpeg_command({1: "a.mp3", 3: "b.mp3"}, plan, "/out/s.mp3")
    assert argv[-1] == "/out/s.mp3"


# --------------------------------------------------------------------------
# The driver's bookkeeping
# --------------------------------------------------------------------------

def test_selection_parses_a_goal_and_voice_set():
    assert cut_samples.parse_selection(["polymath:male"]) == {"polymath__male"}


def test_selection_rejects_a_malformed_pair():
    with pytest.raises(ValueError):
        cut_samples.parse_selection(["polymath"])


def test_a_typo_in_a_selection_fails_loudly(tmp_path, capsys):
    """`--force polymath:mail` must not report success having re-cut nothing —
    that reads identically to the sample already being correct."""
    manifest = tmp_path / "catalog.json"
    manifest.write_text(json.dumps({"programs": [program()]}))
    code = cut_samples.main([
        "--catalog-dir", str(tmp_path), "--manifest", str(manifest),
        "--force", "polymath:mail"])
    assert code == 2
    assert "no such program" in capsys.readouterr().out


def test_only_publishable_programs_are_sampled():
    """A sample is an advertisement. Cutting one from a master the studio has
    not confirmed it can deliver advertises something unsellable."""
    manifest = {"programs": [program(publishable=False),
                             program(key="river__female", goal="river")]}
    assert [p["key"] for p in cut_samples.selected(manifest, set())] == ["river__female"]


def test_a_selection_narrows_further_but_never_widens():
    manifest = {"programs": [program(publishable=False),
                             program(key="river__female", goal="river")]}
    assert cut_samples.selected(manifest, {"polymath__male"}) == []


def test_a_key_that_escapes_the_catalog_root_writes_nothing(tmp_path):
    """The output path is built from a manifest-supplied key. Everything else in
    this repo that resolves a path under the catalog root checks containment."""
    p = program(key="../../etc")
    problems = cut_samples.cut_one(ENGINE, str(tmp_path), p, force=True,
                                   dry_run=False)
    assert problems and "escapes" in problems[0]


def test_the_sample_sits_beside_the_masters_it_was_cut_from():
    """Same directory as the program, so #57's move to object storage carries
    the sample with the audio rather than stranding it."""
    assert cut_samples.sample_path("/srv/catalog", "polymath__male") == os.path.join(
        "/srv/catalog", "polymath__male", cut_samples.SAMPLE_NAME)


@pytest.mark.parametrize("measured,ok", [
    (105.0, True), (104.0, True), (106.0, True), (60.0, False), (140.0, False),
])
def test_a_sample_of_the_wrong_length_is_rejected(measured, ok):
    """ffmpeg exits 0 on plenty of things that are not the file that was asked
    for — a seek past the end yields a valid, near-empty mp3."""
    problems = cut_samples.check_duration("polymath__male", measured, 105.0)
    assert (problems == []) is ok
