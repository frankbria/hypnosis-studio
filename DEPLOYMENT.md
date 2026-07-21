# Deployment — prod-linode (45.33.41.124)

## Architecture

Push to `main` → GitHub Actions (environment `production`) → SSH (user `deploy`) → `/srv/hypnosis-studio` → `sudo systemctl restart hypnosis-studio` → smoke test on 127.0.0.1:4100.

- **App:** Node 24 (`/usr/local/bin/node` → `/opt/node-v24.11.1`), systemd unit `hypnosis-studio.service`, env `PORT=4100`, binds loopback only
- **Edge:** nginx vhost `/etc/nginx/sites-available/hypnosis-studio` → `proxy_pass http://127.0.0.1:4100`
- **Firewall (UFW):** only 22/80/443 public; the app port stays loopback-only. Shared server — do not touch other vhosts/services.

## Server changes made (2026-07-21, all additive)

- User `deploy` (key-only login), `github_actions_prod.pub` in `~deploy/.ssh/authorized_keys`
- `/srv/hypnosis-studio` owned by `deploy`
- `/etc/sudoers.d/deploy-hypnosis`: NOPASSWD limited to `/bin/systemctl restart|status|is-active hypnosis-studio`
- Node v24.11.1 copied from root's nvm to `/opt/node-v24.11.1`, symlinked into `/usr/local/bin`
- `/etc/systemd/system/hypnosis-studio.service` (enabled)
- nginx site `hypnosis-studio` enabled; `server_name hypnosis.frankbria.net`
- TLS via `certbot --nginx -d hypnosis.frankbria.net` (HTTP→HTTPS redirect)

## GitHub environments

Environment **`production`** holds the deploy secrets (a `staging` environment also exists — unused for now):

| Secret | Value |
|---|---|
| `host` | `45.33.41.124` |
| `user` | `deploy` |
| `ssh_key` | private key from `C:\Users\frank\.ssh\github_actions_prod` |

The deploy job declares `environment: production` to pick these up; every push to `main` deploys.

## Domain

Live domain: **hypnosis.frankbria.net** — A record → 45.33.41.124, TLS issued by certbot (nginx plugin).

## Ops cheat sheet

- Logs: `ssh prod 'journalctl -u hypnosis-studio -f'`
- Restart: `ssh prod 'systemctl restart hypnosis-studio'`
- Always `nginx -t` before `systemctl reload nginx`

## Render pipeline

`POST /api/programs` spawns one worker per job and tracks it on disk; no queue daemon.

- **Worker flow** (`engine/render_program.py`, per job): renders the full **4-track program** (I Foundation, II Deepening, III Mastery, IV Integration — tracks 1–3 run 900 s, track 4 runs 420 s; all pads are 960 s so one pad serves every track). Stages: `scripting` (copy `engine/scripts/<goal>[_trackN]_tts_segments.json` ×4 into the job dir, verify pad) → `voicing` / `whisper-layer` (ElevenLabs TTS per segment across all 4 tracks — narrator voice `[soft]` for non-suggestion phases, whisper voice `[whispering]` for suggestion; idempotent, existing segment WAVs are skipped; status detail reads `track N/4 · segment Sxx`) → `entrainment-bed` (`assemble_track.py` as a subprocess per track with `cwd` = job dir, TOTAL_S 900/900/900/420) → `mastering-qa` (write `manifest.json`). Progress lives in `renders/<jobId>/status.json`, written atomically at every transition; worker stdout/stderr goes to `renders/<jobId>/worker.log`.
- **Manifest:** `manifest.json` now lists all four masters — `{"tracks": [{"n", "id", "title", "phase", "durationSec", "mp3", "wav"}, ...]}` with files `<goal>_track1.mp3/.wav` … `<goal>_track4.mp3/.wav`. The manifest is written only after all 4 tracks master successfully, so partial renders are never listed. The server tolerates legacy single-track manifests when serving files.
- **ElevenLabs credits:** a full program is ≈16k characters of TTS (≈131 segments across 4 tracks) — roughly **4× the credits of the old single-track render** per job. `MAX_JOBS_PER_DAY` (default **6**, in `engine/api.env`) is the lever that governs daily credit burn; lower it if credit usage outpaces the plan.
- **Paths:** venv `/srv/hypnosis-studio/engine/venv` (worker runs as `<venv>/bin/python`), pads `/srv/hypnosis-studio/engine/pads/*.wav` (960 s mono 44.1 kHz — **server-only, not in git**), renders `/srv/hypnosis-studio/renders/<jobId>/`, env `/srv/hypnosis-studio/engine/api.env` (loaded by the systemd unit; provides `ELEVENLABS_API_KEY`, `ACCESS_CODE`, `HYPNO_DTYPE`, `HYPNO_SKIP_QA` to Node and its children).
- **Early access:** the render endpoint requires `accessCode` = `ACCESS_CODE` from `api.env` (currently **`polymath-2026`**). If `ACCESS_CODE` is unset, the endpoint answers 503 `rendering_disabled`.
- **Concurrency & quota:** one render at a time (409 `busy` while any job is `rendering`); daily cap `MAX_JOBS_PER_DAY` (default **6**, persisted in `renders/.quota.json`, 429 `daily_cap` when reached).
- **Env flags on the assembler:** `HYPNO_DTYPE=float32` halves mixer RAM on the small box; `HYPNO_SKIP_QA=1` skips the QA section entirely (incl. the `faster_whisper` import, which is not installed in the venv). Both are set in `api.env`; the worker also sets them as defaults if missing.
- **Files:** `GET /api/jobs/:id` returns status (+ manifest once ready); `GET /api/jobs/:id/files/:name` streams the mastered MP3/WAV listed in the manifest (attachment, ready jobs only).

