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

KEY = None

BRIAN = "nPczCjzI2devNBz1zQrb"
FRANK = "RsoSo7Gg7GyAtGoPBiqb"


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


def tts(voice_id: str, text: str, out_path: str) -> bool:
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128"
    settings_full = {"stability": 0.5, "similarity_boost": 0.75, "speed": 0.85}
    settings_nospeed = {"stability": 0.5, "similarity_boost": 0.75}
    for settings in (settings_full, settings_nospeed):
        body = {"text": text, "model_id": "eleven_v3", "voice_settings": settings}
        req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                     headers={"xi-api-key": KEY, "Content-Type": "application/json"})
        for retry in range(3):
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    open(out_path, "wb").write(r.read())
                return True
            except urllib.error.HTTPError as e:
                msg = e.read().decode()[:200]
                if e.code in (429, 500, 502, 503) and retry < 2:
                    print(f"  HTTP {e.code}, retrying in 5s...")
                    time.sleep(5)
                    continue
                print(f"  HTTP {e.code}: {msg}")
                break
            except Exception as e:
                print(f"  error: {e}")
                break
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
    for seg in segs:
        vid, tag = register_for(seg)
        text = tag + seg["text"]
        total_chars += len(text)
        raw_path = f"{raw}/{seg['id']}.mp3"
        out_path = f"{out}/{seg['id']}.wav"
        if os.path.exists(out_path):
            print(f"skip {seg['id']} (exists)")
            continue
        ok = tts(vid, text, raw_path)
        if not ok:
            print(f"FAIL {seg['id']}")
            continue
        y, sr = mp3_to_float(raw_path)
        sf.write(out_path, treat(y, sr), sr, subtype="PCM_16")
        print(f"OK   {seg['id']}  ({'whisper' if vid == FRANK else 'soft'}, {len(y)/sr:.1f}s)")
        time.sleep(0.5)
    print(f"\ntotal chars sent (approx): {total_chars}")


if __name__ == "__main__":
    main()
