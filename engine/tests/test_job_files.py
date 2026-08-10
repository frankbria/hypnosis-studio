"""Tests for job_files — the per-job filesystem cleanup helper.

Stdlib only, deliberately: render_program.py imports soundfile (and, via
render_track, numpy/scipy/av), so anything living in that module cannot be
imported in a test environment without installing the whole audio stack. Keeping
the cleanup logic in its own module is what makes it testable at all.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import job_files  # noqa: E402


def build_job(tmp_path, *, tracks=("polymath", "polymath_track2")):
    """A job directory shaped like a real finished render."""
    job = tmp_path / "job_abc123"
    job.mkdir()

    # Keepers: the deliverables and the job's own records.
    for n in (1, 2):
        (job / f"polymath_track{n}.mp3").write_bytes(b"m" * 1024)
        (job / f"polymath_track{n}.wav").write_bytes(b"w" * 4096)
    (job / "manifest.json").write_text('{"tracks":[]}')
    (job / "status.json").write_text('{"state":"ready"}')
    (job / "worker.log").write_text("log output\n")
    # Staged scripts are tiny and useful for debugging — they must survive.
    for t in tracks:
        (job / f"{t}_tts_segments.json").write_text('{"segments":[]}')

    # Intermediates: raw TTS mp3s and the treated wavs, two dirs per track.
    for t in tracks:
        raw = job / f"{t}_segments_raw"
        out = job / f"{t}_segments"
        raw.mkdir()
        out.mkdir()
        for i in range(3):
            (raw / f"S{i:02d}.mp3").write_bytes(b"r" * 2048)
            (out / f"S{i:02d}.wav").write_bytes(b"o" * 8192)
    return job


def test_finds_only_intermediate_dirs(tmp_path):
    job = build_job(tmp_path)
    found = {os.path.basename(p) for p in job_files.intermediate_dirs(str(job))}
    assert found == {
        "polymath_segments",
        "polymath_segments_raw",
        "polymath_track2_segments",
        "polymath_track2_segments_raw",
    }


def test_prune_removes_intermediates_and_keeps_everything_else(tmp_path):
    job = build_job(tmp_path)
    before = set(os.listdir(job))

    removed, freed = job_files.prune_intermediates(str(job))

    assert removed == 4
    # 4 dirs x 3 files: raw 2048 + treated 8192 per segment.
    assert freed == 2 * 3 * (2048 + 8192)

    after = set(os.listdir(job))
    assert after == before - {
        "polymath_segments",
        "polymath_segments_raw",
        "polymath_track2_segments",
        "polymath_track2_segments_raw",
    }
    # The deliverables and the records survive.
    for name in (
        "polymath_track1.mp3",
        "polymath_track1.wav",
        "polymath_track2.mp3",
        "polymath_track2.wav",
        "manifest.json",
        "status.json",
        "worker.log",
        "polymath_tts_segments.json",
    ):
        assert (job / name).exists(), f"{name} must survive cleanup"


def test_prune_is_idempotent(tmp_path):
    job = build_job(tmp_path)
    job_files.prune_intermediates(str(job))
    removed, freed = job_files.prune_intermediates(str(job))
    assert (removed, freed) == (0, 0)


def test_missing_directory_is_not_an_error(tmp_path):
    # A cleanup failure must never fail a job whose masters are already written.
    assert job_files.prune_intermediates(str(tmp_path / "nope")) == (0, 0)


def test_does_not_follow_symlinked_directories(tmp_path):
    """A symlink named like an intermediate dir must not be followed or deleted.

    Nothing creates one today, but rmtree through a symlink would delete the
    target's contents — the kind of mistake that is unrecoverable rather than
    merely wrong.
    """
    job = build_job(tmp_path)
    outside = tmp_path / "precious"
    outside.mkdir()
    (outside / "keep.wav").write_bytes(b"k" * 16)
    os.symlink(outside, job / "evil_segments")

    job_files.prune_intermediates(str(job))

    assert (outside / "keep.wav").exists(), "cleanup followed a symlink"
    assert os.path.islink(job / "evil_segments"), "the symlink itself was removed"


def test_ignores_similarly_named_entries(tmp_path):
    job = build_job(tmp_path)
    # A file (not a dir) with a matching suffix, and a dir with a near-miss name.
    (job / "notes_segments").write_text("a file, not a directory")
    (job / "polymath_segments_backup").mkdir()

    job_files.prune_intermediates(str(job))

    assert (job / "notes_segments").is_file()
    assert (job / "polymath_segments_backup").is_dir()


@pytest.mark.parametrize(
    "name,expected",
    [
        ("polymath_segments", True),
        ("polymath_segments_raw", True),
        ("river_track4_segments", True),
        ("segments", False),
        ("polymath_tts_segments.json", False),
        ("polymath_segments_backup", False),
    ],
)
def test_suffix_matching(name, expected):
    assert name.endswith(job_files.INTERMEDIATE_SUFFIXES) is expected
