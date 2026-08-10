"""Track-agnostic assembler v2 — smooth gain envelope + register overlaps.

Usage: python assemble_track.py <track> "<Title>" <pad.wav> <kw1,kw2,...> [total_s]

v2 changes (user feedback):
- Voice level follows a continuous dB curve (np.interp over phase breakpoints)
  instead of per-segment steps: soft open (0 dB) -> +3 -> +6 induction ->
  gradual sink across deepening to -14 -> hold through suggestion ->
  gradual +6 over the first resurface segments.
- First suggestion & first resurface segments start 2 s early, overlapping
  the previous segment's tail, so the Brian<->whisper timbre change crossfades.
- Longer format supported via total_s (track 3 = 900 s).

v3 (prod memory safety, sonically equivalent):
- Pad energy flattening smooths the 1-Hz correction series with the 5 s kernel
  and applies it chunked (was: fftconvolve on the full-rate curve -> multi-GB
  complex128 FFT; OOM-killed on the 4 GB prod box).
- Voice gain curve applied in 60 s chunks; big buffers freed as soon as done.
- Isochronic bed synthesized in 60 s chunks (two-pass: exact global RMS
  normalization preserved) instead of six full-length temporaries.

Pipeline: flatten pad -> voice submix on smooth envelope -> carrier notch ->
isochronic bed (theta-alpha arc) -> fade -> -20 dB RMS -> soft clip -> QA.
"""
import json
import os
import sys
import numpy as np
import soundfile as sf
from scipy.signal import butter, hilbert, sosfiltfilt, welch

import timeline

TRACK = sys.argv[1] if len(sys.argv) > 1 else "golden_thread"
TITLE = sys.argv[2] if len(sys.argv) > 2 else "The Golden Thread - Self Hypnosis (MONO one-ear)"
PAD_FILE = sys.argv[3] if len(sys.argv) > 3 else "pad_golden.wav"
KEYWORDS = (sys.argv[4].split(",") if len(sys.argv) > 4
            else ["golden", "thread", "labyrinth", "door", "notice"])
TOTAL_S = int(sys.argv[5]) if len(sys.argv) > 5 else 780

# env flags (defaults preserve original behavior)
DTYPE = np.float32 if os.environ.get("HYPNO_DTYPE") == "float32" else np.float64
SKIP_QA = os.environ.get("HYPNO_SKIP_QA") == "1"

SR = timeline.SR
CH = 60 * SR  # chunk size for full-rate curve operations

# ---------- load segments & build voice timeline ----------
segs = json.load(open(f"{TRACK}_tts_segments.json"))["segments"]

waves = {}
for seg in segs:
    y, sr = sf.read(f"{TRACK}_segments/{seg['id']}.wav", dtype=DTYPE)
    if sr != SR:
        # Was a bare assert, which python -O strips. A segment at the wrong rate
        # would then be placed on the timeline at the wrong length and mixed at
        # the wrong pitch — shipped to the customer rather than caught.
        raise ValueError(f"segment {seg['id']} sample rate is {sr}, expected {SR}")
    waves[seg["id"]] = y

positions = []  # (id, start, end, phase)
t = 1.5
for seg in segs:
    dur = len(waves[seg["id"]]) / SR
    positions.append([seg["id"], t, t + dur, seg["phase"]])
    pause = seg["pause_after_s"] * (2 if seg["phase"] == "suggestion" else 1)
    t += dur + pause

# phase boundaries
def bounds(phase):
    rows = [p for p in positions if p[3] == phase]
    return rows[0][1], rows[-1][2]

IND_START, IND_END = bounds("induction")
DEEP_START, DEEP_END = bounds("deepening")
SUG_START, SUG_END = bounds("suggestion")
RES_START, RES_END = bounds("resurface")

# register-change overlaps: pull first suggestion & first resurface segment 2 s early
for i, p in enumerate(positions):
    if i == 0:
        continue
    prev = positions[i - 1]
    if (p[3] == "suggestion" and prev[3] != "suggestion") or \
       (p[3] == "resurface" and prev[3] == "suggestion"):
        new_start = max(prev[1], p[1] - 2.0)
        shift = p[1] - new_start
        p[1] -= shift
        p[2] -= shift
SUG_START = [p for p in positions if p[3] == "suggestion"][0][1]
RES_START = [p for p in positions if p[3] == "resurface"][0][1]

voice_end = positions[-1][2]

# ---------- load pad, bound the program by it ----------
# TOTAL_S is a minimum and the pad is the ceiling. voice_end is the sum of real
# TTS durations, so it is only knowable here — after the whole track has been
# paid for. A long program therefore gives up music outro rather than dying at
# this point with the spend already gone (issue #5).
pad, sr = sf.read(PAD_FILE, dtype=DTYPE)
if sr != SR:
    # Every offset in this file is computed at SR, and the bound below now reads
    # the pad's length the same way — a pad at another rate would silently
    # mis-measure it. Segments are checked the same way above.
    raise ValueError(f"pad sample rate is {sr}, expected {SR}: {PAD_FILE}")
pad_s = len(pad) / SR
ACTUAL_S = timeline.resolve_actual_s(TOTAL_S, voice_end, pad_s)
print(f"voice program: {voice_end/60:.2f} min; outro {(ACTUAL_S-voice_end)/60:.2f} min "
      f"(target {TOTAL_S}s, actual {ACTUAL_S:.0f}s, pad {pad_s:.0f}s)")
if ACTUAL_S - voice_end < timeline.MIN_OUTRO_S:
    print(f"  note: outro shortened to {ACTUAL_S - voice_end:.0f}s "
          f"(prefers {timeline.MIN_OUTRO_S:.0f}s) — bounded by the pad")

pad = pad[: int(ACTUAL_S * SR)]

# ---------- flatten pad energy ----------
w = 1 * SR
nwin = len(pad) // w
win_rms = np.array([np.sqrt(np.mean(pad[i * w:(i + 1) * w] ** 2)) for i in range(nwin)])
win_rms = np.maximum(win_rms, 1e-9)
corr = np.clip(10 ** (-23 / 20) / win_rms, 10 ** (-8 / 20), 10 ** (8 / 20))
# smooth at 1 Hz with the same 5 s window, then apply chunked via interpolation
k = np.hanning(5); k /= k.sum()
corr = np.convolve(corr, k, mode="same")
for c0 in range(0, len(pad), CH):
    c1 = min(c0 + CH, len(pad))
    ct = np.interp(np.arange(c0, c1) / SR, np.arange(len(corr)) + 0.5, corr)
    pad[c0:c1] *= ct.astype(DTYPE, copy=False)
pad_rms = np.sqrt(np.mean(pad ** 2))
print(f"pad flattened: {len(pad)/SR/60:.2f} min, RMS {20*np.log10(pad_rms):.1f} dB")

# ---------- voice submix: normalized segments on a smooth dB curve ----------
voice = np.zeros_like(pad)
for sid, t0, t1, _ in positions:
    y = waves[sid].copy()
    rms = np.sqrt(np.mean(y ** 2)) + 1e-12
    y *= pad_rms / rms  # unity: at 0 dB relative to pad
    i0 = int(t0 * SR)
    voice[i0: i0 + len(y)] += y
del waves

GAIN_BP = [
    (0.0, 0.0),                 # soft open (user feedback: start softer)
    (IND_START, 3.0),
    (IND_START + 12.0, 6.0),    # full presence by mid-induction
    (DEEP_START + 8.0, 6.0),
    (DEEP_END, -14.0),          # gradual sink across deepening
    (SUG_END, -14.0),           # hold through suggestion
    (RES_START + 25.0, 6.0),    # gradual return over first resurface segments
    (voice_end, 6.0),
]
# np.interp does not validate that breakpoint times increase — handed a series
# that steps backwards it silently returns a garbage envelope. RES_START + 25 can
# overshoot voice_end on a short resurface phase, so pin the order.
bp_t = np.array(timeline.monotonic([p[0] for p in GAIN_BP])); bp_g = np.array([p[1] for p in GAIN_BP])
for c0 in range(0, len(voice), CH):
    c1 = min(c0 + CH, len(voice))
    g = 10 ** (np.interp(np.arange(c0, c1) / SR, bp_t, bp_g) / 20)
    voice[c0:c1] *= g.astype(DTYPE, copy=False)
mix = pad + voice
del voice
print("voice placed on smooth envelope: 0 -> +3 -> +6 -> sink -14 -> +6 dB")

# ---------- isochronic bed ----------
f, P = welch(pad[: 300 * SR], SR, nperseg=SR * 4)
slot_best, slot_f = None, None
for lo in range(300, 401, 10):
    mask = (f >= lo) & (f < lo + 20)
    e = P[mask].sum()
    if slot_best is None or e < slot_best:
        slot_best, slot_f = e, lo + 10.0
CARRIER = slot_f
BAND = (CARRIER - 10, CARRIER + 10)
print(f"carrier auto-scan: {CARRIER:.0f} Hz (band {BAND[0]:.0f}-{BAND[1]:.0f})")

sos_notch = butter(2, [(CARRIER - 10) / (SR / 2), (CARRIER + 10) / (SR / 2)],
                   btype="bandstop", output="sos")
pad = sosfiltfilt(sos_notch, pad)
mix = sosfiltfilt(sos_notch, mix)
del pad

n = len(mix)
wander_mid = SUG_START + (SUG_END - SUG_START) * 0.6
TRAJ = [
    (0, 0.0), (30, 5.0),
    (IND_END, 7.0),
    (DEEP_END, 6.5),
    (wander_mid, 9.0),
    (SUG_END, 7.0),
    (RES_START + 10, 10.0),
    (ACTUAL_S - 60, 10.0),
    (ACTUAL_S - 5, 0.0),
]
# Same guard as GAIN_BP, and load-bearing here: once ACTUAL_S is clamped against
# the pad, the ACTUAL_S-relative tail breakpoints fall behind RES_START + 10.
bp_t = np.array(timeline.monotonic([p[0] for p in TRAJ])); bp_r = np.array([p[1] for p in TRAJ])


def bed_chunks():
    """Yield (c0, c1, bed_chunk) with the phase accumulator carried across chunks."""
    ph = 0.0
    for c0 in range(0, n, CH):
        c1 = min(c0 + CH, n)
        t = np.arange(c0, c1) / SR
        rate = np.interp(t, bp_t, bp_r)
        phseg = ph + np.concatenate(([0.0], np.cumsum(rate)[:-1] / SR))
        gate = 0.5 * (1 - np.cos(2 * np.pi * phseg)) ** 1.5
        gate[rate <= 0.01] = 0.0
        yield c0, c1, (np.sin(2 * np.pi * CARRIER * t) * gate).astype(DTYPE, copy=False)
        ph = phseg[-1] + rate[-1] / SR


# pass 1: exact global bed power for the normalization constant
ss = 0.0
for _, _, bc in bed_chunks():
    ss += float(np.sum(bc * bc))
bed_scale = pad_rms * 10 ** (-29 / 20) / (np.sqrt(ss / n) + 1e-12)
# pass 2: add the scaled bed into the mix
for c0, c1, bc in bed_chunks():
    mix[c0:c1] += (bed_scale * bc).astype(DTYPE, copy=False)

# ---------- master ----------
fade_n = 30 * SR
mix[-fade_n:] *= (np.cos(np.linspace(0, np.pi / 2, fade_n)) ** 2).astype(DTYPE, copy=False)
mix *= (10 ** (-20 / 20)) / (np.sqrt(np.mean(mix ** 2)) + 1e-12)
over = np.abs(mix) > 0.9
if over.any():
    mix[over] = np.sign(mix[over]) * (0.9 + 0.09 * np.tanh((np.abs(mix[over]) - 0.9) / 0.09))

sf.write(f"{TITLE}.wav", mix, SR, subtype="PCM_16")
sf.write(f"{TITLE}.mp3", mix, SR, format="MP3")
rms_all = 20 * np.log10(np.sqrt(np.mean(mix ** 2)))
print(f"written: {TITLE}.wav/.mp3  overall RMS {rms_all:.1f} dB (catalog ref ~-20)")

# ---------- QA ----------
if not SKIP_QA:
    print("\n-- QA: per-minute RMS profile (smooth ramp expected 0:00-3:00) --")
    for t0 in range(0, int(ACTUAL_S), 60):
        seg = mix[t0 * SR:(t0 + 60) * SR]
        r = 20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-12)
        print(f"  {t0//60:>2d}:00-{t0//60+1:>2d}:00  {r:6.1f} dB")

    def env_check(lo, hi, t0, t1, label):
        seg = mix[int(t0 * SR):int(t1 * SR)]
        s = butter(4, [lo / (SR / 2), hi / (SR / 2)], btype="band", output="sos")
        env = np.abs(hilbert(sosfiltfilt(s, seg)))[::441]
        env -= env.mean()
        spec = np.abs(np.fft.rfft(env * np.hanning(len(env))))
        fr = np.fft.rfftfreq(len(env), 1 / (SR / 441))
        m = (fr >= 0.5) & (fr <= 15)
        i = np.argmax(spec[m])
        print(f"  {label}: dominant pulse {fr[m][i]:.2f} Hz")

    print("-- QA: bed pulse (tight +/-4 Hz window around carrier) --")
    env_check(CARRIER - 4, CARRIER + 4, SUG_START + 5, min(SUG_END, SUG_START + 240), "suggestion (expect 6.5-9 Hz)")
    # The music tail is no longer guaranteed to be ~2 min: a program clamped
    # against the pad can leave as little as the 30 s fade. Keep this window
    # inside the actual tail so it never reports voiced audio as "no voice".
    outro_lo = max(voice_end, ACTUAL_S - 240)
    outro_hi = ACTUAL_S - 60
    if outro_hi - outro_lo >= 5:
        env_check(CARRIER - 4, CARRIER + 4, outro_lo, outro_hi, "outro, no voice (expect clean 10 Hz)")
    else:
        print(f"  outro window too short to measure ({max(ACTUAL_S - voice_end, 0):.0f}s tail)")

    print("-- QA: boosted whisper transcript (sunken middle +14 dB) --")
    boost = mix[int(SUG_START * SR): int(SUG_END * SR)] * 10 ** (14 / 20)
    boost = np.clip(boost, -1, 1)
    sf.write(f"qa_whisper_boost_{TRACK}.wav", boost, SR, subtype="PCM_16")
    from faster_whisper import WhisperModel
    model = WhisperModel("base", device="cpu", compute_type="int8")
    segs_t, _ = model.transcribe(f"qa_whisper_boost_{TRACK}.wav", language="en")
    text = " ".join(s.text for s in segs_t)
    print("  transcript:", text[:600])
    hits = sum(1 for w in KEYWORDS if w in text.lower())
    print(f"  keyword hits: {hits}/{len(KEYWORDS)}")
else:
    print("\n-- QA skipped (HYPNO_SKIP_QA=1) --")
