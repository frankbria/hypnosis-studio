# Setup required before launch

Things that need a real value from a human before the studio can take money.
Everything here currently runs on a **stub or a safe default** — nothing is
broken, but nothing on this list is live either.

`.env.example` is the reference for the variables themselves (and a test fails
if a variable the code reads is missing from it). This file is the shorter
question: *what does a person still have to go and get?*

Status legend: 🔴 blocks launch · 🟡 needed before it is public · 🟢 optional

**Nothing on this list is a code change.** Phase 2 is complete; every item here
is a value only a person can obtain, plus one asset that needs a real render.

## The short version

| What | Variable | Without it |
|---|---|---|
| Stripe secret key | `STRIPE_SECRET_KEY` | checkout answers 503; nobody can buy |
| Stripe webhook secret | `STRIPE_WEBHOOK_SECRET` | payments never start a render |
| Public URL | `PUBLIC_BASE_URL` | checkout and the delivery email are both disabled |
| Email provider | `EMAIL_API_KEY`, `EMAIL_FROM` | finished programs are never announced |
| ElevenLabs scope | (widen the existing key) | the credit preflight is off |
| Program samples | — | the front page offers a voice clip, not a program (#60) |

**Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` together.** A secret key
with no webhook secret takes payments that never render.

---

## 🔴 Stripe account and secret key — #22

| | |
|---|---|
| Variable | `STRIPE_SECRET_KEY` |
| Current value | **unset**, deliberately |
| Behaviour today | `POST /api/checkout` answers `503 checkout_disabled`; the delivery screen says "Checkout is not open yet." |
| Where it goes | `<repo>/.env` locally; the systemd environment in production (see `ENVIRONMENT.md`) |

Both #22 and #23 have shipped, so setting this no longer means taking money for
nothing —
a signature-verified `checkout.session.completed` starts the render. Set
`STRIPE_WEBHOOK_SECRET` below **in the same change**; a secret key with no
webhook secret takes payments that never render.

A test key (`sk_test_…`) from any Stripe account is safe to use locally right
now and is enough to exercise the whole flow.

To get one:
1. Create the Stripe account and complete activation (business details, bank
   account) — activation is what allows live charges, and it is not instant.
2. Developers → API keys → Secret key.
3. Confirm the account's default currency matches `PROGRAM_CURRENCY` (`usd`).

## 🔴 Stripe webhook endpoint and signing secret — #23

| | |
|---|---|
| Variable | `STRIPE_WEBHOOK_SECRET` (`whsec_…`) |
| Current value | **unset** |
| Behaviour today | `POST /api/stripe/webhook` answers `503 webhook_not_configured`; `POST /api/programs` still accepts `ACCESS_CODE` |

**A different value from `STRIPE_SECRET_KEY`.** This is the credential that
authorises spending ElevenLabs credits.

To get one:
1. Stripe dashboard → Developers → Webhooks → Add endpoint.
2. URL: `https://<your domain>/api/stripe/webhook`.
3. Subscribe to **`checkout.session.completed`** (the only event the server acts
   on; anything else is acknowledged and ignored).
4. Copy the endpoint's signing secret.

Locally, `stripe listen --forward-to localhost:4100/api/stripe/webhook` prints a
`whsec_` for that session — no dashboard endpoint needed.

⚠️ **Setting this closes the early-access path.** `POST /api/programs` starts
answering `503 rendering_requires_payment`, and the wizard says "Early access
has closed — programs are now bought through checkout." That is deliberate: see
`ENVIRONMENT.md`. Do not set it until you want the free path shut.

## 🔴 Public base URL — #22

| | |
|---|---|
| Variable | `PUBLIC_BASE_URL` |
| Current value | **unset** |
| Behaviour today | checkout stays disabled; a malformed value is also treated as unset, with a log line naming the variable |

Where Stripe returns the customer after paying or cancelling, e.g.
`https://hypnosisstudio.com`. Required rather than derived from the request's
`Host` header, which a client can forge — a forged one would land the customer
on somebody else's site the instant after paying us.

## 🟡 Confirm the price — #22

| | |
|---|---|
| Variable | `PROGRAM_PRICE_CENTS` (default `3900`) |
| Current value | the documented default, $39.00 |

$39 is the agreed ladder from the marketing plan and is what the site displays.
A test fails if the server default and the displayed `$39` ever disagree, so
changing the price means changing `web/src/lib/data.ts` in the same commit.

## 🟢 Rate cap — #22

`CHECKOUT_MAX_PER_MINUTE` (default `30`) bounds how many Checkout Sessions the
service will ask Stripe for per minute, across all callers. The default is
fine; raise it only if real traffic ever approaches it.

## 🔴 Email provider — #28

| | |
|---|---|
| Variables | `EMAIL_API_KEY`, `EMAIL_FROM` |
| Current value | **both unset** |
| Behaviour today | nothing is emailed; each order records `delivery: skipped` and the customer still has their `/program/<id>` page |

A 15–20 minute render means nobody sits on the page, so without this a finished
program has no way of reaching the person who bought it.

**Defaults to [Resend](https://resend.com).** Nothing about that is load-bearing
— the provider surface is one `fetch` in `sendEmail()` plus `EMAIL_API_BASE`, so
Postmark, Mailgun or SendGrid are a contained swap. Resend was chosen because
its API is a single JSON POST, which is what a zero-dependency server can do
without an SMTP library.

To get one:
1. Create the account and **verify a sending domain** — this is the slow part
   (DNS records, and propagation), so start it before you need it.
2. Create an API key → `EMAIL_API_KEY`.
3. Set `EMAIL_FROM` to an address **on that verified domain**. There is no
   default: sending from something that will bounce is worse than not sending.
4. `PUBLIC_BASE_URL` must also be set — the email's whole purpose is the link,
   and it cannot be built without it.

## 🟡 Support address — #28

| | |
|---|---|
| Variable | `SUPPORT_EMAIL` (server), `VITE_SUPPORT_EMAIL` (site) |
| Current value | both default to `frank.bria@pm.me` |

Two variables for one address, because the site's copy is inlined by Vite at
**build** time and the server's is read at **run** time. A test fails if the two
defaults ever disagree. Set both, and remember the site one needs a rebuild.

It must be monitored by a person: `/refunds` and the delivery email both say so.

## 🟡 Two-minute program samples — #60

| | |
|---|---|
| Needs | a pre-rendered catalog (#58), which needs `ELEVENLABS_API_KEY` and real spend |
| Current state | the catalog home page plays the existing **narrator voice clips** instead |

#68 shipped the catalog home page with a playable sample, but the *intended*
sample — two minutes of a real mixed program — does not exist, because #60 is
blocked by #58 and #58 needs roughly 200k characters of ElevenLabs spend across
ten renders.

What is there now is honest: real audio of the voice that narrates the program.
It deliberately **excludes the whisper clips**, because #60 is open partly
because the whisper is previewed solo — unmixed, no narrator over it, no bed
underneath, which is the most uncanny configuration synthetic audio can be in.

This is the one thing on this list that is not a value to paste somewhere.

## 🟢 If you shorten retention — #103

The server now **refuses to start** if `RETENTION_DAYS` is below what the site
promises, rather than deleting a customer's files three weeks before they were
told. If you shorten it, change the copy in `web/src/lib/legal.ts`, rebuild the
frontend, and set `RETENTION_PROMISED_DAYS` to match. Longer is always fine.

---

## Already required, unchanged

- `ELEVENLABS_API_KEY` — the one existing hard requirement. **Its scope changed
  in #25**: it now needs **User → Read** as well as **Text to Speech → Access**,
  so the server can check the remaining plan balance before letting anyone pay.
  A key without the new scope keeps working — the preflight logs the missing
  scope by name and falls back to the local monthly ledger — but the protection
  it buys is off until you widen it. See `ENVIRONMENT.md`.
- `ACCESS_CODE` — the prototype gate on `POST /api/programs`. Its old value is
  in git history and must be rotated before the site is public (#32).
- `VITE_SUPPORT_EMAIL` — build-time, so changing it means rebuilding the
  frontend. Falls back to a real monitored address.
