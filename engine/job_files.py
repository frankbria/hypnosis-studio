"""Per-job filesystem helpers.

Stdlib only, on purpose. render_program.py imports soundfile (and, through
render_track, numpy/scipy/av), so logic that lives there cannot be exercised
without installing the whole audio stack. Keeping this here makes it testable.
"""
import os
import shutil

# Voicing writes two copies of every segment into the job directory: the raw
# ElevenLabs MP3 and the de-harshed/reverbed WAV the assembler reads. Across
# ~152 segments and 4 tracks that is roughly 230 MB per job, on top of ~290 MB
# of masters — and nothing ever removed it, so renders/ grew ~500 MB per job.
#
# Both are pure intermediates: regenerable from the staged script and the TTS
# API, and read by nothing once the masters exist.
INTERMEDIATE_SUFFIXES = ("_segments", "_segments_raw")


def intermediate_dirs(outdir):
    """Real directories under `outdir` holding per-segment TTS intermediates.

    Symlinks are excluded deliberately — deleting through one would destroy the
    target's contents rather than the job's own scratch.
    """
    try:
        names = sorted(os.listdir(outdir))
    except OSError:
        return []
    found = []
    for name in names:
        if not name.endswith(INTERMEDIATE_SUFFIXES):
            continue
        path = os.path.join(outdir, name)
        if os.path.isdir(path) and not os.path.islink(path):
            found.append(path)
    return found


def _dir_size(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass  # raced with something else; the byte count is only a log line
    return total


def prune_intermediates(outdir):
    """Delete per-segment TTS intermediates from a finished job directory.

    Returns ``(dirs_removed, bytes_freed)``.

    Never raises. By the time this runs the masters are written and the manifest
    lists them, so the job is servable — failing it over a cleanup problem would
    destroy a deliverable to reclaim disk, which is the wrong trade. Problems are
    logged and left for the retention sweep.

    Safe to delete outright since #9: each segment is copied into the shared
    cache — best effort — as soon as it is treated, rather than being promoted
    when the job finishes. Promoting only here would cache nothing for a job
    that died at segment 150 of 152, which is precisely the case that issue is
    about. `segment_cache.store` never raises, so a segment whose copy failed is
    simply re-purchased on a later run; that is the trade, not a guarantee that
    every segment reached the cache.
    """
    removed = 0
    freed = 0
    for path in intermediate_dirs(outdir):
        try:
            size = _dir_size(path)
            shutil.rmtree(path)
        except OSError as e:
            print(f"cleanup: could not remove {path}: {e}", flush=True)
            continue
        removed += 1
        freed += size
    return removed, freed
