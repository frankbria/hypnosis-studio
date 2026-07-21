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

Pipeline: flatten pad -> voice submix on smooth envelope -> carrier notch ->
isochronic bed (theta-alpha arc) -> fade -> -20 dB RMS -> soft clip -> QA.
"""
import json
import sys
import numpy as np
import soundfile as sf
from scipy.signal import butter, hilbert, sosfiltfilt, welch, fftconvolve

TRACK = sys.argv[1] if len(sys.argv) > 1 else "golden_thread"
TITLE = sys.argv[2] if len(sys.argv) > 2 else "The Golden Thread - Self Hypnosis (MONO one-ear)"
PAD_FILE = sys.argv[3] if len(sys.argv) > 3 else "pad_golden.wav"
KEYWORDS = (sys.argv[4].split(",") if len(sys.argv) > 4
            else ["golden", "thread", "labyrinth", "door", "notice"])
TOTAL_S = int(sys.argv[5]) if len(sys.argv) > 5 else 780

SR = 44100

# ---------- load segments & build voice timeline ----------
segs = json.load(open(f"{TRACK}_tts_segments.json"))["segments"]

waves = {}
for seg in segs:
    y, sr = sf.read(f"{TRACK}_segments/{seg['id']}.wav", dtype="float64")
    assert sr == SR
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
print(f"voice program: {voice_end/60:.2f} min; outro {(TOTAL_S-voice_end)/60:.2f} min")

# ---------- load pad, flatten energy ----------
pad, sr = sf.read(PAD_FILE, dtype="float64")
assert len(pad) >= TOTAL_S * SR, f"pad too short: {len(pad)/SR:.0f}s"
pad = pad[: TOTAL_S * SR]
w = 1 * SR
nwin = len(pad) // w
win_rms = np.array([np.sqrt(np.mean(pad[i * w:(i + 1) * w] ** 2)) for i in range(nwin)])
win_rms = np.maximum(win_rms, 1e-9)
corr = np.clip(10 ** (-23 / 20) / win_rms, 10 ** (-8 / 20), 10 ** (8 / 20))
corr_t = np.repeat(corr, w)[: len(pad)]
k = np.hanning(5 * SR); k /= k.sum()
corr_t = fftconvolve(corr_t, k, mode="same")
pad *= corr_t
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
bp_t = np.array([p[0] for p in GAIN_BP]); bp_g = np.array([p[1] for p in GAIN_BP])
t_all = np.arange(len(voice)) / SR
gain_curve = 10 ** (np.interp(t_all, bp_t, bp_g) / 20)
voice *= gain_curve
mix = pad + voice
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

n = len(mix)
tt = np.arange(n) / SR
wander_mid = SUG_START + (SUG_END - SUG_START) * 0.6
TRAJ = [
    (0, 0.0), (30, 5.0),
    (IND_END, 7.0),
    (DEEP_END, 6.5),
    (wander_mid, 9.0),
    (SUG_END, 7.0),
    (RES_START + 10, 10.0),
    (TOTAL_S - 60, 10.0),
    (TOTAL_S - 5, 0.0),
]
bp_t = np.array([p[0] for p in TRAJ]); bp_r = np.array([p[1] for p in TRAJ])
rate = np.interp(tt, bp_t, bp_r)
phase_acc = np.cumsum(rate) / SR
gate = 0.5 * (1 - np.cos(2 * np.pi * phase_acc)) ** 1.5
gate[rate <= 0.01] = 0.0
bed = np.sin(2 * np.pi * CARRIER * tt) * gate
bed *= pad_rms * 10 ** (-29 / 20) / (np.sqrt(np.mean(bed ** 2)) + 1e-12)
mix += bed

# ---------- master ----------
fade_n = 30 * SR
mix[-fade_n:] *= np.cos(np.linspace(0, np.pi / 2, fade_n)) ** 2
mix *= (10 ** (-20 / 20)) / (np.sqrt(np.mean(mix ** 2)) + 1e-12)
over = np.abs(mix) > 0.9
if over.any():
    mix[over] = np.sign(mix[over]) * (0.9 + 0.09 * np.tanh((np.abs(mix[over]) - 0.9) / 0.09))

sf.write(f"{TITLE}.wav", mix, SR, subtype="PCM_16")
sf.write(f"{TITLE}.mp3", mix, SR, format="MP3")
rms_all = 20 * np.log10(np.sqrt(np.mean(mix ** 2)))
print(f"written: {TITLE}.wav/.mp3  overall RMS {rms_all:.1f} dB (catalog ref ~-20)")

# ---------- QA ----------
print("\n-- QA: per-minute RMS profile (smooth ramp expected 0:00-3:00) --")
for t0 in range(0, TOTAL_S, 60):
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
env_check(CARRIER - 4, CARRIER + 4, TOTAL_S - 240, TOTAL_S - 60, "outro, no voice (expect clean 10 Hz)")

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
