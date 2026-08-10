"""Whether a failed ElevenLabs call is worth trying again, and how long to wait.

Stdlib only, on purpose — the same reason as job_files.py, timeline.py and
qa.py. render_track.py imports numpy, scipy and av at module scope, so nothing
that lives there can be exercised in a test without the whole audio stack.

The stakes: a render is 152 sequential HTTPS requests with a 120 s timeout each,
and every one of them costs money. Retrying the wrong error spends credits on a
request that cannot succeed; not retrying the right one throws away a paid
render because a TCP connection dropped (issue #7).
"""
import collections
import http.client
import re

Outcome = collections.namedtuple("Outcome", "kind retryable detail")

KINDS = {"ok", "transient", "auth", "quota", "unsupported_settings", "fatal"}

# 408 request timeout, 429 rate limit, 5xx origin failures, and Cloudflare's
# 520-524 (ElevenLabs sits behind it: 520 unknown, 521 origin down, 522
# connection timed out, 523 origin unreachable, 524 origin timeout). All of
# these describe "try again", none describe "this request is wrong".
RETRYABLE_STATUSES = frozenset(
    {408, 429, 500, 502, 503, 504} | set(range(520, 525)))

# A dead or wrong key. Retrying cannot fix it and the second settings pass is
# just a second wasted request.
AUTH_STATUSES = frozenset({401, 403})

# The one case the settings fallback exists for: the API rejecting the `speed`
# parameter. Retried with different settings, never with the same ones.
UNSUPPORTED_SETTINGS_STATUSES = frozenset({422})

# Deterministic, no jitter. The server takes one render at a time behind the
# concurrency lock, so there is no thundering herd to spread out, and a fixed
# schedule is testable. Bounded so 152 segments cannot outlive the job.
BACKOFF_S = (5, 15, 30)
MAX_ATTEMPTS = len(BACKOFF_S) + 1

# Exhaustion is reported inside the JSON detail rather than by a dedicated
# status, and shows up under more than one code, so the body is the reliable
# signal. Without this a quota failure looks like a plain 429 and burns the
# whole backoff schedule on a request that cannot succeed until someone buys
# more credits.
_QUOTA_MARKER = re.compile(
    r"quota[_ ]?(?:exceeded|reached|exhausted)"
    r"|(?:insufficient|exceeded)[_ ]?quota"
    r"|exceeds your quota"
    r"|out of credits"
    r"|credit[_ ]?limit[_ ]?(?:reached|exceeded)",
    re.IGNORECASE)

# Errors that mean "the connection failed", not "the request was wrong".
# URLError and socket.timeout are not HTTPError, which is exactly why they used
# to fall through to a bare `except Exception` and get no retry at all.
#
# IncompleteRead is listed separately because it does NOT inherit from OSError —
# it is an http.client.HTTPException — yet it means precisely "the connection
# dropped part-way through the response", which is the definition of transient.
# Its HTTPException siblings are left fatal on purpose: BadStatusLine and
# UnknownProtocol describe a peer that is not speaking HTTP properly, and
# retrying that just spends money on the same confusion.
_TRANSIENT_EXCEPTIONS = (TimeoutError, ConnectionError, OSError,
                         http.client.IncompleteRead)


def _as_text(body):
    """Response bodies are bytes of unknown encoding, and may not be text."""
    if body is None:
        return ""
    if isinstance(body, bytes):
        return body.decode("utf-8", errors="replace")
    return str(body)


def classify(status=None, exception=None, body=""):
    """How to treat a TTS attempt's result.

    Pass the HTTP status for a response, or the exception for a failed
    connection. `body` is the response text when there is one; quota exhaustion
    is only visible there.
    """
    text = _as_text(body)

    # Quota first: it is reported under several statuses, including ones that
    # otherwise mean "retry" (429) or "bad key" (401). Mislabelling it as
    # transient would spend the whole backoff on a request that cannot succeed.
    if text and _QUOTA_MARKER.search(text):
        return Outcome("quota", False,
                       "ElevenLabs quota exhausted — the account is out of "
                       "credits, so no retry can succeed")

    if exception is not None:
        # urllib.error.URLError subclasses OSError, so it is covered here along
        # with socket.timeout, connection resets and DNS failures.
        if isinstance(exception, _TRANSIENT_EXCEPTIONS):
            return Outcome("transient", True,
                           f"network failure: {exception.__class__.__name__}: {exception}")
        return Outcome("fatal", False,
                       f"unexpected error: {exception.__class__.__name__}: {exception}")

    if status is None:
        return Outcome("fatal", False, "no status and no exception to classify")

    if 200 <= status < 300:
        return Outcome("ok", False, "")

    if status in AUTH_STATUSES:
        return Outcome("auth", False,
                       f"HTTP {status} — the ElevenLabs API key was rejected; "
                       f"check the credential rather than retrying")

    if status in UNSUPPORTED_SETTINGS_STATUSES:
        return Outcome("unsupported_settings", False,
                       f"HTTP {status} — the request settings were rejected; "
                       f"retrying with the reduced voice settings")

    if status in RETRYABLE_STATUSES:
        return Outcome("transient", True, f"HTTP {status}: {text[:200]}")

    return Outcome("fatal", False, f"HTTP {status}: {text[:200]}")


# The request asks for output_format=mp3_44100_128, so a healthy response is
# 128 kbps CBR. Written down as the assumption it is: if ElevenLabs ever serve
# VBR for that format the floor goes loose rather than wrong — it would
# under-reject, never over-reject.
BYTES_PER_SEC = 16000

# How much of the predicted size a response must reach. The prediction comes
# from the text being sent, so it scales with the segment: 40 characters (the
# shortest of the 768 committed) predicts ~53 KB, 443 (the longest) ~591 KB.
#
# A fixed byte floor would only catch empty-and-tiny. This catches the case the
# issue calls worse — a decodable half-sentence that is written to the segment
# WAV and ships, which per #6 nothing downstream notices, since one short
# segment does not move a whole master's level or length.
#
# At 0.5 a healthy response only trips this if the voice spoke faster than
# ~24 chars/s, double the estimate and nearly double the ~12.75 measured.
MIN_RESPONSE_FRACTION = 0.5

# A second, text-independent floor, so junk is caught even for a one-word line
# whose predicted size is small.
ABSOLUTE_MIN_BYTES = 2000


def chars_per_sec_for_sizing():
    """Speaking rate used to predict a response's size.

    Imported lazily so this module stays stdlib-only at import time: timeline
    owns the rate and its calibration, and duplicating the constant here is how
    the two silently drift apart.
    """
    import timeline
    return timeline.chars_per_sec()


def response_problem(payload, text, content_type=None):
    """Why this response is not a usable segment, or None if it is.

    `tts()` used to write whatever arrived and return True, so a truncated or
    empty 200 — a proxy hiccup, a mid-stream abort, an error page served with
    the wrong status — was recorded as success (issue #8).
    """
    size = len(payload or b"")
    if size == 0:
        return "the response body was empty — no audio was returned"

    # An HTML error page behind a 200 is a real failure mode at a CDN edge.
    # Absent or generic types are tolerated: not every proxy sets one, and size
    # still governs.
    if content_type and not (content_type.startswith("audio/")
                             or content_type == "application/octet-stream"):
        return (f"the response was {content_type}, not audio "
                f"({size} bytes) — probably an error page")

    if size < ABSOLUTE_MIN_BYTES:
        return (f"the response was {size} bytes, below the "
                f"{ABSOLUTE_MIN_BYTES}-byte floor — too small to be a segment")

    expected_s = len(text) / chars_per_sec_for_sizing()
    floor = expected_s * BYTES_PER_SEC * MIN_RESPONSE_FRACTION
    if size < floor:
        return (f"the response was {size} bytes for {len(text)} characters, "
                f"under the {floor:.0f}-byte floor for ~{expected_s:.0f}s of "
                f"speech — the audio looks truncated")

    return None


def backoff_seconds(attempt):
    """Seconds to wait before retry number `attempt` (0-based), clamped."""
    if attempt < 0:
        attempt = 0
    return BACKOFF_S[min(attempt, len(BACKOFF_S) - 1)]
