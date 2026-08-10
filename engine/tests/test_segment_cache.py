"""Tests for segment_cache — shared storage for already-purchased TTS segments.

Stdlib only, like job_files/timeline/qa/tts_policy.

Why this exists: the idempotency the README advertises is scoped to `outdir`,
and server.js mints a fresh empty job directory on every POST. So a
customer-visible retry re-buys everything — one transient failure on segment 150
of 152 discards ~20 minutes and the whole 17k-22k character spend, and the ~150
already-voiced WAVs are stranded in the dead job directory (issue #9).

Segment audio is a pure function of (voice id, tag, text). Not bit-identical
across calls — TTS is not deterministic — but semantically interchangeable,
which is what makes sharing safe.
"""
import os
import sys

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ENGINE)

import segment_cache  # noqa: E402

VOICE = "nPczCjzI2devNBz1zQrb"
TAG = "[soft] "
TEXT = "Let your shoulders soften."


# --------------------------------------------------------------------------
# The key
# --------------------------------------------------------------------------

def test_the_same_segment_gets_the_same_key():
    assert segment_cache.key(VOICE, TAG, TEXT) == segment_cache.key(VOICE, TAG, TEXT)


@pytest.mark.parametrize("voice,tag,text", [
    ("other-voice", TAG, TEXT),
    (VOICE, "[whispering] ", TEXT),
    (VOICE, TAG, "Let your shoulders soften. "),
])
def test_any_input_change_changes_the_key(voice, tag, text):
    """A script edit must miss the cache automatically — there is no
    invalidation step to forget."""
    assert segment_cache.key(voice, tag, text) != segment_cache.key(VOICE, TAG, TEXT)


def test_the_key_cannot_be_confused_by_concatenation():
    """Joining the fields without a separator would make ("ab","c") and
    ("a","bc") collide, silently serving one segment's audio for another."""
    assert segment_cache.key("ab", "c", TEXT) != segment_cache.key("a", "bc", TEXT)


def test_the_key_is_a_safe_filename():
    k = segment_cache.key(VOICE, "[whispering] ", "text with / and .. and \0")
    assert k.isalnum(), k
    assert len(k) >= 32


def test_the_whisper_tag_is_part_of_the_key():
    """The same words rendered by the narrator and by the whisper voice are
    different audio; sharing them would swap voices mid-track."""
    assert (segment_cache.key(VOICE, "[soft] ", TEXT)
            != segment_cache.key(VOICE, "[whispering] ", TEXT))


# --------------------------------------------------------------------------
# store / lookup
# --------------------------------------------------------------------------

def test_a_miss_returns_none(tmp_path):
    assert segment_cache.lookup(str(tmp_path), VOICE, TAG, TEXT) is None


def test_a_stored_segment_is_found_again(tmp_path):
    src = tmp_path / "seg.wav"
    src.write_bytes(b"RIFF....audio")
    segment_cache.store(str(tmp_path / "cache"), VOICE, TAG, TEXT, str(src))
    hit = segment_cache.lookup(str(tmp_path / "cache"), VOICE, TAG, TEXT)
    assert hit and os.path.exists(hit)
    assert open(hit, "rb").read() == b"RIFF....audio"


def test_storing_twice_is_harmless(tmp_path):
    src = tmp_path / "seg.wav"
    src.write_bytes(b"audio")
    cache = str(tmp_path / "cache")
    segment_cache.store(cache, VOICE, TAG, TEXT, str(src))
    segment_cache.store(cache, VOICE, TAG, TEXT, str(src))
    assert segment_cache.lookup(cache, VOICE, TAG, TEXT)


def test_entries_are_fanned_out_into_subdirectories(tmp_path):
    """A flat directory of thousands of segments is slow to list and unpleasant
    to look at on a server."""
    cache = str(tmp_path / "cache")
    src = tmp_path / "s.wav"
    src.write_bytes(b"audio")
    segment_cache.store(cache, VOICE, TAG, TEXT, str(src))
    hit = segment_cache.lookup(cache, VOICE, TAG, TEXT)
    assert os.path.dirname(os.path.dirname(hit)) == cache, hit


def test_a_partial_write_never_becomes_a_cache_hit(tmp_path, monkeypatch):
    """An entry must be complete or absent. A half-copied WAV that looked like a
    hit would poison every future job for that segment — and unlike a bad
    download, nothing would ever re-fetch it."""
    cache = str(tmp_path / "cache")
    src = tmp_path / "s.wav"
    src.write_bytes(b"audio")

    def partial_then_fail(source, dest):
        # A real interrupted copy leaves bytes behind. Failing *before* writing
        # anything would pass whether or not the write is atomic, which is the
        # thing under test.
        with open(dest, "wb") as f:
            f.write(b"aud")
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(segment_cache.shutil, "copyfile", partial_then_fail)
    segment_cache.store(cache, VOICE, TAG, TEXT, str(src))
    assert segment_cache.lookup(cache, VOICE, TAG, TEXT) is None
    leftovers = [f for _r, _d, fs in os.walk(cache) for f in fs]
    assert leftovers == [], f"a partial entry survived: {leftovers}"


def test_store_never_raises(tmp_path):
    """A cache is an optimisation. Failing a paid render because the cache is
    unwritable would be the wrong trade."""
    segment_cache.store("/proc/nonexistent/cache", VOICE, TAG, TEXT, "/nope.wav")


def test_lookup_never_raises_on_a_broken_cache(tmp_path):
    assert segment_cache.lookup("/proc/nonexistent/cache", VOICE, TAG, TEXT) is None


# --------------------------------------------------------------------------
# The sweep
# --------------------------------------------------------------------------

def fill(cache, n, size=1000, start_mtime=1_700_000_000):
    """n entries, oldest first."""
    paths = []
    for i in range(n):
        src = os.path.join(cache, f"src{i}.tmp")
        os.makedirs(cache, exist_ok=True)
        with open(src, "wb") as f:
            f.write(b"x" * size)
        segment_cache.store(cache, VOICE, TAG, f"segment number {i}", src)
        os.remove(src)
        p = segment_cache.lookup(cache, VOICE, TAG, f"segment number {i}")
        os.utime(p, (start_mtime + i, start_mtime + i))
        paths.append(p)
    return paths


def test_the_sweep_keeps_everything_under_the_ceiling(tmp_path):
    cache = str(tmp_path / "c")
    fill(cache, 5, size=1000)
    removed, freed = segment_cache.sweep(cache, max_bytes=10_000)
    assert removed == 0 and freed == 0


def test_the_sweep_evicts_oldest_first(tmp_path):
    """LRU by mtime: the segments least recently used by a render go first."""
    cache = str(tmp_path / "c")
    paths = fill(cache, 5, size=1000)
    removed, freed = segment_cache.sweep(cache, max_bytes=2500)
    assert removed >= 2
    assert not os.path.exists(paths[0]), "the oldest entry should go first"
    assert os.path.exists(paths[-1]), "the newest entry should survive"


def test_the_sweep_stops_once_under_the_ceiling(tmp_path):
    cache = str(tmp_path / "c")
    fill(cache, 6, size=1000)
    segment_cache.sweep(cache, max_bytes=3500)
    assert segment_cache.total_bytes(cache) <= 3500


def test_a_hit_refreshes_an_entry_against_the_sweep(tmp_path):
    """Otherwise a segment used by every job would still be evicted for being
    old, which is the opposite of what a cache is for."""
    cache = str(tmp_path / "c")
    paths = fill(cache, 4, size=1000)
    segment_cache.lookup(cache, VOICE, TAG, "segment number 0")
    segment_cache.sweep(cache, max_bytes=2500)
    assert os.path.exists(paths[0]), "the entry just used should have survived"


def test_the_sweep_never_raises_on_a_missing_cache(tmp_path):
    assert segment_cache.sweep(str(tmp_path / "absent"), max_bytes=10) == (0, 0)


def test_the_sweep_ignores_files_it_did_not_create(tmp_path):
    """The cache lives under RENDERS/; the sweep must only ever delete its own
    entries, never something that happens to share the directory."""
    cache = str(tmp_path / "c")
    fill(cache, 3, size=1000)
    stray = os.path.join(cache, "README.txt")
    with open(stray, "w") as f:
        f.write("not a segment")
    segment_cache.sweep(cache, max_bytes=0)
    assert os.path.exists(stray), "the sweep deleted a file it did not create"


def test_the_ceiling_holds_more_than_one_full_goal(tmp_path):
    """~152 segments at ~530 KB is ~80 MB per (goal, voice set). A ceiling below
    that would thrash — every job evicting the previous job's work."""
    assert segment_cache.DEFAULT_MAX_BYTES >= 160 * 1024 * 1024
