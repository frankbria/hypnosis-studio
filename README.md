# Hypnosis Studio

Personalized self-hypnosis program generator: the user picks a goal and a voice, and we script, voice, and master a multi-track audio program with entrainment beds — delivered as a simple download.

## Status

Infrastructure is live on prod-linode; the web app is currently a placeholder. See [DEPLOYMENT.md](DEPLOYMENT.md) for the full ops picture.

## Layout

- `server.js`, `package.json` — placeholder web app (Node 24, systemd `hypnosis-studio`, 127.0.0.1:4100 behind nginx)
- `test/` — `npm test` (`node --test`, no dependencies). Spawns a real server and asserts it survives hostile requests.
- `engine/` — audio render pipeline (ElevenLabs TTS + NumPy/SciPy mastering)
- `.github/workflows/deploy.yml` — push-to-main deploy over SSH

## Pipeline overview (engine/)

1. Script → `<track>_tts_segments.json` with phases: frame / induction / deepening / suggestion / resurface
2. `render_track.py <track>` — ElevenLabs TTS per segment (soft narrator for frame/induction, whisper voice for the suggestion layer), de-harsh + light reverb
3. `assemble_track.py <track> "<Title>" <pad.wav> <kw1,kw2> [total_s]` — smooth gain envelope, register crossfades, carrier notch + isochronic bed, master to −20 dB RMS, QA (RMS profile, bed pulse, whisper transcript)
