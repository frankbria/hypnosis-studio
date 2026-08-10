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
    """152 segments x a runaway schedule would outlive the job's own timeout."""
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
