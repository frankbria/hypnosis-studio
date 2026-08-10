"""Track-agnostic segment renderer (same pipeline as render_segments.py).

TRACK selects the segments JSON and output dirs. Reused segments (e.g. the
disclaimer S01) can be pre-copied into the output dir; they are skipped.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

import numpy as np
import soundfile as sf
import av
from scipy.signal import lfilter, fftconvolve

import tts_policy

KEY = None

BRIAN = "nPczCjzI2devNBz1zQrb"
FRANK = "RsoSo7Gg7GyAtGoPBiqb"

# How many segments may fail back to back before the standalone CLI stops.
#
# The kind of failure does not matter, only that it keeps happening. A sustained
# network outage spends 152 x (4 attempts x 120 s + 50 s of backoff) proving the
# network is still down; a full disk is quieter but worse — every segment is
# fetched successfully, billed, and then thrown away because it cannot be
# written. Both are "the next 150 will fail the same way".
#
# render_program does not need this: it raises on the first TtsError.
MAX_CONSECUTIVE_FAILURES = 3


def load_key() -> str:
    """Resolve the ElevenLabs key: env var first, else .env.local in cwd."""
    global KEY
    if KEY:
        return KEY
    env_key = os.environ.get("ELEVENLABS_API_KEY")
    if env_key:
        KEY = env_key
        return KEY
    for line in open(".env.local"):
        if line.startswith("ELEVENLABS_API_KEY="):
            KEY = line.strip().split("=", 1)[1].strip().strip('"').strip("'")
    assert KEY, "ELEVENLABS_API_KEY not set and no .env.local entry found"
    return KEY


def register_for(seg: dict):
    if seg.get("phase") == "suggestion":
        return FRANK, "[whispering] "
    return BRIAN, "[soft] "


class TtsError(RuntimeError):
    """A TTS call that will not succeed by being repeated.

    `kind` is a tts_policy classification — auth, quota, transient (retries
    exhausted) or fatal — so the caller can put a cause in status.json instead of
    the bare "TTS failed for segment S01" that a dead key and a dropped
    connection used to share.
    """

    def __init__(self, kind: str, detail: str):
        super().__init__(detail)
        self.kind = kind
        self.detail = detail


def _error_body(err) -> bytes:
    """An HTTPError's body, or empty if the socket is already gone.

    `e.read()` is a stream read inside an exception handler; if it raises, the
    exception escapes uncaught and the HTTP status — the thing we actually
    needed in order to classify — is lost with it.
    """
    try:
        return err.read()
    except Exception:  # noqa: BLE001 — the status matters more than the body
        return b""


def _write_segment(out_path: str, payload: bytes) -> None:
    """Save a segment that has already been rendered and paid for.

    Raises TtsError("fatal") rather than letting the OSError reach the retry
    classifier: retrying would re-buy identical audio and fail to write it
    again. A partial file is removed so nothing downstream mistakes it for a
    finished segment.
    """
    try:
        with open(out_path, "wb") as f:
            f.write(payload)
    except OSError as e:
        try:
            os.remove(out_path)
        except OSError:
            pass
        raise TtsError(
            "fatal",
            f"the segment was rendered and paid for but could not be written to "
            f"{out_path}: {e}") from e


def tts(voice_id: str, text: str, out_path: str) -> bool:
    """Render one segment to `out_path`. Raises TtsError when it cannot.

    Two things the previous version got wrong, both from one control flow:
    network errors are not HTTPError, so they hit a bare `except Exception` and
    were never retried — across 152 sequential requests that is the *likeliest*
    failure. And the inner `break` exited only the retry loop, so every
    permanent error, a dead API key included, fell through to a second complete
    attempt with the fallback settings.
    """
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128"
    settings_full = {"stability": 0.5, "similarity_boost": 0.75, "speed": 0.85}
    settings_nospeed = {"stability": 0.5, "similarity_boost": 0.75}

    for settings in (settings_full, settings_nospeed):
        body = {"text": text, "model_id": "eleven_v3", "voice_settings": settings}
        for attempt in range(tts_policy.MAX_ATTEMPTS):
            try:
                req = urllib.request.Request(
                    url, data=json.dumps(body).encode(),
                    headers={"xi-api-key": KEY, "Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=120) as r:
                    payload = r.read()
            except urllib.error.HTTPError as e:
                outcome = tts_policy.classify(status=e.code, body=_error_body(e))
            except Exception as e:  # noqa: BLE001 — classified below, not swallowed
                outcome = tts_policy.classify(exception=e)
            else:
                # Only the network call is classified. The write is deliberately
                # outside that try: a disk-full OSError is an OSError like any
                # other, so leaving it in would classify a local failure as
                # transient and buy this segment from ElevenLabs again — up to
                # four times — to fail writing it again each time.
                _write_segment(out_path, payload)
                return True

            if outcome.kind in ("auth", "quota"):
                # Straight out, with no second settings pass: neither a rejected
                # key nor an empty account is fixed by a different request body,
                # and every extra attempt is another billable call.
                raise TtsError(outcome.kind, outcome.detail)

            if outcome.kind == "unsupported_settings":
                print(f"  {outcome.detail}", flush=True)
                break  # the one case the settings fallback exists for

            if outcome.retryable and attempt < tts_policy.MAX_ATTEMPTS - 1:
                wait = tts_policy.backoff_seconds(attempt)
                print(f"  {outcome.detail} — retrying in {wait}s "
                      f"(attempt {attempt + 2}/{tts_policy.MAX_ATTEMPTS})", flush=True)
                time.sleep(wait)
                continue

            if outcome.retryable:
                raise TtsError("transient",
                               f"{outcome.detail} — gave up after "
                               f"{tts_policy.MAX_ATTEMPTS} attempts")
            raise TtsError(outcome.kind, outcome.detail)

    # Both settings passes were rejected as unsupported.
    return False


def mp3_to_float(src: str):
    inp = av.open(src)
    stream = inp.streams.audio[0]
    resampler = av.AudioResampler(format="flt", layout="mono", rate=44100)
    chunks = []
    for frame in inp.decode(stream):
        for r in resampler.resample(frame):
            chunks.append(r.to_ndarray().astype(np.float64))
    return np.concatenate(chunks, axis=1).reshape(-1), 44100


def treat(y: np.ndarray, sr: int) -> np.ndarray:
    alpha = np.exp(-2 * np.pi * 6500 / sr)
    softened = lfilter([1 - alpha], [1.0, -alpha], y)
    y2 = 0.6 * y + 0.4 * softened
    ir_len = int(1.3 * sr)
    rng = np.random.default_rng(7)
    t_ir = np.arange(ir_len) / (0.35 * sr)
    ir = rng.standard_normal(ir_len) * np.exp(-t_ir)
    ir[: int(0.025 * sr)] = 0.0
    ir /= np.abs(ir).sum()
    wet = fftconvolve(y2, ir)[: len(y2)]
    out = 0.84 * y2 + 0.16 * wet
    peak = np.abs(out).max()
    if peak > 1e-9:
        out *= 0.97 / peak
    return out


def main():
    track = sys.argv[1] if len(sys.argv) > 1 else "golden_thread"
    load_key()

    raw = f"{track}_segments_raw"
    out = f"{track}_segments"
    os.makedirs(raw, exist_ok=True)
    os.makedirs(out, exist_ok=True)

    segs = json.load(open(f"{track}_tts_segments.json"))["segments"]

    total_chars = 0
    consecutive_failures = 0
    for i, seg in enumerate(segs):
        vid, tag = register_for(seg)
        text = tag + seg["text"]
        total_chars += len(text)
        raw_path = f"{raw}/{seg['id']}.mp3"
        out_path = f"{out}/{seg['id']}.wav"
        if os.path.exists(out_path):
            print(f"skip {seg['id']} (exists)")
            continue
        try:
            ok = tts(vid, text, raw_path)
        except TtsError as e:
            # A dead key or an empty account fails every remaining segment
            # identically, so stop immediately.
            print(f"FAIL {seg['id']}: {e.detail}")
            if e.kind in ("auth", "quota"):
                raise
            # Anything else is skippable *once* — one odd segment should not end
            # a run — but a streak means the next 150 will fail the same way.
            # Counting every kind matters: a full disk raises "fatal", and each
            # of those segments has already been fetched and billed before the
            # write failed, so skipping past them is the most expensive
            # possible response.
            consecutive_failures += 1
            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                raise TtsError(
                    e.kind,
                    f"{consecutive_failures} segments in a row failed "
                    f"({e.kind}); giving up rather than attempting the "
                    f"remaining {len(segs) - i - 1}") from e
            continue
        consecutive_failures = 0
        if not ok:
            print(f"FAIL {seg['id']}: both voice-setting variants were rejected")
            continue
        y, sr = mp3_to_float(raw_path)
        sf.write(out_path, treat(y, sr), sr, subtype="PCM_16")
        print(f"OK   {seg['id']}  ({'whisper' if vid == FRANK else 'soft'}, {len(y)/sr:.1f}s)")
        time.sleep(0.5)
    print(f"\ntotal chars sent (approx): {total_chars}")


if __name__ == "__main__":
    main()
