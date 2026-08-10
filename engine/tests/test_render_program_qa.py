"""The QA gate as it actually runs inside render_program.

test_qa.py covers the decision logic on measurements handed in. This file drives
*real WAV and MP3 files* through `master_rms_db` and the call site, because the
failure this issue is about is precisely that the old checks never opened the
audio — existence and a readable duration both pass for an all-silent track.

Needs the real soundfile/numpy stack; skipped when it is unavailable, which is
also how the pure-stdlib modules earn their keep.
"""
import os
import sys
import types

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ENGINE)

np = pytest.importorskip("numpy")
sf = pytest.importorskip("soundfile")

import qa  # noqa: E402

SR = 44100


@pytest.fixture()
def render_program():
    """Import render_program with only render_track stubbed.

    soundfile and numpy stay real here — reading the audio is the thing under
    test. render_track is stubbed because it pulls `av`, which the gate does not
    need.
    """
    saved = sys.modules.get("render_track")
    rt = types.ModuleType("render_track")
    rt.load_key = lambda: "stub"
    rt.tts = lambda *a, **k: True
    rt.mp3_to_float = lambda *a, **k: (None, SR)
    rt.treat = lambda y, sr: y
    sys.modules["render_track"] = rt

    sys.modules.pop("render_program", None)
    import render_program as rp

    yield rp

    if saved is None:
        sys.modules.pop("render_track", None)
    else:
        sys.modules["render_track"] = saved
    sys.modules.pop("render_program", None)


def write_master(path, seconds=5.0, amplitude=0.1, silent=False):
    """A WAV shaped like a real master: normalised near -20 dB RMS, or silent."""
    n = int(seconds * SR)
    if silent:
        y = np.zeros(n, dtype="float32")
    else:
        rng = np.random.default_rng(3)
        y = (amplitude * rng.standard_normal(n)).astype("float32")
    sf.write(path, y, SR, subtype="PCM_16")
    return y


def code_only(src):
    """Source with comment text removed — see test_render_program_cleanup.py.

    Locating a call by string index finds a *mention* of it in a comment just as
    readily as the call, which silently inverts an ordering assertion.
    """
    return "\n".join(line.split("#", 1)[0] for line in src.splitlines())


# --------------------------------------------------------------------------
# master_rms_db against real files
# --------------------------------------------------------------------------

def test_rms_of_a_real_master_matches_numpy(render_program, tmp_path):
    """The streamed accumulator must agree with the obvious whole-file answer."""
    p = str(tmp_path / "m.wav")
    write_master(p, seconds=3.0, amplitude=0.1)
    y, _ = sf.read(p, dtype="float64")
    expected = 20 * np.log10(np.sqrt(np.mean(y ** 2)))
    assert render_program.master_rms_db(p) == pytest.approx(expected, abs=0.01)


def test_rms_of_a_silent_master_is_not_finite(render_program, tmp_path):
    """A zero master must read as -inf, not be nudged into a plausible number by
    an epsilon — the finiteness check is what rejects it."""
    p = str(tmp_path / "silent.wav")
    write_master(p, silent=True)
    import math
    assert not math.isfinite(render_program.master_rms_db(p))


def test_rms_streams_rather_than_loading_whole(render_program, tmp_path):
    """A master longer than one block still measures correctly.

    blocksize is 1<<20 frames (~24 s), so this crosses several blocks; a
    per-block averaging bug would show up as a wrong answer here and not on a
    short file.
    """
    p = str(tmp_path / "long.wav")
    write_master(p, seconds=60.0, amplitude=0.1)
    y, _ = sf.read(p, dtype="float64")
    expected = 20 * np.log10(np.sqrt(np.mean(y ** 2)))
    assert render_program.master_rms_db(p) == pytest.approx(expected, abs=0.01)


# --------------------------------------------------------------------------
# The gate end to end
# --------------------------------------------------------------------------

def test_a_silent_master_is_caught_by_the_full_gate(render_program, tmp_path):
    """The headline case: a real silent WAV, through the real measurement, into
    the real decision. Existence and duration both pass for this file."""
    p = str(tmp_path / "s.wav")
    write_master(p, seconds=10.0, silent=True)

    assert os.path.exists(p), "existence check passes"
    assert sf.info(p).duration > 0, "duration check passes"

    problems = qa.check_master(
        label="river_track1",
        rms_db=render_program.master_rms_db(p),
        mp3_bytes=int(3990 * 10),      # silence encodes small but above the floor
        duration_s=sf.info(p).duration,
        planned_s=10.0,
    )
    assert problems, "the old checks pass this file; the new gate must not"
    assert any("silent" in p_.lower() or "finite" in p_.lower() for p_ in problems), problems


def test_a_healthy_master_passes_the_full_gate(render_program, tmp_path):
    p = str(tmp_path / "ok.wav")
    write_master(p, seconds=10.0, amplitude=0.1)  # ~ -20 dB RMS
    rms = render_program.master_rms_db(p)
    assert -30.0 < rms < -12.0, f"fixture should sit in the sane window, got {rms}"
    assert qa.check_master(
        label="river_track1", rms_db=rms, mp3_bytes=int(9000 * 10),
        duration_s=10.0, planned_s=10.0) == []


# --------------------------------------------------------------------------
# Call-site ordering — the gate is worthless if it runs after the manifest
# --------------------------------------------------------------------------

def test_gate_runs_before_the_manifest_is_written(render_program):
    import inspect
    src = code_only(inspect.getsource(render_program.run))
    gate_at = src.index("QA gate rejected the masters")
    manifest_at = src.index('write_json_atomic(os.path.join(outdir, "manifest.json")')
    assert gate_at < manifest_at, (
        "a job that fails QA must never get a manifest listing its masters")


def test_gate_runs_before_cleanup_so_failures_keep_their_evidence(render_program):
    import inspect
    src = code_only(inspect.getsource(render_program.run))
    assert src.index("QA gate rejected the masters") < src.index("prune_intermediates(outdir)")


def test_gate_is_not_behind_an_env_flag(render_program):
    """Criterion: it runs in production by default. HYPNO_SKIP_QA must not reach
    it — that flag only governs the assembler's diagnostic block."""
    import inspect
    src = code_only(inspect.getsource(render_program.run))
    gate_region = src[src.index("planned_by_n"):src.index("QA gate rejected the masters")]
    assert "HYPNO_SKIP_QA" not in gate_region
    assert "SKIP_QA" not in gate_region


def test_gate_needs_no_faster_whisper(render_program):
    """Criterion: the gate must not depend on a package missing from the venv."""
    import inspect
    assert "faster_whisper" not in inspect.getsource(render_program)
    assert "faster_whisper" not in inspect.getsource(qa)


def test_qa_progress_never_reports_a_complete_render(render_program):
    """Only job.ready() may report 100%.

    A progress bar that reaches 100% and is then followed by a failure reads as
    a finished render that broke afterwards — a success state for something that
    did not happen.
    """
    assert render_program.P_QA_END < 1.0
    assert render_program.P_BED_END < render_program.P_QA_END
