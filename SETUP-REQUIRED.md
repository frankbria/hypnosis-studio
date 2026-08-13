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

**Do not set this until #23 has shipped.** #22 creates the Checkout Session;
#23 is what verifies the webhook signature and actually starts a render from a
completed payment. With the key set and #23 missing, the studio can take $39 and
produce nothing.

A test key (`sk_test_…`) from any Stripe account is safe to use locally right
now and is enough to exercise the whole flow.

To get one:
1. Create the Stripe account and complete activation (business details, bank
   account) — activation is what allows live charges, and it is not instant.
2. Developers → API keys → Secret key.
3. Confirm the account's default currency matches `PROGRAM_CURRENCY` (`usd`).

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
