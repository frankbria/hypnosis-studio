# Setup required before launch

Things that need a real value from a human before the studio can take money.
Everything here currently runs on a **stub or a safe default** — nothing is
broken, but nothing on this list is live either.

`.env.example` is the reference for the variables themselves (and a test fails
if a variable the code reads is missing from it). This file is the shorter
question: *what does a person still have to go and get?*

Status legend: 🔴 blocks launch · 🟡 needed before it is public · 🟢 optional

---

## 🔴 Stripe account and secret key — #22

| | |
|---|---|
| Variable | `STRIPE_SECRET_KEY` |
| Current value | **unset**, deliberately |
| Behaviour today | `POST /api/checkout` answers `503 checkout_disabled`; the delivery screen says "Checkout is not open yet." |
| Where it goes | `<repo>/.env` locally; the systemd environment in production (see `ENVIRONMENT.md`) |

#23 has now shipped, so setting this no longer means taking money for nothing —
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

---

## Already required, unchanged

- `ELEVENLABS_API_KEY` — the one existing hard requirement. Scoped to
  **Text to Speech → Access** only; see `ENVIRONMENT.md`.
- `ACCESS_CODE` — the prototype gate on `POST /api/programs`. Its old value is
  in git history and must be rotated before the site is public (#32).
- `VITE_SUPPORT_EMAIL` — build-time, so changing it means rebuilding the
  frontend. Falls back to a real monitored address.
