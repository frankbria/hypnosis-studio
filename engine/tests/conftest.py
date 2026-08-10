"""Shared test helpers."""
import io
import textwrap
import tokenize

import pytest


def _blank_comments(src):
    """`src` with comment text blanked out, offsets and line numbers preserved.

    Several tests assert on the *order* of calls inside a function by comparing
    `str.index` positions. A plain substring search finds a mention of a call in
    a comment just as readily as the call itself, which silently inverts the
    result: a comment explaining why progress stops short of `job.ready()` once
    made `ready` appear to precede `prune`, while the real code was correct.

    Tokenising rather than splitting on "#" so a "#" inside a string literal — a
    URL, a colour, a format spec — is left alone. Blanking in place rather than
    deleting keeps every other offset where it was.
    """
    src = textwrap.dedent(src)
    lines = src.splitlines(keepends=True)
    for token in tokenize.generate_tokens(io.StringIO(src).readline):
        if token.type != tokenize.COMMENT:
            continue
        (row, start), (_, end) = token.start, token.end
        line = lines[row - 1]
        lines[row - 1] = line[:start] + " " * (end - start) + line[end:]
    return "".join(lines)


@pytest.fixture(scope="session")
def code_only():
    """Strip comments from source before asserting on the order of calls in it."""
    return _blank_comments


@pytest.fixture(scope="session")
def locate():
    """Position of `needle` in `haystack`, with a readable failure.

    `str.index` raises a bare ValueError when a structural test's anchor string
    has been reworded, which reads as a broken test rather than a moved call.
    """
    def _locate(haystack, needle, what="anchor"):
        at = haystack.find(needle)
        assert at >= 0, f"{what} not found in source: {needle!r}"
        return at
    return _locate
