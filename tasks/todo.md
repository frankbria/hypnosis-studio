# Hypnosis Studio — SaaS Launch Readiness Plan

**Review date:** 2026-08-09 · **Commit:** `2a426af` · **Branch:** `main`
**Method:** five parallel specialist reviews (security, frontend, engine, ops, product) over the full
tree, with every headline finding re-verified against source by the lead before inclusion.

---

> **Superseded in part by [`tasks/marketing-plan.md`](marketing-plan.md) (2026-08-09).** The business model
> changed: the catalog tier is now pre-rendered, so nine issues below (#4, #6, #9, #10, #11, #25, #26,
> #27, #56) are no longer launch-blocking — they move to the Personalized tier's wave. Each is annotated
> in GitHub. Issues #58–#79 were added by that review.

## Verdict: **DO NOT LAUNCH.** Not ready to take money.

The craft in this repo is genuinely good — the DSP chain is correct, the chunked assembler is a real
fix for a real OOM, status writes are atomic, the crash-recovery sweep works, and path traversal on
both file routes is properly blocked. The problem is not code quality. It is that **a working
prototype and a sellable product are separated by everything that happens when things go wrong**,
and that layer does not exist yet.

Three facts decide the verdict:

1. **One anonymous GET kills production.** `curl https://hypnosis.frankbria.net/%80` crashes the
   Node process. No auth, no rate limit, one request. `%80` is syntactically valid percent-encoding,
   so nginx forwards it untouched. Verified live.
2. **Nothing verifies the audio a customer downloads.** With `HYPNO_SKIP_QA=1` (production), the
   entire deliverable check is "both files exist" and "duration is readable". Neither reads a single
   sample. An all-silent track ships without a single warning.
3. **There is no payment, no account, and no way back to a purchase.** The `jobId` for a 20-minute,
   ~$4-of-credits render exists only in React state. Close the tab and it is gone forever.

Layered on top: `renders/` is never pruned (~500 MB/job, ~3 GB/day at the current cap) on a **shared
box hosting unrelated vhosts** — this app's success takes down its neighbours. And the pricing page
advertises a $19/mo subscription and a $99 tier with 1:1 consultation, neither of which exists in any
form.

**Shortest credible path to launch:** P0 → P1 → P2. P0 is ~2 weeks of focused work and buys a service
that survives public traffic without destroying paid work. Nothing in P2 (payment) should be built
before P0 lands, because charging for a render that the next deploy silently kills is worse than not
launching.

---

## Severity summary

| # | Finding | Where | Sev |
|---|---|---|---|
| 1 | Unauthenticated one-request process crash via malformed percent-encoding | `server.js:154` | **Critical** |
| 2 | Same crash class: null byte to `fs.readFile`; `statSync` on a missing manifest file | `server.js:159,235` | **High** |
| 3 | No QA gate on the deliverable — silence/garbage ships undetected, in *either* QA mode | `assemble_track.py:206-244` | **High** |
| 4 | `renders/` never pruned; ~500 MB/job on a shared box → takes out other vhosts | `server.js:264` | **High** |
| 5 | Every deploy kills any in-flight paid render | `deploy.yml:41` + `server.js:264` | **High** |
| 6 | `ACTUAL_S` unbounded against a fixed 960 s pad; river T1 has <40 s headroom | `assemble_track.py:91-96` | **High** |
| 7 | Network/timeout TTS errors are never retried — the likeliest failure has zero coverage | `render_track.py:67-69` | **High** |
| 8 | A single late TTS failure discards all 152 segments and 17–22k chars of spend | `render_program.py:239` | **High** |
| 9 | Paid render unrecoverable — `jobId` lives only in React state | `Wizard.tsx:281` | **High** |
| 10 | Pricing page sells two products that do not exist ($19/mo, $99) | `data.ts:241-277` | **High** |
| 11 | No ToS, privacy, refund policy; "Contact" is a dead `#top` anchor | `Landing.tsx:120` | **High** |
| 12 | No rate limiting on the access-code check; code is `polymath-2026`, committed to git | `server.js:186`, `DEPLOYMENT.md:63` | **High** |
| 13 | `HYPNO_DTYPE=float32` silently defeated at the memory high-water mark | `assemble_track.py:157` | **High** |
| 14 | Dead ~1 GB `sosfiltfilt` whose result is discarded, on a box with OOM history | `assemble_track.py:156` | **High** |
| 15 | ElevenLabs plan quota (~25 programs/mo) vs daily cap (~180/mo) — post-payment failures | `server.js:19` | **High** |
| 16 | Advertised durations overstate by ~10 min; track III phase name flips after purchase | `data.ts:209-214` | **Medium** |
| 17 | Medical disclaimer rendered at 3.81:1; healing non-medical notice at 2.60:1 (WCAG AA is 4.5:1) | `Landing.tsx:135`, `Wizard.tsx:935` | **Medium** |
| 18 | Failed render permanently consumes a daily quota slot | `server.js:201` | **Medium** |
| 19 | Stale-sweep (2 min) shorter than worst-case TTS stall (~12 min) → two concurrent workers → OOM | `server.js:264` | **Medium** |
| 20 | Server 5xx shows a "Your program is ready." demo screen | `Wizard.tsx:276` | **Medium** |
| 21 | Unused `react-router` dependency carrying a high-severity CVE | `web/package.json:51` | **Medium** |
| 22 | Deploy actions on mutable tags while holding the prod SSH key | `deploy.yml:26,35` | **Medium** |
| 23 | No backups, no uptime monitoring, no error tracking, no alerting | — | **Medium** |
| 24 | Job IDs are 32-bit capability URLs — becomes a real IDOR the day accounts land | `server.js:195` | **Low→High later** |
| 25 | Zero tests in the repo | — | **Medium** |

### Checked and found clean

Worth recording, so nobody re-audits these: path traversal on **both** file routes is properly
blocked (`path.join` normalizes before the `startsWith` check; the download route is gated by an
exact manifest allow-list). No command injection — `spawn` uses an argv array with `shell:false` and
goal/voiceSet are allow-listed first. **No quota/concurrency race** — there is no `await` between the
checks and the writes, so Node's single thread cannot interleave them. No real secrets in git history
(only an `sk_replace_me` placeholder). CORS needs nothing. CSRF protection here would be theatre —
there is no ambient credential. Bed phase continuity across chunks, the register crossfade, the
master chain arithmetic, timeline breakpoint monotonicity across all 20 scripts, and manifest write
ordering are all correct. Build, typecheck, and lint pass.

---

## Phase P0 — Reliability blockers

*The service must survive a day of public traffic and must never destroy work a customer paid for.
Nothing here depends on payment; all of it is prerequisite to payment.*

| ID | Issue | Files |
|---|---|---|
| **P0.1** · [#1](https://github.com/frankbria/hypnosis-studio/issues/1) | Crash-proof the request handler: wrap `decodeURIComponent`, the handler body, and `statSync` | `server.js:154,159,235,179` |
| **P0.2** · [#2](https://github.com/frankbria/hypnosis-studio/issues/2) | Delete segment intermediates as soon as a job reaches `ready` (largest disk win, zero risk) | `render_program.py:284-293` |
| **P0.3** · [#3](https://github.com/frankbria/hypnosis-studio/issues/3) | Add an age-based retention sweep for finished job dirs *(blocked by P0.1 — deleting files makes `statSync` fatal today)* | `server.js:264-281` |
| **P0.4** · [#4](https://github.com/frankbria/hypnosis-studio/issues/4) | Gate the deploy restart on no in-flight render | `.github/workflows/deploy.yml:34-45` |
| **P0.5** · [#5](https://github.com/frankbria/hypnosis-studio/issues/5) | Bound `ACTUAL_S` by real pad length; replace the bare `assert` with a clear fail-fast | `assemble_track.py:91-96` |
| **P0.6** · [#6](https://github.com/frankbria/hypnosis-studio/issues/6) | Add a real audio QA gate (loudness window + plausible file size) before the manifest is written | `render_program.py:284-292` |
| **P0.7** · [#7](https://github.com/frankbria/hypnosis-studio/issues/7) | Retry network/timeout/5xx-family TTS errors; fail fast and distinctly on 401/403 | `render_track.py:50-70` |
| **P0.8** · [#8](https://github.com/frankbria/hypnosis-studio/issues/8) | Reject truncated TTS responses instead of recording them as success | `render_track.py:56-58` |
| **P0.9** · [#9](https://github.com/frankbria/hypnosis-studio/issues/9) | Cross-job segment cache keyed on (voice, tag, text) so a retry does not re-buy 17–22k chars | `render_program.py:216-244` |
| **P0.10** · [#10](https://github.com/frankbria/hypnosis-studio/issues/10) | Stop consuming a daily quota slot when a render fails | `server.js:201` |
| **P0.11** · [#11](https://github.com/frankbria/hypnosis-studio/issues/11) | Raise `STALE_MS` past worst-case TTS stall, or track the worker pid | `server.js:264-281` |
| **P0.12** · [#12](https://github.com/frankbria/hypnosis-studio/issues/12) | Fix the `float32` defeat and remove the dead ~1 GB `sosfiltfilt` | `assemble_track.py:156-157` |
| **P0.13** · [#56](https://github.com/frankbria/hypnosis-studio/issues/56) | Replace the daily job cap with a monthly TTS spend budget — the cap does not currently bound spend | `server.js:19,96-107,193` |

## Phase P1 — Legal & truth-in-advertising

*Must be true before it is lawful to sell — and Stripe account approval requires the policy pages and
a real contact address to exist first, so this precedes P2.*

| ID | Issue | Files |
|---|---|---|
| **P1.1** · [#13](https://github.com/frankbria/hypnosis-studio/issues/13) | Remove the $19/mo and $99 tiers; ship only the one tier that exists | `data.ts:241-277`, `Landing.tsx:333` |
| **P1.2** · [#14](https://github.com/frankbria/hypnosis-studio/issues/14) | Correct advertised track durations to what the engine renders (46 min, not 56) | `data.ts:209-214` |
| **P1.3** · [#15](https://github.com/frankbria/hypnosis-studio/issues/15) | Resolve the track III phase-name drift (`Suggestion` pre-purchase vs `Mastery` delivered) | `data.ts:200-214`, `render_program.py:77` |
| **P1.4** · [#16](https://github.com/frankbria/hypnosis-studio/issues/16) | Add `/terms` and `/privacy` routes and real content | `App.tsx:12-18`, new sections |
| **P1.5** · [#17](https://github.com/frankbria/hypnosis-studio/issues/17) | Add a refund policy page stating the render-failure guarantee *(blocked by P1.4)* | new section |
| **P1.6** · [#18](https://github.com/frankbria/hypnosis-studio/issues/18) | Replace the dead `#top` "Contact" link with a real support address | `Landing.tsx:116-123` |
| **P1.7** · [#19](https://github.com/frankbria/hypnosis-studio/issues/19) | Raise disclaimer and non-medical copy to WCAG AA contrast | `Landing.tsx:135`, `Wizard.tsx:935` |
| **P1.8** · [#20](https://github.com/frankbria/hypnosis-studio/issues/20) | Add a separate age/health attestation checkbox on the review step | `Wizard.tsx:671-684` |
| **P1.9** · [#21](https://github.com/frankbria/hypnosis-studio/issues/21) | Replace "keep it for life" / "Lifetime download access" with the real retention window *(blocked by P0.3)* | `data.ts:250`, `Landing.tsx:329`, `Wizard.tsx:855` |

## Phase P2 — Monetization & fulfilment

*The actual SaaS layer. Every item assumes P0 reliability and P1 legal pages are done.*

| ID | Issue | Files |
|---|---|---|
| **P2.1** · [#22](https://github.com/frankbria/hypnosis-studio/issues/22) | Move price to the server; add a Stripe Checkout session endpoint | `server.js`, new module |
| **P2.2** · [#23](https://github.com/frankbria/hypnosis-studio/issues/23) | Signature-verified Stripe webhook that gates render start *(blocked by P2.1)* | `server.js` |
| **P2.3** · [#24](https://github.com/frankbria/hypnosis-studio/issues/24) | Persist an order record linking jobId ↔ payment_intent ↔ email *(blocked by P2.2)* | `server.js` |
| **P2.4** · [#25](https://github.com/frankbria/hypnosis-studio/issues/25) | Preflight the ElevenLabs credit balance **before** capturing payment | `server.js`, `render_track.py` |
| **P2.5** · [#26](https://github.com/frankbria/hypnosis-studio/issues/26) | Auto-refund when a worker ends in `failed` *(blocked by P2.3)* | `server.js:140-149` |
| **P2.6** · [#27](https://github.com/frankbria/hypnosis-studio/issues/27) | Put the jobId in the URL so a paid render survives a tab close or reload | `App.tsx`, `Wizard.tsx:281` |
| **P2.7** · [#28](https://github.com/frankbria/hypnosis-studio/issues/28) | Send a delivery email when a job reaches `ready` *(blocked by P2.3, P2.6)* | `server.js` |
| **P2.8** · [#29](https://github.com/frankbria/hypnosis-studio/issues/29) | Replace the demo-mode fallback with a real error state on any server error *(blocked by P2.2)* | `Wizard.tsx:276-280` |
| **P2.9** · [#30](https://github.com/frankbria/hypnosis-studio/issues/30) | Branch the "Nothing was charged" copy on actual payment state *(blocked by P2.5)* | `Wizard.tsx:210-217` |

## Phase P3 — Security & operational hardening

*Can run in parallel with P2 by a second developer; none of it blocks taking a first payment, but all
of it should land before meaningful traffic.*

| ID | Issue | Files |
|---|---|---|
| **P3.1** · [#31](https://github.com/frankbria/hypnosis-studio/issues/31) | Rate-limit the render/checkout endpoint per IP | `server.js:186-204` |
| **P3.2** · [#32](https://github.com/frankbria/hypnosis-studio/issues/32) | Rotate `ACCESS_CODE` and scrub it (and the key path) from `DEPLOYMENT.md` | `DEPLOYMENT.md:63` |
| **P3.3** · [#33](https://github.com/frankbria/hypnosis-studio/issues/33) | Widen job IDs to 16 random bytes (one character; old IDs stay valid) | `server.js:195` |
| **P3.4** · [#34](https://github.com/frankbria/hypnosis-studio/issues/34) | Constant-time access-code comparison | `server.js:189` |
| **P3.5** · [#35](https://github.com/frankbria/hypnosis-studio/issues/35) | Add security headers (CSP, nosniff, frame-ancestors, Referrer-Policy) | `server.js:43-46` |
| **P3.6** · [#36](https://github.com/frankbria/hypnosis-studio/issues/36) | Fix the `startsWith(DIST)` sibling-prefix gap (`DIST + path.sep`) | `server.js:157` |
| **P3.7** · [#37](https://github.com/frankbria/hypnosis-studio/issues/37) | Pin deploy actions to commit SHAs; add a `permissions:` block | `deploy.yml:26,35` |
| **P3.8** · [#38](https://github.com/frankbria/hypnosis-studio/issues/38) | Remove the unused `react-router` dependency (high CVE) and run `npm audit fix` | `web/package.json:51` |
| **P3.9** · [#39](https://github.com/frankbria/hypnosis-studio/issues/39) | Graceful SIGTERM shutdown so in-flight downloads drain | `server.js:283` |
| **P3.10** · [#40](https://github.com/frankbria/hypnosis-studio/issues/40) | External uptime monitoring on `/api/health` + a disk-usage alert | infra |
| **P3.11** · [#41](https://github.com/frankbria/hypnosis-studio/issues/41) | Error tracking for the Node process and the browser | `server.js`, `web/src` |
| **P3.12** · [#42](https://github.com/frankbria/hypnosis-studio/issues/42) | Off-box backup of `renders/` masters and `engine/api.env` | infra |
| **P3.13** · [#43](https://github.com/frankbria/hypnosis-studio/issues/43) | Commit the systemd unit; set `Restart=` and `MemoryMax=` | new `deploy/` |
| **P3.14** · [#44](https://github.com/frankbria/hypnosis-studio/issues/44) | Gate deploy on build + typecheck + lint; add a rollback path *(blocked by P0.4)* | `deploy.yml` |
| **P3.15** · [#45](https://github.com/frankbria/hypnosis-studio/issues/45) | Return generic errors to the client; keep server paths in `worker.log` | `server.js:246` |
| **P3.16** · [#57](https://github.com/frankbria/hypnosis-studio/issues/57) | Move mastered audio to object storage (Cloudflare R2) and serve via signed URLs *(blocked by P0.2, P0.3)* | `server.js:14,230-238` |

## Phase P4 — Quality, tests & polish

*Post-launch fast-follow. Nothing here blocks revenue, but P4.1 and P4.2 protect the code paths where
money is actually lost.*

| ID | Issue | Files |
|---|---|---|
| **P4.1** · [#46](https://github.com/frankbria/hypnosis-studio/issues/46) | Extract `build_timeline()` from module scope and test it over all 20 scripts | `assemble_track.py:32-171`, new test |
| **P4.2** · [#47](https://github.com/frankbria/hypnosis-studio/issues/47) | Unit-test `tts()` retry behaviour against a stubbed `urlopen` *(blocked by P0.7)* | new test |
| **P4.3** · [#48](https://github.com/frankbria/hypnosis-studio/issues/48) | Fix `DEPLOYMENT.md` drift: 780 s not 900 s, 152–159 segments not 131, 17–22k chars not 16k | `DEPLOYMENT.md:59-62` |
| **P4.4** · [#49](https://github.com/frankbria/hypnosis-studio/issues/49) | Fix `engine/README.md` claims about `.env.local` and the whisper-transcript step | `engine/README.md:15,28` |
| **P4.5** · [#50](https://github.com/frankbria/hypnosis-studio/issues/50) | Remove the unreachable custom-goal plumbing | `Wizard.tsx:504-517` |
| **P4.6** · [#51](https://github.com/frankbria/hypnosis-studio/issues/51) | Replace full-array RMS temporaries with BLAS `dot` (~700 MB off peak) | `assemble_track.py:110,201,202,208` |
| **P4.7** · [#52](https://github.com/frankbria/hypnosis-studio/issues/52) | Drop the 76 s of per-job `time.sleep(0.5)` | `render_program.py:244` |
| **P4.8** · [#53](https://github.com/frankbria/hypnosis-studio/issues/53) | Return a real 413 instead of a TCP reset on oversized bodies | `server.js:52-58` |
| **P4.9** · [#54](https://github.com/frankbria/hypnosis-studio/issues/54) | Accessibility: `div role="button"` → real `<button>`, focus management between steps | `Wizard.tsx:534-544` |
| **P4.10** · [#55](https://github.com/frankbria/hypnosis-studio/issues/55) | Cookieless funnel analytics | `web/src` |

---

## Decisions taken (2026-08-09)

1. **Retention window: 30 days.** Recorded on #3 (the sweep) and #21 (the on-site copy), and it also
   governs the delivery email (#28), the refund policy (#17) and the storage lifecycle rule (#57).
   Configurable via env, defaulting to 30.
2. **Subscription tiers: cut both.** #13 ships the single $39 one-time tier. See the unit economics
   below for why the $19/mo tier was a pricing defect and not merely unbuilt.
3. **Storage: move mastered audio off the shared box** — filed as #57, recommending Cloudflare R2 for
   its zero egress fees. Retention (#3) remains the immediate fix; #57 is the durable one.

## Unit economics

Measured demand is 17,015–22,201 characters per program (~19,400 average) across the five goals.

| | Per program |
|---|---|
| Revenue | $39.00 |
| Stripe fee (2.9% + $0.30) | −$1.43 |
| TTS at published API rate ($0.10/1k chars, v2/v3 family) | −$1.70 to −$2.22 |
| TTS if drawn from a Pro plan allocation (~$99 / 500k credits) | −$3.96 |
| Storage and egress (R2, 30-day retention) | ≈ −$0.01 |
| **Gross margin** | **~$33–36 (85–92%)** |

**The $39 price is comfortably profitable and needs no change.** Three things threaten profitability,
and all three are now tracked:

- **The daily cap does not bound spend (#56).** Credits are metered monthly; the cap is daily.
  `MAX_JOBS_PER_DAY=6` permits ~180 programs/month, which exhausts a Pro allocation in about four
  days. Past that, renders fail *after payment* and generate refunds.
- **The $19/mo tier undercut the product (#13).** "One new custom program each month" plus "cancel
  anytime" let a customer take the $39 deliverable for $19 and leave. Cutting it is a pricing fix,
  not only a truth-in-advertising one.
- **Failed renders cost real money (#26, and all of P0).** A refunded order still consumes the TTS
  credits and the Stripe fee is not returned — roughly $3–5 of pure loss per failure, before support
  time. Reliability work is margin work.

One deliberate non-change: switching from the v3 model family to Flash v2.5 would roughly halve TTS
cost, but voice quality *is* the product here. Not recommended.

## Still open

- **Which ElevenLabs plan to run.** #56 makes the budget explicit and the failure graceful, but the
  plan tier sets the real monthly ceiling: roughly 5 programs on Creator, 25 on Pro, 92 on Scale.
  Pick the tier that matches expected volume, then set the budget in #56 to match it.
