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

    Any rebinding of a full-rate array whose right-hand side calls something has
    to say what dtype it lands in — a call may promote, and one that does
    silently reverts everything downstream. Reading a file or allocating
    establishes the dtype instead of restoring it, so those are exempt.

    Matching on "the RHS contains a call" rather than "the RHS starts with a
    call", because `mix = (sosfiltfilt(...))` and `mix = f(x) + voice` are the
    same hazard written differently.
    """
    offenders = []
    for ln in source.splitlines():
        m = re.match(r"^\s*(mix|pad|voice)\s*=\s*(.+)$", ln)
        if not m:
            continue
        name, rhs = m.group(1), m.group(2)
        # A slice of the same array preserves dtype, even though the index
        # expression may itself contain a call: `pad = pad[: int(x * SR)]`.
        if re.match(rf"\s*{name}\s*\[", rhs):
            continue
        if not re.search(r"\w\(", rhs):
            continue                      # no call: no promotion to undo
        if re.match(r"\s*(sf\.read|np\.zeros|np\.zeros_like)", rhs):
            continue                      # establishes the dtype
        if "dtype=" in ln or "astype(DTYPE" in ln:
            continue
        offenders.append(ln.strip())
    assert not offenders, (
        "these rebind a full-rate array through a call without pinning DTYPE, "
        f"which silently reverts everything downstream to float64: {offenders}")


def test_the_dtype_restoration_count_does_not_regress(source):
    """A blunt tripwire on the pattern being eroded.

    Deliberately not called a per-operation fence: it counts *all* occurrences,
    so swapping one cast for another elsewhere leaves the total unchanged and
    this stays green. The floor is the current count, so any net removal trips
    it — which is the most this assertion can honestly claim.
    """
    casts = source.count("astype(DTYPE, copy=False)")
    assert casts >= 6, f"only {casts} DTYPE restorations left; the pattern is eroding"
