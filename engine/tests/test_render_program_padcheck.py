"""Verifies the pre-spend pad check in render_program.

The point of this gate is timing, not cleverness: everything it reports could
also be discovered at assembly, except that by then the track's entire
ElevenLabs spend is gone (issue #5). So the assertions here are mostly about
*when* it runs and *whether it refuses*, not about the arithmetic — that lives
in test_timeline.py.

render_program imports soundfile at module level and render_track (which pulls
numpy/scipy/av), so both are stubbed to import it at all.
"""
import glob
import inspect
import os
import shutil
import sys
import types

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ENGINE)

import timeline  # noqa: E402


@pytest.fixture()
def render_program():
    """Import render_program with its audio dependencies stubbed out."""
    saved = {k: sys.modules.get(k) for k in ("soundfile", "render_track")}

    sf_stub = types.ModuleType("soundfile")
    sf_stub.info = lambda *a, **k: None
    sf_stub.write = lambda *a, **k: None
    sys.modules["soundfile"] = sf_stub

    rt_stub = types.ModuleType("render_track")
    rt_stub.load_key = lambda: "stub"
    rt_stub.tts = lambda *a, **k: True
    rt_stub.mp3_to_float = lambda *a, **k: (None, 44100)
    rt_stub.treat = lambda y, sr: y
    sys.modules["render_track"] = rt_stub

    sys.modules.pop("render_program", None)
    import render_program as rp

    yield rp

    for name, mod in saved.items():
        if mod is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = mod
    sys.modules.pop("render_program", None)


def set_pad_duration(render_program, seconds, samplerate=timeline.SR):
    """Point the stubbed soundfile at a pad of the given length and rate."""
    render_program.sf.info = lambda *a, **k: types.SimpleNamespace(
        duration=seconds, samplerate=samplerate)


def track(n=1, chars=1000, pauses=0.0, total_s=780, key="river"):
    """One entry shaped like plan_tracks() output."""
    return {
        "n": n,
        "track_key": key,
        "total_s": total_s,
        "segments": [
            {"id": "S01", "text": "x" * chars,
             "pause_after_s": pauses, "phase": "induction"},
            {"id": "S02", "text": "y" * 10, "pause_after_s": 0.0, "phase": "resurface"},
        ],
    }


def test_comfortable_program_reports_no_problems(render_program):
    set_pad_duration(render_program, 960.0)
    assert render_program.check_pad_headroom(
        [track(chars=1000)], "pad.wav", strict=True) == []


def test_overlong_program_is_refused_in_dry_run(render_program):
    """strict=True is the --dry-run path: this is the whole point of the gate."""
    set_pad_duration(render_program, 960.0)
    with pytest.raises(ValueError) as exc:
        render_program.check_pad_headroom(
            [track(chars=20000, pauses=400.0)], "pad.wav", strict=True)
    assert "pad too short" in str(exc.value)


def test_overlong_program_is_only_warned_about_on_a_real_render(render_program):
    """A real render must not be refused on an estimate.

    The projection is deliberately conservative, and assemble_track now shortens
    the outro instead of failing — so blocking here would forfeit a sale to avoid
    a shorter music tail.
    """
    set_pad_duration(render_program, 960.0)
    problems = render_program.check_pad_headroom(
        [track(chars=20000, pauses=400.0)], "pad.wav", strict=False)
    assert problems, "an overlong program should still be reported"


def test_refusal_names_the_track_and_both_durations(render_program):
    set_pad_duration(render_program, 960.0)
    with pytest.raises(ValueError) as exc:
        render_program.check_pad_headroom(
            [track(n=3, chars=20000, pauses=400.0, key="river_track3")],
            "pad.wav", strict=True)
    msg = str(exc.value)
    assert "river_track3" in msg
    assert "960" in msg, f"pad length missing: {msg}"
    assert str(int(timeline.FADE_S)) in msg, f"fade length missing: {msg}"
    # The projected voice length is the other half of "both durations" — without
    # it the operator cannot tell how far over the track actually is.
    est = timeline.estimate_voice_end(
        track(chars=20000, pauses=400.0)["segments"], timeline.chars_per_sec())
    assert f"{est:.1f}" in msg, f"projected voice length missing: {msg}"


def test_every_track_is_checked_not_just_the_first(render_program):
    """Tracks 1-3 are the long ones; a check that stopped early would miss them."""
    set_pad_duration(render_program, 960.0)
    problems = render_program.check_pad_headroom(
        [track(n=1, chars=100), track(n=2, chars=20000, pauses=400.0),
         track(n=3, chars=20000, pauses=400.0)],
        "pad.wav", strict=False)
    assert len(problems) == 2


def test_wrong_sample_rate_is_refused_before_spending(render_program):
    """A 48 kHz pad reports a perfectly normal duration.

    sf.info gives duration as frames/samplerate, so a 960 s pad at 48 kHz still
    reads 960 s and passes every length check. The assembler will refuse it, but
    the assembler runs *after* the whole track has been bought.
    """
    set_pad_duration(render_program, 960.0, samplerate=48000)
    with pytest.raises(ValueError) as exc:
        render_program.check_pad_headroom([track()], "pad.wav", strict=True)
    assert "48000" in str(exc.value)


def test_wrong_sample_rate_is_fatal_even_when_not_strict(render_program):
    """strict gates a projection; this is a certainty.

    The estimate can be wrong in a safe direction, which is why a real render
    only warns on it. A wrong sample rate is not an estimate — the render cannot
    succeed — so it must stop the job on the real path too, not just --dry-run.
    """
    set_pad_duration(render_program, 960.0, samplerate=22050)
    with pytest.raises(ValueError):
        render_program.check_pad_headroom([track()], "pad.wav", strict=False)


def test_matching_sample_rate_passes(render_program):
    set_pad_duration(render_program, 960.0, samplerate=timeline.SR)
    assert render_program.check_pad_headroom(
        [track(chars=1000)], "pad.wav", strict=True) == []


def staged_engine(render_program, tmp_path, goal="river", pad_name="pad_15.wav"):
    """Point render_program at a throwaway ENGINE_DIR holding the real scripts.

    run() resolves both scripts and the pad relative to ENGINE_DIR, so relocating
    it is what makes run() callable end-to-end in a test. The scripts are the
    real committed ones; only the pad is a stub, since sf.info is stubbed and
    nothing reads its bytes on the dry-run path.
    """
    engine = tmp_path / "engine"
    (engine / "scripts").mkdir(parents=True)
    (engine / "pads").mkdir()
    for src in glob.glob(os.path.join(ENGINE, "scripts", f"{goal}*_tts_segments.json")):
        shutil.copy(src, engine / "scripts" / os.path.basename(src))
    (engine / "pads" / pad_name).write_bytes(b"stub")
    render_program.ENGINE_DIR = str(engine)
    return engine


def test_dry_run_actually_refuses_an_undersized_pad(render_program, tmp_path):
    """End-to-end through run(), not source inspection.

    The ordering tests below assert on the *text* of run(); this one proves the
    refusal really propagates out of run() — it would still catch a future
    try/except that swallowed the error, or a helper extraction that moved the
    call.
    """
    staged_engine(render_program, tmp_path)
    set_pad_duration(render_program, 300.0)  # far too short for a ~900 s program
    with pytest.raises(ValueError) as exc:
        render_program.run("job1", "river", "male",
                           str(tmp_path / "out"), dry_run=True)
    assert "pad too short" in str(exc.value)


def test_dry_run_succeeds_when_the_pad_fits(render_program, tmp_path):
    """The same path must not refuse a pad that is actually fine."""
    staged_engine(render_program, tmp_path)
    set_pad_duration(render_program, 960.0)
    render_program.run("job2", "river", "male",
                       str(tmp_path / "out2"), dry_run=True)


def test_run_refuses_a_wrong_rate_pad_end_to_end(render_program, tmp_path):
    staged_engine(render_program, tmp_path)
    set_pad_duration(render_program, 960.0, samplerate=48000)
    with pytest.raises(ValueError) as exc:
        render_program.run("job3", "river", "male",
                           str(tmp_path / "out3"), dry_run=True)
    assert "48000" in str(exc.value)


def test_check_runs_before_any_tts_spend(render_program):
    """Ordering is the whole value of this gate.

    It must sit ahead of load_key() and the voicing loop, otherwise it reports a
    problem the customer has already paid for.
    """
    src = inspect.getsource(render_program.run)

    check_at = src.index("check_pad_headroom(")
    key_at = src.index("render_track.load_key()")
    tts_at = src.index("render_track.tts(")

    assert check_at < key_at, "pad check must precede key resolution"
    assert check_at < tts_at, "pad check must precede the first TTS call"


def test_check_runs_before_the_dry_run_returns(render_program):
    """--dry-run must actually reach the check, not return past it."""
    src = inspect.getsource(render_program.run)
    assert src.index("check_pad_headroom(") < src.index("if dry_run:")


def test_dry_run_makes_the_check_strict(render_program):
    """The strict flag has to be wired to dry_run, not hardcoded."""
    src = inspect.getsource(render_program.run)
    line = next(ln for ln in src.splitlines() if "check_pad_headroom(" in ln)
    assert "strict=dry_run" in line, line
