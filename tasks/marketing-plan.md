# Hypnosis Studio — Marketing & Business Model Plan

**Date:** 2026-08-09 · **Commit:** `2a426af`
**Method:** four parallel specialist reviews (tier architecture, positioning/copy, funnel/conversion,
personalized-tier design), plus direct measurement of the script corpus by the lead. Human reviewer
feedback in `website_feedback.md` was an input throughout.

**Companion document:** `tasks/todo.md` — the engineering launch-readiness plan (issues #1–#57).
This plan changes which of those are launch-blocking. See §7. Issues #58–#82 were filed by this review.

**Inputs:** `website_feedback.md` — Greg's review of the live site. Coverage map in §7b.

---

## 1. The reframe

The previous review made a framing error worth naming, because it shaped everything downstream: it
treated the code as ground truth and the marketing copy as a defect against it. So where the site
sold three tiers and the code had one, it concluded "delete two tiers."

That inverts the real relationship. **The copy was the intent; the code is what is behind.** Three
tiers is the business model. The correct response is to define and build them.

The site currently sells **a machine** — "Create your program", "Generate my program", "Give the
studio a moment." It now has to sell **a shelf of finished programs, plus a machine you can pay more
to point at your own goal.** Nearly every confusing item your human reviewer flagged is a symptom of
that one mismatch. Someone told a program will be *made for them* reasonably asks where they say what
they want, and reasonably cannot tell whether "The Polymath Mind" is a theme, a method, or an outcome.

## 2. The decisive technical fact

**Every render is a pure function of `(goal, voiceSet)`.** `server.js:186-204` accepts only those two
fields; the `custom` free-text field is parsed and never used. Five goals × two voice sets =
**10 possible outputs, total.**

The system currently renders one of those ten on demand, per customer, at ~$2 of TTS and 15–20
minutes of wall clock. **Pre-rendering all ten once costs ~$20 and makes delivery instant.**

This is the highest-leverage decision available, and it is not primarily a cost decision:

- Delivery becomes **instant** — a genuine selling point replacing "this takes ~15-20 minutes."
- The tier carrying nearly all launch volume **never touches the render pipeline**, so the queue, the
  worker, retries, OOM risk, and the QA gate stop being launch-blocking.
- `renders/` stops growing at ~3 GB/day and becomes a fixed ~3 GB.
- Marginal cost per catalog sale falls to the Stripe fee alone.

The render pipeline stops being customer-facing runtime and becomes **a studio tool you run to
produce masters.** It remains fully load-bearing for the personalized tier.

## 3. Tier architecture

| Tier | Price | What they get | Fulfilment cost | Margin |
|---|---|---|---|---|
| **Program** | $39 one-time | One catalog title, choice of voice set, pre-rendered, **instant download**, 30-day access | ~$1.43 (Stripe; TTS sunk in the ~$20 one-time pre-render) | **96%** |
| **Personalized Program** ← intended conversion | $129 one-time | AI intake elicits your goal → AI-authored script → rendered on the 4-track engine, ~20 min, 30-day access | ~$6.24–7.26 (TTS $1.70–2.22 + generation ~$0.50–1.50 + Stripe $4.04) | **~95%** |
| **The Complete Studio** | $649 one-time | Every catalog title live at purchase + **two** personalized programs, both voice sets, 30-day access | ~$32 | **~95%** |

**No subscription at launch.** Re-listening to files you already own is not recurring value; the only
genuine recurring value in a catalog business is new titles arriving on a cadence. At five live titles
a subscriber exhausts the catalog in a day. The bar to revisit: **12–15 titles and a proven ≥1/month
cadence sustained for a quarter.** This is a real trade-off — it means no recurring revenue at launch
— and should be an explicit choice rather than a default.

### Two conflicts between reviewers, resolved

1. **Anchor composition.** The tier reviewer specified five personalized programs, making the anchor
   a deliberate 78% premium over the $840 piecemeal cost — genuinely bad value, so nobody picks it.
   The copy reviewer independently rewrote it as *twelve* programs ($1,548 face value for $1,499),
   turning the decoy into a 3% discount and committing ~4 hours of serial render time per sale.
   **Resolved: the anchor must cost more than its parts.** Superseded by the $649 decision below,
   which settles the final count at **two** programs.
2. **Retention.** The copy reviewer's pricing block reintroduced "lifetime download access" on the
   anchor. **Resolved: 30 days on all tiers**, per the settled decision (#3, #21).

### The anchor — resolved at $649 (2026-08-09)

Both the funnel and copy reviewers independently flagged that $1,499 at 11.6× the target tier read as
unserious and risked leaking backwards onto the credibility of the real prices. **The owner chose
$649.**

**The contents had to move with the price, or the tier inverts.** At $1,499 it held five personalized
programs plus the catalog — $840 piecemeal — a deliberate 78% premium nobody would rationally pick. At
$649 those same contents become a **23% discount**: five personalized programs alone are worth $645, so
a buyer would get all five *plus* the full catalog for roughly the price of the programs. Best deal on
the page, opposite of an anchor, and ~100 minutes of serial rendering per sale.

Final: **$649 for the full catalog ($195) plus two personalized programs ($258)** — $453 piecemeal, so a
**43% premium**, anchor property preserved. Fulfilment ~$32, two serial renders (~40 min), delivered
incrementally.

Ladder: **$39 → $129 → $649**, steps of 3.3× then 5.0×.

### "Healing" stays (2026-08-09)

The copy review recommended renaming the Healing door to "Rest & Renewal", on the grounds that the name
promises a therapeutic outcome the body copy then spends three sentences retracting.

**Decision: keep "Healing."** In the wellness vernacular — Reiki healing, sound bath healing, energy
healing — "healing" names a *category*, not a clinical claim, and it is what people actually search for
and recognise. Swapping it would trade findability for a problem that is not really there. The
disclaimer does the legal work; the door name does the findability work.

The non-medical stance in the body copy stays exactly as written, and #65 still gives the seizure
warning its own line.

## 4. Positioning

**Curated and AI are both true, and they occupy different slots.** They only fight if you let them
share one.

- **Curation is a claim about the script.** Not "hand-written" — that invites a challenge you would
  lose. The defensible claim is **fixed**: written for one outcome, revised, then locked. The same
  program every listener gets. That is what separates the catalog from the $129 tier.
- **AI is a claim about the voices and the premium tier.** Disclosed plainly, led with capability
  rather than apology.

The formulation that avoids both failure modes ("hand-crafted by our writers" — dishonest; "AI-generated
hypnosis" — leads with the commodity) is **AI as the enabling condition for something otherwise
impossible**: two synthetic voices can be rendered from one script in two registers and land in exact
time with each other. Two human performers would drift, and drift is audible when one voice runs
underneath the other. That is a true and specific argument for why the whisper layer exists at all.

**Four claims that beat free audio, all literally true:** it is a course rather than a track (four
sessions that build, with Track IV as a short daytime anchor); two voices at once; an engineered
isochronic bed notched so it does not fight the narrator; and one job per program.

**Never claim:** efficacy, studies, percentages, testimonials, before/after. The current copy is clean
on this and that restraint is an asset in this category.

### The naming problem is typographic as much as editorial

Each goal card leads with a metaphor in 40px display type, and the only legible token — "Focus and
follow-through" — is set at 12px, 35% opacity (`Landing.tsx:306-314`). All five titles also share one
grammar (*The [Adjective] [Noun]*), so they read as a set of themes rather than a set of products.

Fix: promote a plain **outcome label** into the gold where the tagline sits, keep the evocative name in
display type below it, and add a **"Choose this if…"** line naming the reader's actual situation. All
existing names survive; they simply stop having to do the classifying work.

## 5. Funnel

Three purchase paths, not one wizard.

**Program $39** — collapses almost entirely. Catalog → program page (sample as hero, voice radio,
consent, buy) → Stripe → delivery page. No stepper, no polling, no "Generating" step.

**Personalized $129** — intake (5 questions) → reflection screen with voice choice and price → Stripe
→ standalone render-status route → same URL becomes the download page.

**The Complete Studio $649** — same intake, then post-payment configuration, then two jobs
**queued serially and delivered incrementally**. `anyJobRendering()` (`server.js:83`) forces one render
at a time, so two programs is ~40 minutes; a $649 customer watching a blank bar that long is a
chargeback.

**Intake goes before payment.** The questions are not the asset — any model writes similar ones. The
asset is the script, and that stays behind the paywall. Post-payment intake would ask $129 on a pure
promise while the $39 tier has a sample, and it creates the worst possible support state: paid, no goal
captured, no job started, no automatic way out. The guard is a **reflection screen** — three bullets in
the customer's own language naming what the program will address — which also functions as a commitment
device immediately before the price. Never show script fragments pre-payment.

**Five questions, hard cap seven.** Four multiple-choice, one free-text, one per screen. Question 1 must
be a card tap, never a text box — first-question friction predicts completion better than total length.
Build it as a static branching questionnaire with **one** LLM call at the end for the reflection, not a
live multi-turn chat: a chat adds latency mid-funnel, creates an anonymous LLM endpoint to abuse, and
can wander off-goal.

**The door chooser should be demoted from gate to section.** It gives a cold visitor no product, no
price, and no audio before demanding an identity choice — and it routes half of all traffic to the
Healing landing, which has exactly **one** buyable program (`river`) beside two greyed-out cards. Keep
`/performance` and `/healing` as real routes for paid traffic and SEO; stop making the fork mandatory.

**The sample gap is the single biggest conversion leak.** There is no way to hear a program before
buying — only four short solo voice clips. Worse, the whisper layer is previewed **solo**, which is the
most uncanny configuration synthetic audio can be in, and it is the only way to hear your differentiator
before paying. Pre-rendering makes the fix nearly free: cut ~2 minutes of the real mix (~60 s from Track
I plus ~45 s from Track III, where the whisper layer is audible) into ten files with ffmpeg.

> **Correction to the funnel review:** it argued Track I is generic across programs and should be
> skipped. I tested this — polymath and river share **zero identical segments in any phase**. Each
> induction is bespoke to its metaphor. Sample both tracks; the reason to include Track III is the
> whisper layer, not the sameness of Track I.

## 6. Personalized tier — design

*Written by the lead; the assigned reviewer did not deliver.*

### Measured corpus

| Phase | Segments | Chars | Share | Required? |
|---|---|---|---|---|
| suggestion | 439 | 41,105 | 47.4% | **yes** |
| induction | 72 | 12,425 | 14.3% | **yes** |
| resurface | 135 | 12,096 | 13.9% | **yes** |
| deepening | 67 | 11,130 | 12.8% | **yes** |
| pain_frame | 20 | 4,688 | 5.4% | optional |
| disclaimer | 20 | 3,906 | 4.5% | optional |
| permission | 15 | 1,436 | 1.7% | optional |

Two valid phase orders exist (`permission` is absent from 5 of 20 scripts). Per program: 152–159
segments, 15,039–20,225 characters. `resurface` is *exactly* 27 segments in every goal; induction sits
at 14–15, deepening at 13–14. The architecture is a fixed template — a generator has a firm target.

But the **text** is bespoke per goal: polymath and river share zero identical segments. The metaphor is
woven through every phase, not only the suggestions.

### The central fork — recommendation: generate all phases

Generating only the suggestion phase against fixed inductions is cheaper and has a smaller safety
surface, but it discards exactly what makes these good — the metaphoric cohesion that carries an image
from induction through to resurface. A generic induction bolted to custom suggestions produces the
seam a listener notices. At ~$0.50–1.50 of generation against $129 of revenue, cost is not the
constraint; **quality and safety are**, and safety is better handled by an explicit gate (below) than
by restricting what gets written.

### Structural contract a generated script must satisfy

Derived from `assemble_track.py`:

1. **All four of induction / deepening / suggestion / resurface must be present.** `bounds()` at
   `:64-66` does `rows[0][1], rows[-1][2]` and raises `IndexError` on a missing phase.
2. **Each phase must be contiguous.** `bounds()` uses first and last occurrence, so a scattered phase
   produces overlapping ranges and non-monotonic breakpoints — which `np.interp` accepts silently and
   turns into a garbage gain envelope. No error, just bad audio.
3. **Timeline breakpoints must stay strictly increasing** (`GAIN_BP` at `:123-133`): deepening must
   span more than 8 s, resurface more than 25 s.
4. **`voice_end ≤ 885 s`**, since `ACTUAL_S = max(TOTAL_S, voice_end + 75)` must fit the fixed 960 s
   pad (`:91-96`). A generator writing 10% long fails at assembly — *after* the TTS spend.
5. Every segment needs `id`, `phase`, `pause_after_s`, `text`. Suggestion-phase pauses are **doubled**
   at `:60`, so they cost double against the duration budget.

### Safety and refusal

This is hypnotic suggestion delivered to a listener in a suggestible state, on a site with a Healing
door. **This is the highest-risk surface in the product** and the gate is non-negotiable.

Refuse outright, with a refund-free pre-payment rejection: medical or psychiatric claims (illness,
diagnosis, symptoms, medication, cure), weight and body composition, addiction and substance use,
self-harm and suicidality, sexual content, anything involving a third party's behaviour, minors, and
memory recovery. Route refusals to a human-readable explanation and suggest the nearest catalog title.

The gate sits **before payment** (so a refused intake costs nothing and refunds nothing) **and again
before TTS** (so a generated script that drifted is caught before credits are spent).

### Automated validation before a single TTS credit

A pure-function validator over the generated JSON: the structural contract above, plus an estimated
`voice_end` from character counts and pause budget, plus a second safety pass over the generated
suggestion text. Cheap, fast, no audio, no network. **This is also the highest-value test in the repo**
and shares its core with #46.

### The five intake questions

1. **What do you want to be different?** (card tap — six outcome cards mirroring the catalog, plus
   "something else")
2. **What does that look like on a good day?** (free text, 2–3 sentences — the only free-text field)
3. **What has been in the way?** (multiple choice)
4. **Which image settles you?** (multiple choice — water / landscape / architecture / light — this
   feeds the central metaphor and is what makes the script feel like it is about them)
5. **When will you listen?** (multiple choice — sets register and pacing)

Q4 is the one doing the most work for the least friction, and it is the reason to keep generation
across all phases rather than only the suggestions.

### Verdict: post-launch, not launch

The catalog tier can ship in weeks. This tier needs intake, generation, validation, a safety gate, and
the full P0 render-reliability backlog underneath it — because unlike the catalog, it renders on demand
and takes money first. **Ship the catalog, then this.**

## 7. What this changes in `tasks/todo.md`

Pre-rendering moves the following **off the launch critical path**. All remain required for the
personalized tier, and each has been annotated in GitHub rather than closed:

#4 (deploy kills in-flight render) · #6 (render QA gate) · #9 (cross-job segment cache) ·
#10 (quota slot on failure) · #11 (stale-sweep race) · #25 (credit preflight) · #26 (refund on render
failure) · #27 (job ID in URL) · #56 (monthly spend budget)

**Still launch-blocking regardless:** #1 (the unauthenticated crash), #3 (retention), #16/#17/#18
(legal pages, refund policy, contact), #22/#23/#24 (Stripe), #57 (object storage), and the P3 hardening
set.

**Newly launch-blocking:** the pre-render and static-delivery workstream (§8).

## 7b. Greg's feedback — coverage map

`website_feedback.md` is Greg's review of the live site. Every item is tracked:

| Greg's point | Issue |
|---|---|
| "tonight" → "today" / "right now" | [#61](https://github.com/frankbria/hypnosis-studio/issues/61) |
| Palette is only purple and black; needs warmth to feel safe acting | [#82](https://github.com/frankbria/hypnosis-studio/issues/82) |
| "Three quiet steps between you and the program" sounds like a roadblock | [#80](https://github.com/frankbria/hypnosis-studio/issues/80) |
| "Considered starting points" — unclear phrasing | [#62](https://github.com/frankbria/hypnosis-studio/issues/62) |
| "I'm lost at what these actually mean" — goals unreadable | [#62](https://github.com/frankbria/hypnosis-studio/issues/62) |
| "Where does the customer provide detail on what they want?" | [#61](https://github.com/frankbria/hypnosis-studio/issues/61) (claim removed), [#73](https://github.com/frankbria/hypnosis-studio/issues/73) (intake delivers it) |
| Create Program button assumes a one-time purchase | [#69](https://github.com/frankbria/hypnosis-studio/issues/69) |
| Monthly subscription and premium package incomprehensible | [#63](https://github.com/frankbria/hypnosis-studio/issues/63) |
| Two "in production" options on the $39 page need finishing | [#66](https://github.com/frankbria/hypnosis-studio/issues/66) |
| Terms and conditions / chargeback protection | [#16](https://github.com/frankbria/hypnosis-studio/issues/16), [#17](https://github.com/frankbria/hypnosis-studio/issues/17), [#18](https://github.com/frankbria/hypnosis-studio/issues/18) |
| Preview voices slow to load | [#81](https://github.com/frankbria/hypnosis-studio/issues/81) |
| No way to click Generate without an early-access code | [#23](https://github.com/frankbria/hypnosis-studio/issues/23) — Stripe replaces the gate |

Two of Greg's items turned out to be more serious than filed. The **preview latency** he logged as a nit
becomes the most expensive bug on the site once previews are the primary defence against the synthetic-voice
trust risk (§5). And **"where do I say what I want?"** was not a UX gap but the false personalization
promise at the centre of the old positioning — the thing that prompted this entire review.

## 8. New issues

Filed as a continuation of the existing `PX.Y` scheme.

**P0 — catalog delivery (new launch-critical path)**
- **P0.14** · [#58](https://github.com/frankbria/hypnosis-studio/issues/58) Pre-render the 10 catalog masters and commit a catalog manifest
- **P0.15** · [#59](https://github.com/frankbria/hypnosis-studio/issues/59) Serve catalog purchases as signed static URLs — no render at purchase
- **P0.16** · [#60](https://github.com/frankbria/hypnosis-studio/issues/60) Cut 2-minute mixed program samples (10 files)

**P1 — positioning & truth-in-advertising**
- **P1.10** · [#61](https://github.com/frankbria/hypnosis-studio/issues/61) Rewrite hero, meta and door copy; remove personalization claims from the main offer
- **P1.11** · [#62](https://github.com/frankbria/hypnosis-studio/issues/62) Add an outcome label and "Choose this if" line to every goal
- **P1.12** · [#63](https://github.com/frankbria/hypnosis-studio/issues/63) Rewrite the three pricing tiers
- **P1.13** · [#64](https://github.com/frankbria/hypnosis-studio/issues/64) Add the "How these are made" AI disclosure block
- **P1.14** · [#65](https://github.com/frankbria/hypnosis-studio/issues/65) Give the seizure warning its own line at full contrast
- **P1.15** · [#66](https://github.com/frankbria/hypnosis-studio/issues/66) Remove "In production" cards from purchase surfaces
- **P1.16** · [#67](https://github.com/frankbria/hypnosis-studio/issues/67) Fix the "six programs" count and the custom-script promise
- **P1.17** · [#80](https://github.com/frankbria/hypnosis-studio/issues/80) Rewrite How It Works — it counts obstacles and implies a wait *(Greg)*

**P2 — funnel & commerce**
- **P2.10** · [#68](https://github.com/frankbria/hypnosis-studio/issues/68) Replace the door-chooser gate with a catalog home page
- **P2.11** · [#69](https://github.com/frankbria/hypnosis-studio/issues/69) Plumb tier selection through to checkout
- **P2.12** · [#70](https://github.com/frankbria/hypnosis-studio/issues/70) Token delivery page with a resend link
- **P2.13** · [#71](https://github.com/frankbria/hypnosis-studio/issues/71) Move render status to a standalone route
- **P2.14** · [#72](https://github.com/frankbria/hypnosis-studio/issues/72) Fix the door-chooser double-navigation bug
- **P2.15** · [#81](https://github.com/frankbria/hypnosis-studio/issues/81) Fix voice-preview latency — now the primary trust mechanism *(Greg)*

**P5 — personalized tier (post-catalog launch)**
- **P5.1** · [#73](https://github.com/frankbria/hypnosis-studio/issues/73) Intake questionnaire
- **P5.2** · [#74](https://github.com/frankbria/hypnosis-studio/issues/74) Reflection generation
- **P5.3** · [#75](https://github.com/frankbria/hypnosis-studio/issues/75) Safety refusal policy and gate
- **P5.4** · [#76](https://github.com/frankbria/hypnosis-studio/issues/76) Script generation
- **P5.5** · [#77](https://github.com/frankbria/hypnosis-studio/issues/77) Structural validator
- **P5.6** · [#78](https://github.com/frankbria/hypnosis-studio/issues/78) Wire generated scripts into the render pipeline
- **P5.7** · [#79](https://github.com/frankbria/hypnosis-studio/issues/79) The Complete Studio anchor tier
