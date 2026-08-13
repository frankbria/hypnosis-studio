# Deployment — prod-linode (45.33.41.124)

> **Environment:** see [ENVIRONMENT.md](ENVIRONMENT.md) for where configuration comes from, which file production reads, and the ElevenLabs key scope.

## Architecture

Push to `main` → GitHub Actions (environment `production`) → SSH (user `deploy`) → `/srv/hypnosis-studio` → **wait for no render in flight** → `sudo systemctl restart hypnosis-studio` → smoke test on 127.0.0.1:4100.

### The restart gate (`deploy/wait-for-idle.sh`)

`systemctl restart` kills the Python worker along with the service (it is a non-detached child in the
service cgroup), and the restarted server then marks the orphaned job `failed`. A render takes 15–20
minutes, so any deploy landing in that window destroys a render the customer paid for.

Before restarting, the deploy polls `/api/health` — which reports `rendering: true|false` from the same
predicate the API uses to return 409 `busy` — and:

- **waits** while `rendering` is `true`, polling every 15 s;
- **fails the deploy** if a render is still running after **25 minutes** (`command_timeout` is 30 m to
  cover it). It refuses to restart rather than destroying the render — re-run the deploy once it finishes;
- **proceeds** if `rendering` is `false`, if the field is absent, or if health is unreachable.

That last case is deliberate **fail-open**. An absent field means an old server (the one running when
this first shipped predates it), and unreachable means the service is already down. Waiting wrongly
would hang every deploy for 25 minutes forever; proceeding wrongly costs at most one render, and only
when a live render coincides with an unreadable health endpoint.

Override for a one-off: `bash deploy/wait-for-idle.sh <url> <timeout-seconds> <poll-seconds>`.

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

## Two-door site architecture (2026-07-23)

The SPA has two storefronts behind a door chooser:

- **`/`** — door chooser landing (two cards: Performance and Healing)
- **`/performance`** — the original learning/optimization catalog (polymath, golden_thread, inner_studio, open_gate + coming-soon tiles)
- **`/healing`** — mind-body rest/repair visualizations, **explicitly non-medical** ("Not medicine. Not treatment. Always alongside — never instead of — medical care."); launches with the `river` goal

Routing is client-side only: the app reads `window.location.pathname` (no router dependency; browser back/forward is handled via `popstate`, and in-app navigation uses `history.pushState`). Trailing slashes are normalized client-side because the vite build uses `base: './'`. The wizard keeps the door path in the URL bar, and the brand mark returns to `/`. `document.title` is set per door client-side (`Hypnosis Studio — Performance` / `— Healing`); **true per-route meta/OG tags would need SSR or prerendering — not implemented.**

**Server:** no route changes are needed — `serveStatic` already falls back to `index.html` for any extension-less path, so `/performance` and `/healing` are served by the existing SPA catch-all; `/api/*` handling is untouched.

## Render pipeline

`POST /api/programs` spawns one worker per job and tracks it on disk; no queue daemon.

- **Worker flow** (`engine/render_program.py`, per job): renders the full **4-track program** (I Foundation, II Deepening, III Mastery, IV Integration — tracks 1–3 run 900 s, track 4 runs 420 s; all pads are 960 s so one pad serves every track). Stages: `scripting` (copy `engine/scripts/<goal>[_trackN]_tts_segments.json` ×4 into the job dir, verify pad) → `voicing` / `whisper-layer` (ElevenLabs TTS per segment across all 4 tracks — narrator voice `[soft]` for non-suggestion phases, whisper voice `[whispering]` for suggestion; idempotent — existing segment WAVs are skipped, and any segment already purchased by an earlier job is served from the shared segment cache at `RENDERS/segment-cache/` (see `engine/README.md`), so a retry re-buys only what it never reached; status detail reads `track N/4 · segment Sxx`) → `entrainment-bed` (`assemble_track.py` as a subprocess per track with `cwd` = job dir, TOTAL_S 900/900/900/420) → `mastering-qa` (write `manifest.json`). Progress lives in `renders/<jobId>/status.json`, written atomically at every transition; worker stdout/stderr goes to `renders/<jobId>/worker.log`.
- **Manifest:** `manifest.json` now lists all four masters — `{"tracks": [{"n", "id", "title", "phase", "durationSec", "mp3", "wav"}, ...]}` with files `<goal>_track1.mp3/.wav` … `<goal>_track4.mp3/.wav`. The manifest is written only after all 4 tracks master successfully, so partial renders are never listed. The server tolerates legacy single-track manifests when serving files.
- **ElevenLabs credits:** a full program is ≈16k characters of TTS (≈131 segments across 4 tracks) — roughly **4× the credits of the old single-track render** per job. `MAX_JOBS_PER_DAY` (default **6**, in `engine/api.env`) is the lever that governs daily credit burn; lower it if credit usage outpaces the plan.
- **Paths:** venv `/srv/hypnosis-studio/engine/venv` (worker runs as `<venv>/bin/python`), pads `/srv/hypnosis-studio/engine/pads/*.wav` (960 s mono 44.1 kHz — **server-only, not in git**), renders `/srv/hypnosis-studio/renders/<jobId>/`, env `/srv/hypnosis-studio/engine/api.env` (loaded by the systemd unit; provides `ELEVENLABS_API_KEY`, `ACCESS_CODE`, `HYPNO_DTYPE`, `HYPNO_SKIP_QA` to Node and its children).
- **Early access:** the render endpoint requires `accessCode` = `ACCESS_CODE` from `api.env` (currently **`polymath-2026`**). If `ACCESS_CODE` is unset, the endpoint answers 503 `rendering_disabled`.
- **Concurrency & quota:** one render at a time (409 `busy` while any job is `rendering`); daily cap `MAX_JOBS_PER_DAY` (default **6**, persisted in `renders/.quota.json`, 429 `daily_cap` when reached).
- **Monthly spend budget:** **`MONTHLY_CHAR_BUDGET`** (default **500 000** characters) bounds ElevenLabs spend in the unit the provider actually meters. `MAX_JOBS_PER_DAY` remains, but as a *burst* control only — 6/day permits ~180 programs a month, which does not bound spend against any plan below Business; it only spreads it out, and a busy first week then exhausts the month with every later render failing after payment.
  - Each goal is charged its **real script length**, computed at boot from `engine/scripts/*.json` using the exact string sent to the API (`[soft] ` or `[whispering] ` plus the text). Measured today: river 21 811 · golden_thread 19 013 · polymath 19 006 · inner_studio 18 353 · open_gate 16 613. Computed rather than hard-coded, so editing a script cannot silently desynchronise the budget from the bill.
  - A request that would exceed the remaining month is refused with **`503 budget_exhausted`** *before* any worker starts — distinct from the daily cap's `429 daily_cap`, because they mean different things: "come back tomorrow" versus "unavailable until the plan resets or is raised".
  - A failed render **refunds** its characters, on the same ledger and the same idempotency rules as the daily quota slot (see #10). Spend is tracked in `renders/.budget.json`, keyed on the month; a file from another month is discarded on read.
  - **Sizing it against the plan:** at ~19 400 characters per program, a Creator allocation (~100k) covers ~5, Pro (~500k) ~25, Scale (~1.8M) ~92. Set `MONTHLY_CHAR_BUDGET` to the allocation actually being paid for, minus whatever headroom other usage needs.
  - Remaining allowance is on **`/api/health`** under `budget` — `charsUsed`, `charsRemaining`, `charsBudget`, and `programsLeft` measured against the *dearest* goal, so it is the number that cannot disappoint.
- **Stale jobs:** a `rendering` job is reclaimed only when its **worker is actually gone** — checked against the in-process child set and, for jobs orphaned across a restart, the `worker.pid` sidecar in the job directory. It is deliberately *not* judged by how long ago `status.json` was touched: a single TTS stall is ~8.8 minutes (4 attempts × a 120 s timeout plus 5+15+30 s of backoff, and up to ~17.7 through the fallback settings), and assembly writes status once per track. The previous 2-minute timestamp rule fired on healthy renders, marked them `failed` without killing the child, and freed the concurrency lock — letting a second render start alongside the first, which is the OOM the chunked assembler exists to avoid (#11).
  - **`HARD_TIMEOUT_MS`** (default **45 min**) is the backstop: liveness alone never recovers a worker wedged forever on a socket. A job past the ceiling is swept **and its worker killed** (SIGTERM, then SIGKILL after 1 s) — the only path that kills. The default clears a full 15–20 minute render plus a worst-case stall.
  - **`SWEEP_INTERVAL_MS`** (default **60 s**) controls how often both sweeps run.
- **Retention:** finished job directories are reaped after **`RETENTION_DAYS`** (default **30**). The sweep runs on boot and every 60 s, immediately after the stale-job sweep. It deletes a directory only if it is a real directory (not a symlink) named `job_…`, has a parseable `status.json` in a terminal state (`ready`/`failed`), and has an `updatedAt` older than the window — anything ambiguous is skipped and left on disk. Each reap logs the job id, state, age and bytes freed.
- **Segment cache:** `RENDERS/segment-cache/` holds already-purchased TTS segments, shared across jobs and customers. It is deliberately *not* named `job_…`, so the retention sweep above cannot select it. It is bounded separately by **`SEGMENT_CACHE_MAX_BYTES`** (default **4 GB**; one goal/voice-set pair is ~80 MB, all ten ~800 MB), evicted least-recently-used by a sweep that runs at the end of each render. Deleting the directory is safe — it costs money, not correctness.
  - **`RETENTION_DRY_RUN=1`** logs what *would* be reaped without deleting anything. **Set this for the first run after changing `RETENTION_DAYS`**, read one sweep's output, then unset it — this is the one lever in the system that destroys customer deliverables.
  - A job failed by the stale sweep gets a fresh `updatedAt`, so its retention clock starts from the terminal state rather than from when it hung. That is why the two sweeps run in that order.
  - **`RENDERS_DIR`** overrides the renders root (default `./renders`), so it can be a mounted volume.
- **Env flags on the assembler:** `HYPNO_DTYPE=float32` halves mixer RAM on the small box; `HYPNO_SKIP_QA=1` skips the QA section entirely (incl. the `faster_whisper` import, which is not installed in the venv). Both are set in `api.env`; the worker also sets them as defaults if missing.
- **Files:** `GET /api/jobs/:id` returns status (+ manifest once ready); `GET /api/jobs/:id/files/:name` streams the mastered MP3/WAV listed in the manifest (attachment, ready jobs only).

### Goal registry

| Goal id | Program title | Pad | Door |
|---|---|---|---|
| `polymath` | The Polymath Mind | `pad_15.wav` | Performance |
| `golden_thread` | The Golden Thread | `pad_golden_15.wav` | Performance |
| `inner_studio` | The Inner Studio | `pad_studio.wav` | Performance |
| `open_gate` | The Open Gate | `pad_gate.wav` | Performance |
| `river` | The River of Renewal | `pad_15.wav` (shared with polymath) | Healing |

`river` follows the standard suffix pattern — `engine/scripts/river_tts_segments.json` + `river_track2/3/4_tts_segments.json`; QA keywords `river,healing,rest,renewal,breath`. Goal allow-lists live in `engine/render_program.py` (`GOALS`/`PADS`/`KEYWORDS`/`TITLES`) and `server.js` (`VALID_GOALS`); the frontend door catalogs live in `web/src/lib/data.ts` (`door` field per goal).

