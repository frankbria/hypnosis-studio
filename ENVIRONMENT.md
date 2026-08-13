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

> **`engine/api.env` is on its way out.** It duplicates `.env` and is the reason
> this page exists — see [Consolidating to one file](#consolidating-to-one-file).

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
- **On the server, today:** `/srv/hypnosis-studio/engine/api.env`, which the
  systemd unit loads as an `EnvironmentFile`.

**Two files is the state that caused this document to exist, and it should be
one.** See the migration below.

---

## Consolidating to one file

`engine/api.env` is misleadingly named: it is not engine-specific. It supplies
`ACCESS_CODE` to Node, and Node passes its whole environment to the Python
worker. Nothing about it belongs under `engine/`.

Since `server.js` loads `.env` itself, **systemd does not need to supply
configuration at all** — the `EnvironmentFile=` line can be removed, leaving one
mechanism that behaves identically in development and production.

    now:    systemd ──> engine/api.env  ┐
            server.js ──> <repo>/.env   ┴─ two files, two mechanisms

    after:  server.js ──> <repo>/.env   ─── one file, same as local

### Migration, in an order that cannot break a render

Each step is separately reversible, and the service keeps a working environment
throughout. A deploy will not interfere: the workflow uses `scp` with an
explicit source list, so it copies named paths and never deletes anything else.

1. On the server, copy the file next to `server.js` — do not move it yet:

       cd /srv/hypnosis-studio && cp engine/api.env .env

   Both files now exist with the same contents. `server.js` reads `.env`;
   systemd still reads `api.env`. The values are identical, so nothing changes.

2. Restart and confirm a render still works end to end. If anything is wrong,
   delete `.env` and you are back where you started.

3. Remove `EnvironmentFile=/srv/hypnosis-studio/engine/api.env` from the systemd
   unit, `systemctl daemon-reload`, restart, confirm again. Now only `.env` is
   supplying anything.

4. Delete `engine/api.env`.

Do **not** reverse steps 1 and 3. Removing the `EnvironmentFile` before the new
file exists starts the service with no `ELEVENLABS_API_KEY`, and the failure
appears at the TTS step of the next paid render rather than at boot.

The systemd unit is not in this repository (#43). Committing it there is what
makes this change reviewable rather than a remembered server edit.

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

This key buys exactly **one** call — the studio's other outbound call goes to
Stripe with a different credential entirely (see below):

```
POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128
     header: xi-api-key
     body:   { text, model_id: "eleven_v3", voice_settings }
```

`engine/render_track.py` holds the only `urlopen` in the project. Since #25 the
Node server makes one more call, with the same key:

```
GET https://api.elevenlabs.io/v1/user/subscription
    header: xi-api-key
```

So a scoped key needs **Text to Speech → Access** and **User → Read**.

Specifically *not* needed, including the ones that look plausible:

| Scope | Why not |
|---|---|
| Voices | voice IDs are hardcoded in `VOICE_SETS`; we never enumerate them |
| Models | `eleven_v3` is a string literal in `render_track.py` |
| History | generations are recorded automatically; nothing queries them |
| Workspace | nothing reads the account or its members |
| Everything else | no code path touches dubbing, agents, projects, music, STT, or sound effects |

**User → Read was added by #25** and is the only scope change since this file
was written. A key without it keeps working: the preflight logs the missing
scope by name and falls back to the local monthly ledger rather than refusing
every sale.

### The credit preflight (#25)

The plan quota and the daily cap were never reconciled — ~20k characters a
program against a 500k plan is ~25 programs a month, while `MAX_JOBS_PER_DAY=6`
permits ~180. Once money changes hands the gap has a specific shape: a customer
pays, waits twenty minutes, and receives a quota-exhaustion failure.

`POST /api/checkout` now refuses (`503 temporarily_unavailable`) before a
Checkout Session exists, when **either**:

- the local `MONTHLY_CHAR_BUDGET` ledger cannot cover the program, or
- the ElevenLabs plan balance cannot.

The local half needed no provider call at all, and it mattered most: since #23
the render starts from the webhook, so every refusal `startRender()` makes now
lands *after* the charge.

Priced against the specific goal and voice set, not the worst-case program:
since #9 a repeat of the same pair costs nothing, and refusing a render that is
free would be a lost sale over credits that would not be spent.

**When the balance cannot be read**, the sale proceeds. A stale reading is
preferred to none — credits do not move quickly at ~20k a program — and a
never-successful read (missing key, missing scope) is a configuration problem
for the log, not a reason to stop selling. The local ledger still bounds spend
in every one of those cases.

`CREDIT_CACHE_MS` (default 60 s) keeps this off the critical path, and
concurrent checkouts on a cold cache share one request rather than opening one
each.

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

## The Stripe key (#22)

**Optional, and currently it must stay unset in production.**

`POST /api/checkout` creates a Stripe Checkout Session. Nothing yet turns a
completed payment into a render — that is #23, which verifies the webhook
signature and starts the job. **Setting `STRIPE_SECRET_KEY` before #23 ships
means the studio can take $39 and produce nothing.** While it is empty the
endpoint answers `503 checkout_disabled`, which is the correct state today.

Test keys (`sk_test_…`) are safe locally at any point.

### The second outbound call

```
POST https://api.stripe.com/v1/checkout/sessions
     header: Authorization: Bearer $STRIPE_SECRET_KEY
             Stripe-Version: 2024-06-20        (pinned in server.js)
     body:   form-encoded — mode, line_items, metadata
```

Made with the runtime's own `fetch`. There is **no `stripe` package**: this repo
has zero dependencies and the deploy workflow copies
`server.js,package.json,engine/**,web/dist/**,deploy/**` without ever running
`npm ci` at the root, so an SDK would mean shipping `node_modules` and rebuilding
the pipeline to do it. A Checkout Session is a form POST and the webhook
signature #23 needs is an HMAC — both are native.

The API version is pinned in source rather than left to the account default,
which Stripe can change from the dashboard: otherwise the shape of what this
code sends and reads could change with no commit anywhere in this repository.

### Where the price lives

`PROGRAM_PRICE_CENTS` (default `3900`) is **the** price. Until #22 it existed
only as the string `'$39'` in the frontend bundle, which meant it was whatever
the browser said it was; the endpoint now reads `goal` and `voiceSet` from the
request body and nothing else, and a test asserts that against every field name
a tampered request would use.

The `'$39'` on the site is still display text — fetching it at runtime would
flash the wrong price for one paint — so a test in `test/web.claims.test.js`
pins the two together, along with `PROGRAM_CURRENCY` against the `$` the site
writes. Changing the price means changing both.

### The webhook secret is the real credential (#23)

`STRIPE_WEBHOOK_SECRET` (`whsec_…`, from the dashboard endpoint) is a
**different value** from `STRIPE_SECRET_KEY`, and it is the one that authorises
spending ElevenLabs credits: a signature-verified `checkout.session.completed`
on `POST /api/stripe/webhook` is what starts a render.

**Setting it closes the `ACCESS_CODE` path.** `POST /api/programs` then answers
`503 rendering_requires_payment`. That is the point rather than a side effect —
`ACCESS_CODE` is a shared, unrate-limited string that spends real credits and
whose value has been in a public git history since the first commit (#32).
Leaving it live beside a paid path means the paid path guards nothing.

The signature is verified against the **raw request bytes**, so the webhook
reads the body separately from every other route: `JSON.stringify(JSON.parse(x))`
is not `x`, and verifying against a re-serialisation fails on genuine events.
Parsing happens only after the signature checks out.

Replay is handled by the order record under `<RENDERS_DIR>/.sessions/`, created
with the `wx` flag so the create *is* the lock — two concurrent deliveries of
the same event cannot both pass. It is never deleted; whether a paid order is
still owed is answered from what the record and the jobs say, not from a clock.

---

## The order record (#24)

One file per purchase, at `<RENDERS_DIR>/.sessions/<sessionId>.json`:

```json
{
  "sessionId":     "cs_…",
  "paymentIntent": "pi_…",
  "email":         "buyer@example.com",
  "amountTotal":   3900,
  "currency":      "usd",
  "goal":          "polymath",
  "voiceSet":      "male",
  "jobId":         "job_…",
  "claimedAt":     "2026-08-13T…"
}
```

**It is deliberately not inside the job directory.** `sweepExpiredJobs()`
deletes whole job directories after `RETENTION_DAYS`, and an order stored there
would be destroyed on day 31 — taking the payment reference and the customer
email with it, exactly when a refund or a support query needs them. A refund
request arrives *after* the audio is gone, not before. `JOB_DIR_RE` requires a
`job_` prefix, so the sweep can never select `.sessions/`.

The job holds a back-pointer (`<job>/order.json` → `{ sessionId }`), so
`job → order` is one hop. A sidecar rather than a `status.json` field, for the
same reason `worker.json` is one: the Python worker rewrites `status.json`
wholesale on every transition and would erase it.

`amountTotal` and `currency` record what was actually taken, not what
`PROGRAM_PRICE_CENTS` happens to be later — a refund after a price change must
return the amount paid.

**It is never served.** `/api/jobs/<id>` merges `status.json` and
`manifest.json` only, and `/api/jobs/<id>/files/<name>` is allowlisted from the
manifest's tracks. Both are pinned by tests, because the endpoint is public and
unauthenticated and the record holds an email address.

Storing an email is a new category of personal data, so `/privacy` changed in
the same commit — it used to say "we do not have one on file for you", which was
true until it wasn't.

Locally: `stripe listen --forward-to localhost:4100/api/stripe/webhook` prints a
`whsec_` for the session.

### The cap on session creation

`/api/programs` is gated by `ACCESS_CODE`, `MAX_JOBS_PER_DAY` and
`MONTHLY_CHAR_BUDGET`. `/api/checkout` can have none of those — it is the
endpoint a customer who has not bought anything must be able to reach — so
`CHECKOUT_MAX_PER_MINUTE` (default 30) is what bounds a loop against it.

It is a **global** cap, not per-IP: behind nginx every peer address is
`127.0.0.1`, so a per-IP bucket would have to key on `X-Forwarded-For`, which a
client can forge. The ceiling that buys is that one attacker can lock out real
customers for a minute. Rejected (422) and unconfigured (503) requests never
spend a slot, because they never reach Stripe.

### `PUBLIC_BASE_URL` is required, not derived

Where Stripe returns the customer after paying or cancelling. The server refuses
checkout (503) when it is unset rather than deriving it from the request's
`Host` header: that header is client-supplied, and a forged one would send the
customer to somebody else's site the instant after they paid us.

---

## The delivery email (#28)

Nobody watches a progress bar for twenty minutes, so a finished program is
emailed to the address Stripe collected at checkout. The email carries the
`/program/<id>` link from #27, not the audio — the masters are hundreds of
megabytes.

```
POST https://api.resend.com/emails
     header: Authorization: Bearer $EMAIL_API_KEY
     body:   { from, to, subject, text, html }
```

The third and last outbound call, and the third to use the runtime's own
`fetch`. SMTP would have meant a dependency; the provider surface is one
function (`sendEmail`), so a swap is contained.

**When it sends.** The trigger is state, not an event: `sweepUndelivered()`
looks for a job that is `ready`, has an order with an email, and has no
delivery record. The worker-exit handler also calls it for promptness, but the
sweep is what makes it a guarantee — a job that finishes while the service is
restarting is observed by no exit handler at all. That correction is the same
one #26 needed.

**Exactly once.** Same three layers as the refund: a `wx` claim file, a recorded
`delivery` state on the order, and a bounded retry (5). A restart, a resent
webhook and a sweep that keeps running afterwards all produce one email.

**When it does not send:** a failed or refunded render, an order with no email
address, or an unconfigured provider. Each records why on the order rather than
retrying forever, and an unconfigured provider says so once rather than every
sixty seconds.

The copy states the retention window from `RETENTION_DAYS` and the support
address from `SUPPORT_EMAIL` — both read from the same values the rest of the
system uses, because this email is the document a customer still has three
weeks later, and a number retyped into it would drift from the sweep that
deletes their files.

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
4. If production should set it, say so. Once the consolidation above is done
   that is `<repo>/.env` on the server and nowhere else; until then it is
   `engine/api.env`.
