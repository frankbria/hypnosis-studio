# Environment

Where configuration comes from, who reads it, and *when*. Written because a
`.env` file was created that nothing read — the server started cleanly and the
failure would have surfaced twenty minutes later, inside a paid render.

`.env.example` is the reference for individual variables and their defaults.
This file is the map.

---

## Three sources, three different moments

| Source | Read by | When | Survives a restart? |
|---|---|---|---|
| `<repo>/.env` | `server.js`, via `process.loadEnvFile` | server start | reread on restart |
| `/srv/hypnosis-studio/engine/api.env` | systemd, as `EnvironmentFile` | service start | reread on restart |
| `VITE_*` | Vite, at build time | `npm run build` | **baked into the bundle** |

The third row is the one that surprises people. `VITE_*` variables are not read
at runtime at all — Vite substitutes the literal value into the JavaScript when
the bundle is built. Changing `VITE_SUPPORT_EMAIL` and restarting does nothing;
you have to rebuild the frontend.

### Precedence

The real process environment **wins** over `.env`.

`process.loadEnvFile` does not overwrite variables that are already set, so a
systemd-supplied value beats a stale `.env` left in a deploy directory. This is
deliberate: the file is a development convenience, not an override channel.

```
systemd EnvironmentFile  >  <repo>/.env  >  the default in server.js
```

### Which file do I put the key in?

- **Locally:** `<repo>/.env`. Copy `.env.example` and fill it in.
- **On the server:** `/srv/hypnosis-studio/engine/api.env`, which the systemd
  unit loads. A `.env` in the deploy directory is not read by systemd and is not
  the mechanism the service uses.

Both work locally; only `api.env` is wired in production.

---

## Who needs what

`server.js` reads its variables at module load, before any of them are used, and
passes `env: process.env` to the Python worker it spawns. So the engine inherits
everything the server has — there is no second configuration step, and
`ELEVENLABS_API_KEY` reaches the worker because the server had it, not because
the worker looked it up.

```
systemd ──EnvironmentFile──> node server.js ──env: process.env──> python worker
                                   ▲
                          <repo>/.env (dev only, loses to the above)
```

The frontend is not in this chain at all. It has no runtime configuration: what
it knows was compiled in.

---

## The ElevenLabs key

**Required.** Without it the engine cannot voice anything, and a render fails at
the TTS step rather than at startup — the failure is far from the cause.

### Scope: Text to Speech only

The entire codebase makes **one** outbound call:

```
POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128
     header: xi-api-key
     body:   { text, model_id: "eleven_v3", voice_settings }
```

`engine/render_track.py` holds the only `urlopen` in the project. A scoped key
therefore needs **Text to Speech → Access** and nothing else.

Specifically *not* needed, including the ones that look plausible:

| Scope | Why not |
|---|---|
| Voices | voice IDs are hardcoded in `VOICE_SETS`; we never enumerate them |
| Models | `eleven_v3` is a string literal in `render_track.py` |
| History | generations are recorded automatically; nothing queries them |
| User / Workspace | nothing reads the balance or the account |
| Everything else | no code path touches dubbing, agents, projects, music, STT, or sound effects |

If #25 (preflight the credit balance before capturing payment) is built, that
adds a `User` read — revisit the scope then rather than pre-granting it now.

### Cost

A full program is ≈16k characters of TTS, ≈131 segments across four tracks.
Billing is per character. Two ledgers bound the spend, both enforced server-side
before a render starts:

- `MAX_JOBS_PER_DAY` (default 6) — renders started per calendar day
- `MONTHLY_CHAR_BUDGET` (default 500,000) — characters per calendar month; the
  server refuses a render it cannot pay for rather than discovering the ceiling
  mid-job, and refunds the ledger when a job fails

The content-keyed segment cache means a retry re-buys only what it never
reached, and identical segments are paid for once across programs.

---

## Secrets

`.gitignore` covers `.env` and `.env.*`, with `!.env.example` as the single
exception. Keep real values out of the example file.

**`ACCESS_CODE` is a secret and has not been treated as one.** Its live value is
printed in `DEPLOYMENT.md` in a public repository, and has been since the first
commit. It is the only gate on `POST /api/programs`, which spends ElevenLabs
credits. Tracked as #32; rotation on the server has to come before scrubbing the
document, because the value is in git history either way.

---

## Adding a variable

1. Read it in `server.js` or the engine as usual.
2. Add it to `.env.example` as a settable `# VAR=value` line with its real
   default — a test derives the list from the source and fails if it is missing.
   A prose mention does not count; a key you cannot copy-paste is not
   documented.
3. If it is `VITE_*`, say in the comment that it is build-time and needs a
   rebuild.
4. If production should set it, say which file: `api.env` on the server.
