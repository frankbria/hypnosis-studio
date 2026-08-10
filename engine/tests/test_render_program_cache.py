"""The segment cache as it actually behaves inside render_program.run().

test_segment_cache.py covers the store on its own. This drives the real voicing
loop, because the value of the change is measured in *purchases avoided*, and
that only shows up at the call site.

The assertions are TTS call counts. Every one is 17k-22k characters of billable
spend spread across 152 segments (issue #9).
"""
import json
import os
import shutil
import sys
import types

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ENGINE)

np = pytest.importorskip("numpy")
sf = pytest.importorskip("soundfile")

import segment_cache  # noqa: E402

SR = 44100


@pytest.fixture()
def rp(tmp_path, monkeypatch):
    """render_program with a throwaway ENGINE_DIR and a counting TTS stub."""
    saved = sys.modules.get("render_track")
    calls = {"tts": 0}

    rt = types.ModuleType("render_track")
    rt.load_key = lambda: "stub"

    class TtsError(RuntimeError):
        def __init__(self, kind, detail):
            super().__init__(detail)
            self.kind, self.detail = kind, detail

    rt.TtsError = TtsError

    def tts(voice_id, text, out_path):
        calls["tts"] += 1
        with open(out_path, "wb") as f:
            f.write(b"raw-mp3")
        return True

    rt.tts = tts
    rt.mp3_to_float = lambda p: (np.zeros(SR // 2, dtype="float64"), SR)
    rt.treat = lambda y, sr: y
    sys.modules["render_track"] = rt

    sys.modules.pop("render_program", None)
    import render_program as mod

    engine = tmp_path / "engine"
    (engine / "scripts").mkdir(parents=True)
    (engine / "pads").mkdir()
    # Two tiny goals' worth of script: 3 segments per track, 4 tracks.
    for suffix in ("", "_track2", "_track3", "_track4"):
        segments = [
            {"id": f"S{n}", "text": f"segment {n} of {suffix or 'track1'}",
             "pause_after_s": 1.0,
             "phase": "suggestion" if n == 2 else "induction"}
            for n in range(1, 4)
        ]
        (engine / "scripts" / f"river{suffix}_tts_segments.json").write_text(
            json.dumps({"segments": segments}))
    # 60 s, not the production 960 s: these scripts are a few short segments,
    # so this clears the headroom check comfortably and keeps the fixture from
    # writing 84 MB per test.
    sf.write(str(engine / "pads" / "pad_15.wav"),
             np.zeros(60 * SR, dtype="float32"), SR, subtype="PCM_16")
    mod.ENGINE_DIR = str(engine)

    # Assembly and QA are not what this file is about.
    def fake_assembler(cmd, **kwargs):
        outdir = kwargs["cwd"]
        title = cmd[3]
        y = (0.1 * np.random.default_rng(2).standard_normal(SR * 3)).astype("float32")
        sf.write(os.path.join(outdir, f"{title}.wav"), y, SR, subtype="PCM_16")
        sf.write(os.path.join(outdir, f"{title}.mp3"), y, SR, format="MP3")

        class Done:
            stdout = iter(())

            def wait(self):
                return 0
        return Done()

    monkeypatch.setattr(mod.subprocess, "Popen", fake_assembler)
    monkeypatch.setattr(mod.qa, "check_master", lambda **k: [])
    monkeypatch.setattr(mod.time, "sleep", lambda s: None)

    yield mod, calls

    sys.modules.pop("render_program", None)
    if saved is not None:
        sys.modules["render_track"] = saved
    else:
        sys.modules.pop("render_track", None)


def run_job(mod, root, job_id):
    outdir = os.path.join(root, job_id)
    mod.run(job_id, "river", "male", outdir)
    return outdir


# --------------------------------------------------------------------------
# The headline: a repeat job buys nothing
# --------------------------------------------------------------------------

def test_a_repeat_job_makes_no_tts_calls(rp, tmp_path, monkeypatch):
    """The criterion: same goal, same voice set, a *different* job directory —
    which is what the server always creates — and zero purchases."""
    mod, calls = rp
    root = str(tmp_path / "renders")
    monkeypatch.setenv(segment_cache.CACHE_DIR_ENV, str(tmp_path / "cache"))

    run_job(mod, root, "job_first")
    first = calls["tts"]
    assert first == 12, f"expected 12 segments purchased, got {first}"

    calls["tts"] = 0
    run_job(mod, root, "job_second")
    assert calls["tts"] == 0, (
        f"the repeat job re-purchased {calls['tts']} segments; the whole point "
        f"is that it purchases none")


def test_the_second_job_still_produces_a_ready_render(rp, tmp_path, monkeypatch):
    """Free is only useful if it also works."""
    mod, calls = rp
    root = str(tmp_path / "renders")
    monkeypatch.setenv(segment_cache.CACHE_DIR_ENV, str(tmp_path / "cache"))
    run_job(mod, root, "job_a")
    outdir = run_job(mod, root, "job_b")
    status = json.load(open(os.path.join(outdir, "status.json")))
    assert status["state"] == "ready"
    assert os.path.exists(os.path.join(outdir, "manifest.json"))


# --------------------------------------------------------------------------
# Resuming a failed run — the scenario the issue opens with
# --------------------------------------------------------------------------

def test_a_retry_after_a_mid_run_failure_resumes_from_cache(
        rp, tmp_path, monkeypatch):
    """One transient failure part-way through used to discard every segment
    already bought, because the job directory it worked in is abandoned."""
    mod, calls = rp
    root = str(tmp_path / "renders")
    monkeypatch.setenv(segment_cache.CACHE_DIR_ENV, str(tmp_path / "cache"))

    original = sys.modules["render_track"].tts

    def die_on_the_seventh(voice_id, text, out_path):
        if calls["tts"] == 6:
            raise sys.modules["render_track"].TtsError("transient", "network died")
        return original(voice_id, text, out_path)

    sys.modules["render_track"].tts = die_on_the_seventh
    with pytest.raises(RuntimeError):
        run_job(mod, root, "job_dies")
    bought_before_failure = calls["tts"]
    assert bought_before_failure == 6

    # The customer retries. A brand-new job directory, as the server mints.
    sys.modules["render_track"].tts = original
    calls["tts"] = 0
    run_job(mod, root, "job_retry")
    assert calls["tts"] == 12 - bought_before_failure, (
        f"the retry bought {calls['tts']} segments; only the "
        f"{12 - bought_before_failure} never reached should have been purchased")


def test_segments_are_cached_before_the_job_succeeds(rp, tmp_path, monkeypatch):
    """Promoting on success would cache nothing for a job that dies at segment
    150 of 152 — exactly the case this issue is about."""
    mod, calls = rp
    root = str(tmp_path / "renders")
    cache = str(tmp_path / "cache")
    monkeypatch.setenv(segment_cache.CACHE_DIR_ENV, cache)

    original = sys.modules["render_track"].tts

    def die_early(voice_id, text, out_path):
        if calls["tts"] == 4:
            raise sys.modules["render_track"].TtsError("transient", "died")
        return original(voice_id, text, out_path)

    sys.modules["render_track"].tts = die_early
    with pytest.raises(RuntimeError):
        run_job(mod, root, "job_dies")

    assert len(segment_cache.entries(cache)) == 4, (
        "the segments bought before the failure should already be cached")


# --------------------------------------------------------------------------
# The cache must not be able to break a render
# --------------------------------------------------------------------------

def test_an_unreadable_cache_entry_falls_back_to_purchasing(
        rp, tmp_path, monkeypatch):
    """A broken cache is a slower render, never a failed one."""
    mod, calls = rp
    root = str(tmp_path / "renders")
    cache = str(tmp_path / "cache")
    monkeypatch.setenv(segment_cache.CACHE_DIR_ENV, cache)
    run_job(mod, root, "job_one")

    # Corrupt every entry into a directory, so copyfile fails on it.
    for path, _size, _mtime in segment_cache.entries(cache):
        os.remove(path)
        os.mkdir(path)

    calls["tts"] = 0
    outdir = run_job(mod, root, "job_two")
    assert calls["tts"] == 12, "it should have fallen back to purchasing"
    status = json.load(open(os.path.join(outdir, "status.json")))
    assert status["state"] == "ready"


def test_an_unwritable_cache_does_not_fail_the_render(rp, tmp_path, monkeypatch):
    mod, calls = rp
    root = str(tmp_path / "renders")
    monkeypatch.setenv(segment_cache.CACHE_DIR_ENV, "/proc/nope/cache")
    outdir = run_job(mod, root, "job_one")
    status = json.load(open(os.path.join(outdir, "status.json")))
    assert status["state"] == "ready"
    assert calls["tts"] == 12


# --------------------------------------------------------------------------
# Bounding
# --------------------------------------------------------------------------

def test_the_cache_is_swept_after_a_render(rp, tmp_path, monkeypatch):
    """Criterion: the cache must not become its own disk problem."""
    mod, calls = rp
    root = str(tmp_path / "renders")
    cache = str(tmp_path / "cache")
    monkeypatch.setenv(segment_cache.CACHE_DIR_ENV, cache)
    monkeypatch.setenv(segment_cache.MAX_BYTES_ENV, "1")

    run_job(mod, root, "job_one")
    assert segment_cache.total_bytes(cache) <= 1, (
        "the sweep should have run at the end of the render")


def test_the_sweep_runs_after_the_job_is_marked_ready(rp, tmp_path, monkeypatch):
    """A full cache must not stop a finished render being delivered."""
    mod, _calls = rp
    import inspect
    src = inspect.getsource(mod.run)
    assert src.index("segment_cache.sweep") > src.index("job.ready()")
