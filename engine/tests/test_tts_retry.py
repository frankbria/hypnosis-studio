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


# --------------------------------------------------------------------------
# Local I/O must never be billed as a network failure
# --------------------------------------------------------------------------

def test_a_write_failure_does_not_buy_the_segment_again(
        render_track, monkeypatch, tmp_path):
    """A disk-full OSError is an OSError, so leaving the write inside the
    classified try would mark a *local* failure transient and re-buy identical
    audio up to four times, failing to write it each time.

    The old code broke immediately here, so getting this wrong would have been a
    regression in exactly the dimension this issue is about.
    """
    fake, out = drive(render_track, monkeypatch, tmp_path, Response(b"audio"))

    def full_disk(*a, **k):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr("builtins.open", full_disk)
    with pytest.raises(render_track.TtsError) as exc:
        render_track.tts("voice", "hi", out)
    assert exc.value.kind == "fatal", "a local write failure is not transient"
    assert fake.calls == 1, "the segment must not be purchased again"


def test_a_partial_file_is_removed_after_a_failed_write(
        render_track, monkeypatch, tmp_path):
    """Nothing downstream should mistake a half-written file for a segment."""
    fake, out = drive(render_track, monkeypatch, tmp_path, Response(b"audio"))
    real_open = open

    def fail_midway(path, mode="r", *a, **k):
        if mode == "wb":
            handle = real_open(path, mode, *a, **k)
            handle.write(b"partial")

            def boom(_data):
                raise OSError(28, "No space left on device")
            handle.write = boom
            return handle
        return real_open(path, mode, *a, **k)

    monkeypatch.setattr("builtins.open", fail_midway)
    with pytest.raises(render_track.TtsError):
        render_track.tts("voice", "hi", out)
    assert not os.path.exists(out), "a partial segment file must not survive"


# --------------------------------------------------------------------------
# A dropped mid-response read is transient, not fatal
# --------------------------------------------------------------------------

def test_an_incomplete_read_is_retried(render_track, monkeypatch, tmp_path):
    """IncompleteRead means the connection died part-way through the body, but
    it inherits http.client.HTTPException rather than OSError, so it slips past
    a transient set built only from OSError subclasses."""
    import http.client
    fake, out = drive(render_track, monkeypatch, tmp_path,
                      http.client.IncompleteRead(b"partial"), Response(b"audio"))
    assert render_track.tts("voice", "hi", out) is True
    assert fake.calls == 2


# --------------------------------------------------------------------------
# Retry exhaustion on an HTTP status, not just a network exception
# --------------------------------------------------------------------------

@pytest.mark.parametrize("code", [429, 502, 503, 504])
def test_a_persistent_retryable_status_exhausts_and_raises(
        render_track, monkeypatch, tmp_path, code):
    """The network-exception path already had this; RETRYABLE_STATUSES is where
    the status set actually matters, and it was unpinned."""
    fake, out = drive(render_track, monkeypatch, tmp_path, http_error(code))
    with pytest.raises(render_track.TtsError) as exc:
        render_track.tts("voice", "hi", out)
    assert exc.value.kind == "transient"
    assert fake.calls == tts_policy.MAX_ATTEMPTS, (
        "a retryable status must not also consume the settings fallback")


# --------------------------------------------------------------------------
# A successful call is unchanged
# --------------------------------------------------------------------------

def test_a_successful_segment_is_byte_identical(render_track, monkeypatch, tmp_path):
    """Validation must be read-only — the bytes written are the bytes received."""
    payload = bytes(range(256)) * 8
    fake, out = drive(render_track, monkeypatch, tmp_path, Response(payload))
    assert render_track.tts("voice", "hi", out) is True
    assert open(out, "rb").read() == payload


# --------------------------------------------------------------------------
# The standalone CLI must not grind through 152 segments during an outage
# --------------------------------------------------------------------------

def test_main_stops_after_repeated_network_failures(
        render_track, monkeypatch, tmp_path):
    """Each segment carries its own retry budget, so a sustained outage would
    otherwise spend 152 x (4 attempts x 120 s + 50 s backoff) — most of a day —
    re-establishing that the network is still down.

    render_program does not need this (it raises on the first TtsError); the CLI
    deliberately skips past one-off failures, which is what makes a bound
    necessary here.
    """
    import json as _json
    segments = [{"id": f"S{n:02d}", "text": "x", "pause_after_s": 1.0,
                 "phase": "induction"} for n in range(1, 7)]
    (tmp_path / "demo_tts_segments.json").write_text(
        _json.dumps({"segments": segments}))

    fake = Recorder(urllib.error.URLError("network unreachable"))
    monkeypatch.setattr(render_track.urllib.request, "urlopen", fake)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(render_track.sys, "argv", ["render_track.py", "demo"])

    with pytest.raises(render_track.TtsError) as exc:
        render_track.main()

    assert exc.value.kind == "transient"
    attempted = render_track.MAX_CONSECUTIVE_TRANSIENT * tts_policy.MAX_ATTEMPTS
    assert fake.calls == attempted, (
        f"expected to stop after {render_track.MAX_CONSECUTIVE_TRANSIENT} "
        f"segments ({attempted} calls), not grind through all 6")


def test_main_resets_the_failure_run_after_a_success(
        render_track, monkeypatch, tmp_path):
    """Occasional blips spread across a long run are not an outage.

    The failures here are *interleaved* with successes on purpose. Three
    failures that never occur back to back must not trip the bail — a counter
    that only ever increments would stop the run on the third isolated blip,
    which is the bug this pins.
    """
    import json as _json
    segments = [{"id": f"S{n:02d}", "text": "x", "pause_after_s": 1.0,
                 "phase": "induction"} for n in range(1, 7)]
    (tmp_path / "demo_tts_segments.json").write_text(
        _json.dumps({"segments": segments}))

    monkeypatch.setattr(render_track, "mp3_to_float", lambda p: ([0.0], 44100))
    monkeypatch.setattr(render_track, "treat", lambda y, sr: y)
    written = []
    monkeypatch.setattr(render_track.sf, "write",
                        lambda p, *a, **k: written.append(p))

    # Segments 1, 3 and 5 exhaust their retries; 2, 4 and 6 succeed. That is
    # MAX_CONSECUTIVE_TRANSIENT failures in total, but never in a row.
    burst = [urllib.error.URLError("blip")] * tts_policy.MAX_ATTEMPTS
    sequence = (burst + [Response(b"audio")]) * 3
    fake = Recorder(*sequence)
    monkeypatch.setattr(render_track.urllib.request, "urlopen", fake)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(render_track.sys, "argv", ["render_track.py", "demo"])

    render_track.main()  # must not raise
    assert len(written) == 3, (
        "every segment after a blip should still render; the run of consecutive "
        "failures is what matters, not the total")


# --------------------------------------------------------------------------
# A broken socket must not cost us the HTTP status
# --------------------------------------------------------------------------

def test_a_body_that_cannot_be_read_still_classifies_by_status(
        render_track, monkeypatch, tmp_path):
    """`e.read()` is a stream read inside an exception handler. If it raises,
    the exception escapes uncaught and the status — the thing needed to classify
    — goes with it, turning a clean 'bad key' into an unexplained crash."""
    err = http_error(401)

    def broken_read():
        raise ConnectionResetError("socket already gone")

    err.read = broken_read
    fake, out = drive(render_track, monkeypatch, tmp_path, err)

    with pytest.raises(render_track.TtsError) as exc:
        render_track.tts("voice", "hi", out)
    assert exc.value.kind == "auth", "the 401 must survive an unreadable body"
    assert fake.calls == 1
