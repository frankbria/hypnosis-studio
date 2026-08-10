"""The float32 flag must survive to the end of the run (issue #12).

assemble_track.py does its work at module import time, so it cannot be imported
in a test — these assert on its source. Comments are stripped first, via the
same fixture the ordering tests use: the code here is *about* sosfiltfilt and
dtype, so a naive substring search matches the prose describing the fix rather
than the fix.

Why it is worth pinning: HYPNO_DTYPE=float32 exists to halve mixer RAM on a 4 GB
box with a documented OOM history, and one full-rate operation that forgets
`.astype(DTYPE, copy=False)` silently reverts everything downstream of it to
float64. That is what happened at the notch filter — bed accumulation, fade,
normalise, soft clip and both writes all ran float64 while the flag said
otherwise.
"""
import os
import re
import sys

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ENGINE)

ASSEMBLER = os.path.join(ENGINE, "assemble_track.py")


@pytest.fixture(scope="module")
def source(code_only):
    with open(ASSEMBLER, encoding="utf-8") as f:
        return code_only(f.read())


def test_the_notch_filter_restores_the_dtype(source):
    """The line that defeated the flag."""
    line = next((ln for ln in source.splitlines()
                 if ln.strip().startswith("mix = sosfiltfilt(")), None)
    assert line is not None, "the mix notch filter is gone; this test needs updating"
    assert "astype(DTYPE" in line, (
        "sosfiltfilt promotes float32 to float64 against float64 coefficients, so "
        "without a cast back HYPNO_DTYPE=float32 stops working from here on")


def test_the_pad_is_not_filtered_into_the_void(source):
    """`pad = sosfiltfilt(...)` produced a full-length float64 array that nothing
    read — its only remaining reference was `del pad` on the next line — and it
    stayed live while the same filter ran for `mix`."""
    assert not re.search(r"^\s*pad\s*=\s*sosfiltfilt\(", source, re.M), (
        "the discarded pad filter pass is back")


def test_every_full_rate_assignment_restores_the_dtype(source):
    """A guard for the next one added, not just the one that was wrong.

    Only whole-array operations matter — the chunked writes into `pad[c0:c1]`
    and friends already carry the cast, and this catches a new full-rate
    rebinding of `mix` or `pad` that forgets it.
    """
    offenders = []
    for ln in source.splitlines():
        m = re.match(r"^\s*(mix|pad|voice)\s*=\s*(\w+)\(", ln)
        if not m:
            continue
        name, fn = m.groups()
        # Reading a file or allocating establishes the dtype rather than
        # needing it restored.
        if fn in ("sf", "np", "float", "int"):
            continue
        if "dtype=" in ln or "astype(DTYPE" in ln or "zeros_like" in ln:
            continue
        offenders.append(ln.strip())
    assert not offenders, (
        "these rebind a full-rate array without restoring DTYPE, which silently "
        f"reverts everything downstream to float64: {offenders}")


def test_the_chunked_operations_still_carry_the_cast(source):
    """The ones that were already right — a regression fence, since they are the
    pattern the failing line was inconsistent with."""
    casts = source.count("astype(DTYPE, copy=False)")
    assert casts >= 5, f"only {casts} DTYPE restorations left; several have gone missing"
