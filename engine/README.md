# Render engine

Two-stage pipeline that turns a hypnosis script (segment JSON) into a finished, mono-friendly mastered track.

## Voices

- Frame / induction / deepening / resurface: ElevenLabs **Brian** (`nPczCjzI2devNBz1zQrb`), `[soft]` tag
- Suggestion phase: whisper voice (`RsoSo7Gg7GyAtGoPBiqb`), `[whispering]` tag
- Model: `eleven_v3`, stability 0.5, similarity_boost 0.75, speed 0.85

## Stage 1 — `render_track.py <track>`

Reads `<track>_tts_segments.json`, calls ElevenLabs per segment, de-harshes (6.5 kHz one-pole blend) and adds a light algorithmic reverb, writes `<track>_segments/<id>.wav`. Existing segments are skipped (idempotent reruns).

Requires `.env.local` in the working directory:

```
ELEVENLABS_API_KEY=sk_...
```

## Stage 2 — `assemble_track.py <track> "<Title>" <pad.wav> <kw1,kw2> [total_s]`

- Flattens pad energy (per-second RMS correction, clamped ±8 dB)
- Voice submix on a **smooth dB curve**: 0 → +3 → +6 → sink to −14 across deepening, hold through suggestion, +6 return on resurface
- 2 s register-change overlaps so narrator ↔ whisper crossfades
- Carrier auto-scan (300–400 Hz quietest slot) + ±10 Hz notch, then an isochronic bed on a theta→alpha arc at pad_rms −29 dB
- 30 s fade-out, master to −20 dB RMS, soft clip; writes WAV + MP3
- QA: per-minute RMS profile, bed-pulse check, faster-whisper transcript of the sunken suggestion layer with keyword hit count

## Pads

Pad WAVs are large binary assets and are intentionally not committed (kept in Dropbox / local working dirs). Place the pad in the working directory and pass it as `<pad.wav>`.
