"""Shared store for TTS segments that have already been paid for.

Stdlib only, on purpose — the same reason as job_files.py, timeline.py, qa.py
and tts_policy.py.

The idempotency render_program advertises is real but scoped to `outdir`, and
server.js mints a fresh empty job directory on every POST. So a customer-visible
retry re-buys everything: one transient failure on segment 150 of 152 throws
away ~20 minutes of wall clock and the entire 17k-22k character spend, and the
~150 already-voiced WAVs are stranded in the dead job directory (issue #9).

Segment audio is a pure function of `(voice_id, tag, text)`. Not bit-identical
across calls — ElevenLabs is not deterministic — but semantically
interchangeable, which is what makes sharing safe. Keying on content also means
a script edit misses the cache automatically; there is no invalidation step to
forget.

What is stored is the *treated* WAV, not the raw MP3: that is what the assembler
reads, and `treat()` is deterministic (seeded `default_rng(7)`), so caching after
treatment saves the decode and reverb on every hit as well as the purchase.
"""
import hashlib
import os
import shutil

# ~530 KB per treated segment x ~152 per (goal, voice set) is ~80 MB. The ceiling
# has to clear one full goal comfortably or the cache thrashes — every job
# evicting the previous job's work and buying it all again, which is worse than
# having no cache at all.
DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024

CACHE_DIR_ENV = "SEGMENT_CACHE_DIR"
MAX_BYTES_ENV = "SEGMENT_CACHE_MAX_BYTES"

# Entries are `<cache>/<first two hex chars>/<full hash>.wav`. The suffix is how
# the sweep recognises its own files: the cache directory lives under RENDERS/
# and must never delete something that merely shares the directory.
ENTRY_SUFFIX = ".wav"


def key(voice_id, tag, text):
    """Content address for one segment.

    The fields are NUL-separated rather than concatenated: joining them plainly
    would make ("ab", "c") and ("a", "bc") collide, which would serve one
    segment's audio in another's place — a silent, undetectable defect.
    """
    digest = hashlib.sha256()
    for field in (voice_id, tag, text):
        digest.update(field.encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


def entry_path(cache_dir, voice_id, tag, text):
    h = key(voice_id, tag, text)
    return os.path.join(cache_dir, h[:2], h + ENTRY_SUFFIX)


def lookup(cache_dir, voice_id, tag, text):
    """Path to a cached segment, or None.

    Touches the entry on a hit so the sweep's LRU ordering reflects use rather
    than age — otherwise a segment every job needs would still be evicted for
    being old, which is the opposite of what a cache is for.
    """
    path = entry_path(cache_dir, voice_id, tag, text)
    try:
        if not os.path.isfile(path):
            return None
        os.utime(path, None)
        return path
    except OSError:
        return None


def store(cache_dir, voice_id, tag, text, src_path):
    """Copy a rendered segment into the cache. Never raises.

    A cache is an optimisation; failing a paid render because it could not be
    written would be the wrong trade. Written to a temp name and renamed, so an
    entry is either complete or absent — a half-copied WAV that still looked
    like a hit would poison every future job for that segment, and unlike a bad
    download nothing would ever re-fetch it.
    """
    path = entry_path(cache_dir, voice_id, tag, text)
    tmp = path + f".{os.getpid()}.tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        shutil.copyfile(src_path, tmp)
        os.replace(tmp, path)
    except OSError as e:
        print(f"segment cache: could not store {os.path.basename(path)}: {e}",
              flush=True)
        try:
            os.remove(tmp)
        except OSError:
            pass


def entries(cache_dir):
    """(path, size, mtime) for every file this module created."""
    found = []
    for root, _dirs, files in os.walk(cache_dir):
        for name in files:
            if not name.endswith(ENTRY_SUFFIX):
                continue
            path = os.path.join(root, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            found.append((path, st.st_size, st.st_mtime))
    return found


def total_bytes(cache_dir):
    return sum(size for _p, size, _m in entries(cache_dir))


def sweep(cache_dir, max_bytes=None):
    """Evict least-recently-used entries until the cache fits. Never raises.

    Returns ``(removed, bytes_freed)``. Only files this module wrote are
    considered — the cache sits under RENDERS/ and must never remove something
    that merely shares the directory.
    """
    if max_bytes is None:
        max_bytes = configured_max_bytes()

    found = entries(cache_dir)
    total = sum(size for _p, size, _m in found)
    if total <= max_bytes:
        return 0, 0

    removed = 0
    freed = 0
    for path, size, _mtime in sorted(found, key=lambda e: e[2]):
        if total <= max_bytes:
            break
        try:
            os.remove(path)
        except OSError as e:
            print(f"segment cache: could not evict {path}: {e}", flush=True)
            continue
        total -= size
        removed += 1
        freed += size
    return removed, freed


def configured_dir(renders_dir):
    """Where the cache lives.

    Under RENDERS/ by default, with a name that deliberately does not match the
    `^job_` pattern the retention sweep uses to decide what it may delete — so
    that sweep cannot eat the cache.
    """
    return os.environ.get(CACHE_DIR_ENV) or os.path.join(renders_dir, "segment-cache")


def configured_max_bytes():
    raw = os.environ.get(MAX_BYTES_ENV)
    if not raw:
        return DEFAULT_MAX_BYTES
    try:
        value = int(raw)
    except ValueError:
        raise ValueError(f"{MAX_BYTES_ENV} must be an integer, got {raw!r}")
    if value <= 0:
        raise ValueError(f"{MAX_BYTES_ENV} must be positive, got {raw!r}")
    return value
