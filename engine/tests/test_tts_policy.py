"""Tests for tts_policy — deciding whether a failed TTS call is worth retrying.

Stdlib only, like job_files/timeline/qa: render_track.py imports numpy, scipy
and av at module scope, so nothing living there is reachable from a test without
the whole audio stack.

What makes this worth its own module: a render is 152 sequential HTTPS requests
with a 120 s timeout each, and every one of them spends money. Retrying the
wrong thing burns credits on a request that can never succeed; not retrying the
right thing throws away a render over a dropped connection (issue #7).
"""
import os
import socket
import sys
import urllib.error

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ENGINE)

import tts_policy  # noqa: E402


def classify(**kw):
    return tts_policy.classify(**kw)


# --------------------------------------------------------------------------
# Network failures — the path that had no coverage at all
# --------------------------------------------------------------------------

@pytest.mark.parametrize("exc", [
    urllib.error.URLError("connection reset by peer"),
    urllib.error.URLError(socket.gaierror("Name or service not known")),
    TimeoutError("timed out"),
    socket.timeout("timed out"),
    ConnectionResetError("reset"),
    OSError("network unreachable"),
])
def test_network_failures_are_retryable(exc):
    """Across 152 sequential requests a dropped connection is the *most likely*
    way a render fails, and it was the one path with zero retries — URLError and
    socket.timeout are not HTTPError, so they fell to a bare `except Exception`
    that broke immediately."""
    outcome = classify(exception=exc)
    assert outcome.retryable, f"{type(exc).__name__} must be retried"
    assert outcome.kind == "transient"


def test_an_unexpected_exception_is_not_retried():
    """Retrying something we do not understand spends money on a guess."""
    outcome = classify(exception=ValueError("something structural"))
    assert not outcome.retryable
    assert outcome.kind == "fatal"


# --------------------------------------------------------------------------
# HTTP statuses
# --------------------------------------------------------------------------

@pytest.mark.parametrize("status", [408, 429, 500, 502, 503, 504])
def test_transient_http_statuses_are_retryable(status):
    assert classify(status=status).retryable


@pytest.mark.parametrize("status", [520, 521, 522, 523, 524])
def test_cloudflare_statuses_are_retryable(status):
    """ElevenLabs sits behind Cloudflare, whose 52x family is entirely transient
    (origin down, connection timed out, origin unreachable)."""
    assert classify(status=status).retryable, f"{status} is a Cloudflare edge error"


@pytest.mark.parametrize("status", [401, 403])
def test_auth_failures_are_fatal_and_named(status):
    outcome = classify(status=status)
    assert not outcome.retryable
    assert outcome.kind == "auth"
    assert "key" in outcome.detail.lower() or "credential" in outcome.detail.lower()


@pytest.mark.parametrize("status", [400, 404, 405, 413])
def test_permanent_client_errors_are_fatal(status):
    outcome = classify(status=status)
    assert not outcome.retryable
    assert outcome.kind == "fatal"


def test_422_asks_for_the_settings_fallback():
    """The only reason the second settings pass exists: a 422 rejecting `speed`."""
    outcome = classify(status=422)
    assert outcome.kind == "unsupported_settings"
    assert not outcome.retryable, "a 422 is retried with different settings, not the same ones"


def test_success_is_not_an_error():
    assert classify(status=200).kind == "ok"


# --------------------------------------------------------------------------
# Quota — must be distinguishable from a transient failure
# --------------------------------------------------------------------------

@pytest.mark.parametrize("body", [
    '{"detail":{"status":"quota_exceeded","message":"..."}}',
    '{"detail":"This request exceeds your quota"}',
    '{"detail":{"status":"QUOTA_EXCEEDED"}}',
])
def test_quota_exhaustion_is_recognised_from_the_body(body):
    """ElevenLabs reports exhaustion in the JSON detail and under more than one
    status code, so keying on the status alone mislabels it — as a retryable
    429, which would burn the backoff schedule on a request that cannot succeed
    until someone buys more credits."""
    outcome = classify(status=429, body=body)
    assert outcome.kind == "quota"
    assert not outcome.retryable


def test_quota_beats_an_auth_status_too():
    outcome = classify(status=401, body='{"detail":{"status":"quota_exceeded"}}')
    assert outcome.kind == "quota", "a quota body must win over the status mapping"


def test_a_plain_429_without_a_quota_body_is_still_retryable():
    """Rate limiting is exactly what the backoff is for."""
    outcome = classify(status=429, body='{"detail":"Too many requests"}')
    assert outcome.kind == "transient"
    assert outcome.retryable


def test_quota_detail_is_actionable():
    detail = classify(status=429, body='{"detail":{"status":"quota_exceeded"}}').detail
    assert "quota" in detail.lower()


def test_an_unreadable_body_does_not_break_classification():
    """e.read() can return anything, including invalid utf-8."""
    assert classify(status=500, body=b"\xff\xfe binary").retryable


# --------------------------------------------------------------------------
# Backoff
# --------------------------------------------------------------------------

def test_backoff_grows():
    delays = [tts_policy.backoff_seconds(i) for i in range(len(tts_policy.BACKOFF_S))]
    assert delays == sorted(delays)
    assert delays[0] < delays[-1], "a flat 5 s retry does not outlast a real outage"


def test_backoff_is_bounded():
    """One segment's whole retry schedule stays inside two minutes.

    The budget is per segment and a render has 152 of them, so an unbounded
    schedule multiplies. render_program stops at the first exhausted segment and
    render_track.main stops after MAX_CONSECUTIVE_TRANSIENT, but the per-segment
    bound is what keeps either of those from being slow in the first place.
    """
    assert sum(tts_policy.BACKOFF_S) <= 120


def test_attempts_are_finite():
    assert tts_policy.MAX_ATTEMPTS == len(tts_policy.BACKOFF_S) + 1


def test_backoff_past_the_end_is_clamped_not_an_error():
    assert tts_policy.backoff_seconds(99) == tts_policy.BACKOFF_S[-1]


# --------------------------------------------------------------------------
# The classification set itself
# --------------------------------------------------------------------------

def test_auth_and_retryable_sets_do_not_overlap():
    """A status that is both would make the fail-fast path unreachable."""
    assert not (set(tts_policy.AUTH_STATUSES) & set(tts_policy.RETRYABLE_STATUSES))


def test_every_kind_is_known():
    kinds = {classify(status=s).kind for s in
             (200, 400, 401, 403, 408, 422, 429, 500, 504, 520)}
    assert kinds <= tts_policy.KINDS


def test_incomplete_read_is_transient():
    """It means the connection dropped mid-body, but it inherits HTTPException
    rather than OSError, so a transient set built from OSError misses it."""
    import http.client
    assert classify(exception=http.client.IncompleteRead(b"partial")).retryable


def test_a_malformed_peer_stays_fatal():
    """IncompleteRead's HTTPException siblings describe a peer that is not
    speaking HTTP properly; retrying spends money on the same confusion."""
    import http.client
    assert not classify(exception=http.client.BadStatusLine("garbage")).retryable


@pytest.mark.parametrize("body", [
    "insufficient_quota", "credit limit reached", "quota reached",
    "quota exhausted", '{"detail":{"status":"quota_exceeded"}}',
])
def test_quota_vocabulary_is_broad_enough(body):
    assert classify(status=429, body=body).kind == "quota"


def test_unmatched_wording_degrades_to_retryable_not_to_wrongly_fatal():
    """If ElevenLabs reword the payload the check misses it and the request is
    retried — the old behaviour — rather than a healthy render being refused."""
    assert classify(status=429, body='{"detail":"some new wording"}').kind == "transient"


# --------------------------------------------------------------------------
# Response validation — a 200 is not the same as a usable segment (#8)
# --------------------------------------------------------------------------

AUDIO_CT = "audio/mpeg"


def problem(payload, text="[soft] " + "x" * 240, content_type=AUDIO_CT):
    """240 chars ~= 20 s ~= 320 KB expected at 128 kbps."""
    return tts_policy.response_problem(payload, text, content_type)


def healthy(text="[soft] " + "x" * 240):
    """Bytes a correct response would carry for `text`."""
    seconds = len(text) / tts_policy.chars_per_sec_for_sizing()
    return b"\xff\xfb" + b"\x00" * int(seconds * tts_policy.BYTES_PER_SEC)


def test_a_healthy_response_has_no_problem():
    assert problem(healthy()) is None


def test_an_empty_response_is_rejected():
    """The failure the issue opens with: np.concatenate([]) raising a NumPy
    error from inside the decoder, blaming the wrong layer entirely."""
    reason = problem(b"")
    assert reason
    assert "empty" in reason.lower()


def test_a_tiny_response_is_rejected():
    assert problem(b"\xff\xfb" + b"\x00" * 200)


def test_an_html_error_page_is_rejected():
    """Cloudflare can serve one of these with a 200."""
    page = b"<!DOCTYPE html><html><body>502 Bad Gateway</body></html>"
    assert problem(page, content_type="text/html")


def test_a_non_audio_content_type_is_rejected_even_when_large():
    """Size alone would pass this; only the declared type gives it away."""
    assert problem(b"x" * 500_000, content_type="application/json")


def test_a_missing_content_type_is_tolerated():
    """Not every proxy sets it; size still governs."""
    assert problem(healthy(), content_type=None) is None


def test_half_a_sentence_is_rejected():
    """The outcome the issue calls worse than an empty body: decodable, written
    to the segment WAV, and shipped — and per #6 nothing downstream notices,
    because one short segment does not move a whole master's level or length."""
    assert problem(healthy()[: len(healthy()) // 3])


def test_a_slightly_short_response_is_accepted():
    """The speaking-rate estimate is approximate; the floor must leave room for
    a voice that simply speaks faster than predicted."""
    assert problem(healthy()[: int(len(healthy()) * 0.8)]) is None


def test_the_floor_scales_with_the_text():
    """A long segment must not be judged against a short segment's floor."""
    short_text = "[soft] " + "x" * 40
    long_text = "[soft] " + "x" * 400
    # Bytes that are ample for the short line but a fraction of the long one.
    payload = healthy(short_text)
    assert problem(payload, text=short_text) is None
    assert problem(payload, text=long_text)


def test_the_shortest_real_segment_is_not_false_rejected():
    """40 characters is the shortest of the 768 committed segments."""
    text = "[soft] " + "x" * 33
    assert problem(healthy(text), text=text) is None


def test_a_response_is_rejected_only_far_below_the_estimate():
    """A healthy response should only trip this if the voice spoke about twice
    as fast as the conservative estimate — not reachable for speech."""
    assert tts_policy.MIN_RESPONSE_FRACTION <= 0.5


def test_the_reason_names_both_sizes():
    """Whoever reads this is debugging a paid render."""
    reason = problem(b"\xff\xfb" + b"\x00" * 500)
    assert "502" in reason.replace(",", "") or "bytes" in reason.lower(), reason


def test_an_absolute_floor_catches_junk_for_a_very_short_line():
    """Even a one-word segment cannot legitimately be a few hundred bytes."""
    tiny_text = "[soft] hi"
    assert problem(b"x" * 50, text=tiny_text)


def test_the_absolute_floor_covers_a_degenerate_empty_text():
    """The only case the text-derived floor cannot reach.

    That floor is `len(text)/rate * BYTES_PER_SEC * fraction`, so an empty or
    near-empty text predicts ~0 bytes and would accept any non-empty junk. Every
    real segment is 40+ characters, which is exactly why this needs its own
    guard rather than being folded into the fraction.
    """
    assert tts_policy.response_problem(b"x" * 500, text="") is not None
    assert tts_policy.response_problem(b"x" * 500, text="a") is not None
