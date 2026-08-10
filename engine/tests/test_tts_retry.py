"""tts() itself: how many calls it makes, and how many it refuses to make.

test_tts_policy.py covers the classification. This drives the real retry loop
against a fake urlopen, because the bugs in #7 were in the *control flow*, not
the decision: network errors never reached a retry, and every permanent error
fell through to a second complete settings pass.

Call counts are the assertions that matter. Each one is a billable request.

render_track imports numpy/scipy/av at module scope, so those are stubbed to
import it; time.sleep is stubbed so the real 5/15/30 s backoff does not make the
suite take a minute.
"""
import os
import socket
import sys
import types
import urllib.error

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ENGINE)

import tts_policy  # noqa: E402


def _stub_if_missing(name, **attrs):
    """Install a stand-in for `name` only when the real package is absent.

    Stubbing unconditionally breaks on the real thing: render_track annotates
    `treat(y: np.ndarray, ...)`, and an annotation is evaluated when the module
    is imported, so a bare ModuleType named "numpy" raises AttributeError before
    any test runs.
    """
    try:
        __import__(name)
        return False
    except ImportError:
        module = types.ModuleType(name)
        for key, value in attrs.items():
            setattr(module, key, value)
        sys.modules[name] = module
        return True


@pytest.fixture()
def render_track(monkeypatch, tmp_path):
    """render_track with its audio stack satisfied and sleeping disabled.

    None of numpy/scipy/av matter to tts(); they are module-scope imports that
    would otherwise make render_track unimportable wherever the audio stack is
    not installed.
    """
    names = ("numpy", "soundfile", "av", "scipy", "scipy.signal")
    saved = {k: sys.modules.get(k) for k in names}
    stubbed = []

    if _stub_if_missing("numpy", ndarray=object):
        stubbed.append("numpy")
    for name in ("soundfile", "av", "scipy"):
        if _stub_if_missing(name):
            stubbed.append(name)
    if _stub_if_missing("scipy.signal",
                        lfilter=lambda *a, **k: None,
                        fftconvolve=lambda *a, **k: None):
        stubbed.append("scipy.signal")

    sys.modules.pop("render_track", None)
    import render_track as rt

    rt.KEY = "test-key"
    monkeypatch.setattr(rt.time, "sleep", lambda s: None)

    yield rt

    sys.modules.pop("render_track", None)
    for name in stubbed:
        sys.modules.pop(name, None)
    for name, mod in saved.items():
        if mod is not None:
            sys.modules[name] = mod


class Recorder:
    """Stands in for urllib.request.urlopen, recording every call."""

    def __init__(self, *results):
        self.results = list(results)
        self.calls = 0

    def __call__(self, req, timeout=None):
        self.calls += 1
        result = self.results[min(self.calls - 1, len(self.results) - 1)]
        if isinstance(result, Exception):
            raise result
        return result


class Response:
    """A urlopen success: a context manager whose read() returns audio bytes."""

    def __init__(self, payload=b"ID3fake-mp3-bytes"):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self.payload


def http_error(code, body=b""):
    return urllib.error.HTTPError(
        "http://x", code, "err", {}, __import__("io").BytesIO(body))


def drive(render_track, monkeypatch, tmp_path, *results):
    fake = Recorder(*results)
    monkeypatch.setattr(render_track.urllib.request, "urlopen", fake)
    out = str(tmp_path / "seg.mp3")
    return fake, out


# --------------------------------------------------------------------------
# The happy path stays a single call
# --------------------------------------------------------------------------

def test_a_successful_call_writes_the_file_once(render_track, monkeypatch, tmp_path):
    fake, out = drive(render_track, monkeypatch, tmp_path, Response(b"audio"))
    assert render_track.tts("voice", "hello", out) is True
    assert fake.calls == 1
    assert open(out, "rb").read() == b"audio"


# --------------------------------------------------------------------------
# Network failures — previously zero retries
# --------------------------------------------------------------------------

@pytest.mark.parametrize("exc", [
    urllib.error.URLError("connection reset"),
    TimeoutError("timed out"),
    socket.timeout("timed out"),
    ConnectionResetError("reset by peer"),
])
def test_a_network_failure_is_retried(render_track, monkeypatch, tmp_path, exc):
    """Previously these hit `except Exception: break` and were never retried —
    the single likeliest way a 152-request render dies."""
    fake, out = drive(render_track, monkeypatch, tmp_path, exc, Response(b"audio"))
    assert render_track.tts("voice", "hi", out) is True
    assert fake.calls == 2, "the second attempt should have succeeded"


def test_network_failures_eventually_give_up(render_track, monkeypatch, tmp_path):
    fake, out = drive(render_track, monkeypatch, tmp_path,
                      urllib.error.URLError("down"))
    with pytest.raises(render_track.TtsError) as exc:
        render_track.tts("voice", "hi", out)
    assert exc.value.kind == "transient"
    assert fake.calls == tts_policy.MAX_ATTEMPTS, (
        "one settings pass only — a network outage is not a settings problem")


def test_a_late_recovery_still_succeeds(render_track, monkeypatch, tmp_path):
    fake, out = drive(render_track, monkeypatch, tmp_path,
                      TimeoutError("t"), TimeoutError("t"), Response(b"ok"))
    assert render_track.tts("voice", "hi", out) is True
    assert fake.calls == 3


# --------------------------------------------------------------------------
# Retryable HTTP
# --------------------------------------------------------------------------

@pytest.mark.parametrize("code", [429, 500, 503, 504, 522])
def test_retryable_statuses_are_retried(render_track, monkeypatch, tmp_path, code):
    fake, out = drive(render_track, monkeypatch, tmp_path,
                      http_error(code), Response(b"audio"))
    assert render_track.tts("voice", "hi", out) is True
    assert fake.calls == 2


def test_backoff_is_actually_waited(render_track, monkeypatch, tmp_path):
    """A retry loop that does not sleep is a way to hit the rate limit harder."""
    waits = []
    monkeypatch.setattr(render_track.time, "sleep", waits.append)
    fake, out = drive(render_track, monkeypatch, tmp_path,
                      http_error(503), http_error(503), Response(b"a"))
    render_track.tts("voice", "hi", out)
    assert waits == [tts_policy.backoff_seconds(0), tts_policy.backoff_seconds(1)]


# --------------------------------------------------------------------------
# Fail fast — the wasted-request half of the bug
# --------------------------------------------------------------------------

@pytest.mark.parametrize("code", [401, 403])
def test_auth_failure_costs_exactly_one_call(render_track, monkeypatch, tmp_path, code):
    """The old flow made a second full attempt with the fallback settings for
    every permanent error, so a dead key cost two billable calls per segment
    across all 152."""
    fake, out = drive(render_track, monkeypatch, tmp_path, http_error(code))
    with pytest.raises(render_track.TtsError) as exc:
        render_track.tts("voice", "hi", out)
    assert exc.value.kind == "auth"
    assert fake.calls == 1, "no retry and no second settings pass for a bad key"


def test_quota_exhaustion_costs_exactly_one_call(render_track, monkeypatch, tmp_path):
    fake, out = drive(render_track, monkeypatch, tmp_path,
                      http_error(429, b'{"detail":{"status":"quota_exceeded"}}'))
    with pytest.raises(render_track.TtsError) as exc:
        render_track.tts("voice", "hi", out)
    assert exc.value.kind == "quota"
    assert fake.calls == 1, (
        "a quota 429 must not burn the retry schedule — no amount of waiting "
        "buys more credits")


def test_a_permanent_client_error_does_not_get_a_second_settings_pass(
        render_track, monkeypatch, tmp_path):
    fake, out = drive(render_track, monkeypatch, tmp_path, http_error(400))
    with pytest.raises(render_track.TtsError) as exc:
        render_track.tts("voice", "hi", out)
    assert exc.value.kind == "fatal"
    assert fake.calls == 1


# --------------------------------------------------------------------------
# The settings fallback — what the outer loop is actually for
# --------------------------------------------------------------------------

def test_422_falls_back_to_the_reduced_settings(render_track, monkeypatch, tmp_path):
    """The outer loop exists for exactly this: the API rejecting `speed`."""
    fake, out = drive(render_track, monkeypatch, tmp_path,
                      http_error(422), Response(b"audio"))
    assert render_track.tts("voice", "hi", out) is True
    assert fake.calls == 2


def test_the_fallback_request_drops_the_speed_parameter(render_track, monkeypatch, tmp_path):
    sent = []

    def capture(req, timeout=None):
        sent.append(__import__("json").loads(req.data.decode()))
        if len(sent) == 1:
            raise http_error(422)
        return Response(b"audio")

    monkeypatch.setattr(render_track.urllib.request, "urlopen", capture)
    render_track.tts("voice", "hi", str(tmp_path / "s.mp3"))
    assert "speed" in sent[0]["voice_settings"]
    assert "speed" not in sent[1]["voice_settings"], (
        "the fallback exists to drop the parameter the API rejected")


def test_both_settings_rejected_returns_false(render_track, monkeypatch, tmp_path):
    fake, out = drive(render_track, monkeypatch, tmp_path, http_error(422))
    assert render_track.tts("voice", "hi", out) is False
    assert fake.calls == 2


def test_a_network_failure_after_the_fallback_is_still_retried(
        render_track, monkeypatch, tmp_path):
    """422 then a blip: the retry budget applies to the second pass too."""
    fake, out = drive(render_track, monkeypatch, tmp_path,
                      http_error(422), TimeoutError("t"), Response(b"audio"))
    assert render_track.tts("voice", "hi", out) is True
    assert fake.calls == 3


# --------------------------------------------------------------------------
# Nothing is written when the call fails
# --------------------------------------------------------------------------

def test_no_file_is_written_on_failure(render_track, monkeypatch, tmp_path):
    fake, out = drive(render_track, monkeypatch, tmp_path, http_error(401))
    with pytest.raises(render_track.TtsError):
        render_track.tts("voice", "hi", out)
    assert not os.path.exists(out), "a failed call must not leave a partial file"
