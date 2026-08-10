"""Verifies the cleanup call site inside render_program.run().

render_program imports soundfile at module level and render_track (which pulls
numpy/scipy/av), so it cannot normally be imported without the full audio stack.
Stubbing those two entries in sys.modules is enough to import it and inspect the
real parsed source — which is what the ordering assertions below check.

Ordering is the thing worth pinning: pruning before the manifest is written
would delete the segments of a job that then fails its own existence check,
and pruning a failed job would destroy the evidence needed to debug it.
"""
import os
import sys
import types

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ENGINE)


@pytest.fixture(scope="module")
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


def test_cleanup_is_wired_in(render_program):
    """job_files is actually imported and reachable from render_program."""
    assert hasattr(render_program, "job_files")
    assert callable(render_program.job_files.prune_intermediates)


def test_prune_runs_after_the_manifest_and_before_ready(render_program, code_only):
    import inspect

    src = code_only(inspect.getsource(render_program.run))

    manifest_at = src.index('write_json_atomic(os.path.join(outdir, "manifest.json")')
    prune_at = src.index("prune_intermediates(outdir)")
    ready_at = src.index("job.ready()")

    assert manifest_at < prune_at, (
        "cleanup must run only after the manifest is written — otherwise a job "
        "that fails its existence check loses its segments too"
    )
    assert prune_at < ready_at, "the job should be finalised before it is marked ready"


def test_prune_is_not_reachable_on_the_failure_path(render_program, code_only):
    """A failed job must keep its segments for debugging.

    run() raises on any failure, and the cleanup call sits after every raise in
    the function body, so no failure path can reach it.
    """
    import inspect

    src = code_only(inspect.getsource(render_program.run))
    prune_at = src.index("prune_intermediates(outdir)")
    raises_after_prune = [
        i for i in range(prune_at, len(src)) if src.startswith("raise ", i)
    ]
    assert not raises_after_prune, "unexpected raise after cleanup"
    assert "raise " in src[:prune_at], "expected failure paths before cleanup"
