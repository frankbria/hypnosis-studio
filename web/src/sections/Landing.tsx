import {
  ArrowRight,
  AudioLines,
  Check,
  Clock,
  FileAudio,
  Info,
  PackageCheck,
  Target,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  DISCLAIMER,
  HOW_MADE,
  PERSONALIZED_POINTER,
  PRICING,
  SAFETY_WARNING,
  goalsForDoor,
  nameList,
  upcomingForDoor,
} from '@/lib/data'
import type { DoorId, TrackPhase } from '@/lib/data'
import GoalCardText from '@/components/GoalCardText'
import SiteFooter from '@/components/SiteFooter'

interface LandingProps {
  door: DoorId
  onStart: () => void
  onHome: () => void
  /** Client-side navigation, so the footer's policy links do not reload. */
  onNavigate: (path: string) => void
}

/**
 * The three steps, with the catalog size passed in rather than written down
 * (#67, #80).
 *
 * It used to be a const array saying "Six considered starting points". Six was
 * wrong three ways: five goals were named, only four were buyable, and the
 * sentence went on to promise "one sentence of your own — every script is
 * written around the change you name", which the engine does not do. Counts
 * that live in prose drift away from the catalog the moment the catalog moves,
 * so this takes the number from the same array the cards are rendered from.
 *
 * The old step three was titled "Receive your program", which frames the
 * purchase as waiting for something to be produced. It is a download.
 */
const howItWorks = (programCount: number) =>
  [
    {
      icon: Target,
      title: 'Choose your program',
      body: `${programCount} programs, each written for one outcome, revised, then locked. Every card names the situation it is for, so you can tell in a sentence whether it is yours.`,
    },
    {
      icon: AudioLines,
      title: 'Pick your voice',
      body: 'A narrator to guide you down, and a whisper layer beneath. Hear both before you commit.',
    },
    {
      icon: PackageCheck,
      title: 'Download your program',
      body: 'Four tracks mastered over an isochronic entrainment bed, ready in about twenty minutes. WAV + MP3, yours to keep.',
    },
  ] as const

const PROGRAM_ARC = [
  {
    numeral: 'I',
    phase: 'Foundation',
    body: 'The induction. Breath, descent, and the core metaphor your goal is built on.',
  },
  {
    numeral: 'II',
    phase: 'Deepening',
    body: 'The first deepening. The metaphor opens outward; the first suggestions take root.',
  },
  {
    numeral: 'III',
    phase: 'Mastery',
    body: 'The second deepening. The whisper layer carries the suggestions underneath the narration.',
  },
  {
    numeral: 'IV',
    phase: 'Integration',
    body: 'A short daytime anchor. Return to the state in minutes — eyes open, day resumed.',
  },
] as const satisfies ReadonlyArray<{
  numeral: string
  // Typed against the union so this list cannot drift from the engine the way
  // it just had: `as const` alone let 'Suggestion' sit here unnoticed while the
  // delivery screen said 'Mastery' (#15).
  phase: TrackPhase
  body: string
}>

function Waveform() {
  const bars = Array.from({ length: 64 }, (_, i) => {
    // Deterministic, organic-looking heights — no runtime randomness.
    const height = 14 + 62 * Math.abs(Math.sin(i * 1.35) * Math.cos(i * 0.55))
    return { height, delay: (i % 32) * 0.24 }
  })
  return (
    <div
      aria-hidden
      className="pointer-events-none mt-16 flex h-24 items-center justify-center gap-[3px]"
    >
      {bars.map((bar, i) => (
        <span
          key={i}
          className="wave-bar"
          style={{ height: `${bar.height}%`, animationDelay: `${bar.delay}s` }}
        />
      ))}
    </div>
  )
}

function Eyebrow({ children }: { children: string }) {
  return (
    <p className="text-xs uppercase tracking-[0.2em] text-white/40">{children}</p>
  )
}

function BrandButton({ onHome }: { onHome: () => void }) {
  return (
    <button
      type="button"
      onClick={onHome}
      className="text-sm font-medium tracking-[0.3em] text-white/90 transition-colors hover:text-white"
    >
      HYPNOSIS&nbsp;STUDIO
    </button>
  )
}


/**
 * The safety block, rendered by *both* doors.
 *
 * SAFETY_WARNING lives here rather than in each door because it was originally
 * added only to PerformanceLanding — healing renders a different component, so
 * the seizure warning silently did not exist on the healing door at all, which
 * is the door whose audience is most likely to have a relevant history. A
 * file-scoped test could not see that; a browser on /healing could.
 *
 * Anchoring it to the component both doors already render makes the divergence
 * structurally impossible instead of fixed once.
 */
/**
 * One sentence naming what is coming, in place of greyed-out cards (#66).
 *
 * Shared by both doors so neither can quietly go back to rendering dead cards,
 * and renders nothing when there is nothing to announce — a door with a
 * complete catalog should not carry an empty promise.
 */
function UpcomingLine({ door }: { door: DoorId }) {
  const upcoming = upcomingForDoor(door)
  if (upcoming.length === 0) return null
  return (
    <p className="mt-10 text-sm leading-relaxed text-white/55">
      {nameList(upcoming.map((g) => g.name))}{' '}
      {upcoming.length === 1 ? 'is' : 'are'} in production.
    </p>
  )
}

/**
 * The AI disclosure (#64), shared by both doors.
 *
 * Placed in a component both landings render rather than added to one of them,
 * because Landing.tsx holds two independent door components and adding a block
 * to the one you happen to have open is exactly how /healing shipped without a
 * seizure warning (#65).
 */
function HowMadeSection({ onNavigate }: { onNavigate?: (path: string) => void }) {
  return (
    <section id="how-made" className="scroll-mt-24 border-t border-white/5 px-6 py-24">
      <div className="mx-auto max-w-3xl">
        <Eyebrow>How these are made</Eyebrow>
        <h2 className="font-display mt-4 text-4xl leading-tight text-[#e8e6f0]">
          Nothing here is a secret.
        </h2>
        <dl className="mt-10 space-y-8">
          {HOW_MADE.map((item) => (
            <div key={item.heading}>
              <dt className="text-sm font-medium text-[#e0c894]">{item.heading}</dt>
              <dd className="mt-2 text-sm leading-relaxed text-white/60">{item.body}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-10 text-sm leading-relaxed text-white/60">
          {PERSONALIZED_POINTER}{' '}
          {/*
            The tiers live on the performance landing; the healing door has no
            #pricing section at all. Scrolling to an id that is not on the page
            is a link that silently does nothing — the same dead-link failure
            #18 exists to fix. So: scroll when the section is here, navigate
            when it is not.
          */}
          <a
            href="/performance#pricing"
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
                return
              const here = document.getElementById('pricing')
              if (here) {
                event.preventDefault()
                here.scrollIntoView({ behavior: 'smooth' })
              } else if (onNavigate) {
                event.preventDefault()
                onNavigate('/performance')
                // The link says "See the tiers", so landing at the top of the
                // performance page is the wrong destination. onNavigate is a
                // state change, so #pricing does not exist until React has
                // committed — scroll on the next frame, once it does.
                requestAnimationFrame(() =>
                  document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth' }),
                )
              }
            }}
            className="text-violet-300 underline underline-offset-2"
          >
            See the tiers
          </a>
          .
        </p>
      </div>
    </section>
  )
}

function DisclaimerSection() {
  return (
    <section id="disclaimer" className="scroll-mt-24 px-6 py-16">
      <div className="mx-auto max-w-3xl space-y-4">
        <p className="rounded-2xl border border-amber-200/25 bg-amber-100/[0.06] px-7 py-5 text-sm leading-relaxed text-white/75">
          {SAFETY_WARNING}
        </p>
        <div className="flex gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-7">
          <Info className="mt-0.5 size-4 shrink-0 text-[#d4b87f]/70" />
          <p className="text-xs leading-relaxed text-white/60">{DISCLAIMER}</p>
        </div>
      </div>
    </section>
  )
}

// ─── Performance door (the original catalog) ─────────────────────────────────

function PerformanceLanding({ onStart, onHome, onNavigate }: Omit<LandingProps, 'door'>) {
  const goals = goalsForDoor('performance')
  return (
    <div id="top" className="animate-fade-in">
      {/* ── Nav ─────────────────────────────────────────── */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/5 bg-[#0b0b12]/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <BrandButton onHome={onHome} />
          <nav className="hidden items-center gap-8 text-sm text-white/50 md:flex">
            <a href="#how" className="transition-colors hover:text-white/90">
              How it works
            </a>
            <a href="#programs" className="transition-colors hover:text-white/90">
              Programs
            </a>
            <a href="#pricing" className="transition-colors hover:text-white/90">
              Pricing
            </a>
          </nav>
          <Button
            size="sm"
            onClick={onStart}
            className="bg-primary text-primary-foreground hover:bg-violet-300"
          >
            Create your program
          </Button>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────── */}
      <section className="relative overflow-hidden px-6 pb-20 pt-40">
        <div
          aria-hidden
          className="animate-glow absolute left-1/2 top-24 -z-10 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-violet-500/10 blur-3xl"
        />
        <div className="mx-auto max-w-3xl text-center">
          <Eyebrow>Performance · self-hypnosis programs</Eyebrow>
          <h1 className="font-display mt-6 text-5xl leading-[1.08] text-[#e8e6f0] md:text-7xl">
            A four-track self-hypnosis program, built for{' '}
            <em className="text-violet-300">one outcome.</em>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-white/55 md:text-lg">
            Written for a single goal, revised, then locked — the same four
            tracks every listener gets. Two AI voices render from that one
            script and land in exact time with each other: a narrator to follow,
            a whisper underneath. Ready in about twenty minutes.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button
              size="lg"
              onClick={onStart}
              className="bg-primary text-primary-foreground hover:bg-violet-300"
            >
              Create your program
              <ArrowRight className="size-4" />
            </Button>
            <Button
              size="lg"
              variant="ghost"
              asChild
              className="text-white/60 hover:bg-white/5 hover:text-white"
            >
              <a href="#how">How it works</a>
            </Button>
          </div>
          <Waveform />
        </div>
      </section>

      {/* ── How it works ────────────────────────────────── */}
      <section id="how" className="scroll-mt-24 px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <Eyebrow>How it works</Eyebrow>
          <h2 className="font-display mt-4 max-w-xl text-4xl leading-tight text-[#e8e6f0]">
            Getting started.
          </h2>
          <div className="mt-12 grid gap-4 md:grid-cols-3">
            {howItWorks(goals.length).map((step, i) => (
              <Card
                key={step.title}
                className="rounded-2xl border-white/10 bg-white/5 shadow-none"
              >
                <CardContent className="p-8">
                  <div className="flex items-center justify-between">
                    <step.icon className="size-5 text-violet-300" />
                    <span className="font-display text-sm italic text-[#d4b87f]">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                  </div>
                  <h3 className="mt-6 text-lg font-medium text-white/90">
                    {step.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-white/50">
                    {step.body}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ── The program ─────────────────────────────────── */}
      <section id="programs" className="scroll-mt-24 px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <Eyebrow>The program</Eyebrow>
              <h2 className="font-display mt-4 max-w-xl text-4xl leading-tight text-[#e8e6f0]">
                Four tracks, one arc — descent, deepening, return.
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className="gap-1.5 rounded-full border-white/15 px-3 py-1 text-xs font-normal text-white/55"
              >
                <Clock className="size-3" /> 13–15 min per track
              </Badge>
              <Badge
                variant="outline"
                className="gap-1.5 rounded-full border-white/15 px-3 py-1 text-xs font-normal text-white/55"
              >
                <FileAudio className="size-3" /> WAV + MP3
              </Badge>
            </div>
          </div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PROGRAM_ARC.map((track) => (
              <Card
                key={track.numeral}
                className="rounded-2xl border-white/10 bg-white/5 shadow-none"
              >
                <CardContent className="p-7">
                  <p className="font-display text-3xl italic text-violet-300/80">
                    {track.numeral}
                  </p>
                  <h3 className="mt-4 text-sm font-medium uppercase tracking-[0.15em] text-white/85">
                    {track.phase}
                  </h3>
                  <p className="mt-3 text-sm leading-relaxed text-white/50">
                    {track.body}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Goal gallery */}
          <div className="mt-24">
            <Eyebrow>Performance goals</Eyebrow>
            <h2 className="font-display mt-4 max-w-xl text-4xl leading-tight text-[#e8e6f0]">
              {goals.length} programs. Each built for one outcome.
            </h2>
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {goals.map((goal) => (
                <Card
                  key={goal.id}
                  className="group rounded-2xl border-white/10 bg-white/5 shadow-none transition-colors hover:border-violet-300/30"
                >
                  <CardContent className="p-7">
                    <goal.icon className="size-5 text-violet-300 transition-colors group-hover:text-[#d4b87f]" />
                    <GoalCardText goal={goal} />
                  </CardContent>
                </Card>
              ))}
            </div>
            <UpcomingLine door="performance" />
          </div>
        </div>
      </section>

      {/* ── Pricing ─────────────────────────────────────── */}
      <section id="pricing" className="scroll-mt-24 px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <div className="text-center">
            <Eyebrow>Pricing</Eyebrow>
            <h2 className="font-display mx-auto mt-4 max-w-xl text-4xl leading-tight text-[#e8e6f0]">
              One payment. No subscription.
            </h2>
          </div>
          <p className="mx-auto mt-8 max-w-2xl rounded-lg border border-amber-200/25 bg-amber-100/[0.06] px-5 py-3.5 text-center text-sm leading-relaxed text-white/75">
            {SAFETY_WARNING}
          </p>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {PRICING.map((tier) => (
              <Card
                key={tier.name}
                className={
                  tier.highlighted
                    ? 'relative rounded-2xl border-violet-300/50 bg-violet-300/[0.07] shadow-none'
                    : 'relative rounded-2xl border-white/10 bg-white/5 shadow-none'
                }
              >
                {tier.badge && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full border border-violet-300/40 bg-[#14121f] px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-violet-200">
                    {tier.badge}
                  </span>
                )}
                <CardContent className="p-8">
                  <h3 className="text-sm font-medium uppercase tracking-[0.15em] text-white/70">
                    {tier.name}
                  </h3>
                  <p className="mt-4 flex items-baseline gap-2">
                    <span className="font-display text-5xl text-[#e8e6f0]">
                      {tier.price}
                    </span>
                    <span className="text-sm text-white/40">{tier.cadence}</span>
                  </p>
                  <ul className="mt-7 space-y-3">
                    {tier.features.map((feature) => (
                      <li
                        key={feature}
                        className="flex items-start gap-2.5 text-sm text-white/60"
                      >
                        <Check className="mt-0.5 size-4 shrink-0 text-[#d4b87f]" />
                        {feature}
                      </li>
                    ))}
                  </ul>
                  {tier.available ? (
                    <Button
                      onClick={onStart}
                      variant={tier.highlighted ? 'default' : 'outline'}
                      className={
                        tier.highlighted
                          ? 'mt-8 w-full bg-primary text-primary-foreground hover:bg-violet-300'
                          : 'mt-8 w-full border-white/15 bg-transparent text-white/80 hover:border-violet-300/40 hover:bg-violet-300/10 hover:text-white'
                      }
                    >
                      {tier.cta}
                    </Button>
                  ) : (
                    /* Deliberately not a button. A control that looks clickable
                       and does nothing is worse than none, and a payment CTA
                       here would sell something the studio cannot deliver on the
                       day of sale. */
                    <p className="mt-8 w-full rounded-md border border-white/10 px-4 py-2.5 text-center text-sm text-white/45">
                      {tier.cta}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <HowMadeSection onNavigate={onNavigate} />
      <DisclaimerSection />
      <SiteFooter onHome={onHome} onNavigate={onNavigate} />
    </div>
  )
}

// ─── Healing door (mind-body rest visualizations — non-medical) ──────────────

function HealingLanding({ onStart, onHome, onNavigate }: Omit<LandingProps, 'door'>) {
  const goals = goalsForDoor('healing')
  return (
    <div id="top" className="animate-fade-in">
      {/* ── Nav ─────────────────────────────────────────── */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/5 bg-[#0b0b12]/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <BrandButton onHome={onHome} />
          <nav className="hidden items-center gap-8 text-sm text-white/50 md:flex">
            <a
              href="#practices"
              className="transition-colors hover:text-white/90"
            >
              Practices
            </a>
            <a
              href="#disclaimer"
              className="transition-colors hover:text-white/90"
            >
              Disclaimer
            </a>
          </nav>
          <Button
            size="sm"
            onClick={onStart}
            className="bg-primary text-primary-foreground hover:bg-violet-300"
          >
            Begin a practice
          </Button>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────── */}
      <section className="relative overflow-hidden px-6 pb-20 pt-40">
        <div
          aria-hidden
          className="animate-glow absolute left-1/2 top-24 -z-10 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-violet-500/10 blur-3xl"
        />
        <div className="mx-auto max-w-3xl text-center">
          <Eyebrow>Healing · guided imagery &amp; deep relaxation</Eyebrow>
          <h1 className="font-display mt-6 text-5xl leading-[1.08] text-[#e8e6f0] md:text-7xl">
            Healing — deep rest for a body that knows how to{' '}
            <em className="text-violet-300">repair itself.</em>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-white/55 md:text-lg">
            Guided imagery practices in the tradition of therapeutic
            visualization: deep relaxation, symbolic repair imagery, and a
            rehearsal of wellness. These audios are for rest and personal
            growth — they are not medical treatment, and they never replace the
            care of your doctors.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button
              size="lg"
              onClick={onStart}
              className="bg-primary text-primary-foreground hover:bg-violet-300"
            >
              Begin a practice
              <ArrowRight className="size-4" />
            </Button>
            <Button
              size="lg"
              variant="ghost"
              asChild
              className="text-white/60 hover:bg-white/5 hover:text-white"
            >
              <a href="#practices">See the practices</a>
            </Button>
          </div>
          <Waveform />
        </div>
      </section>

      {/* ── Practices ───────────────────────────────────── */}
      <section id="practices" className="scroll-mt-24 px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <Eyebrow>Healing practices</Eyebrow>
          <h2 className="font-display mt-4 max-w-xl text-4xl leading-tight text-[#e8e6f0]">
            Practices for rest and renewal.
          </h2>
          <p className="mt-4 max-w-xl text-sm leading-relaxed text-white/50">
            Every practice is a four-track program — induction, deepening,
            suggestion, integration — in the voice set you choose.
          </p>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {goals.map((goal) => (
              <Card
                key={goal.id}
                className="group rounded-2xl border-white/10 bg-white/5 shadow-none transition-colors hover:border-violet-300/30"
              >
                <CardContent className="p-7">
                  <goal.icon className="size-5 text-violet-300 transition-colors group-hover:text-[#d4b87f]" />
                  <GoalCardText goal={goal} />
                </CardContent>
              </Card>
            ))}
          </div>
          <UpcomingLine door="healing" />
        </div>
      </section>

      <HowMadeSection onNavigate={onNavigate} />
      <DisclaimerSection />
      <SiteFooter onHome={onHome} onNavigate={onNavigate} />
    </div>
  )
}

export default function Landing({ door, onStart, onHome, onNavigate }: LandingProps) {
  if (door === 'healing') {
    return <HealingLanding onStart={onStart} onHome={onHome} onNavigate={onNavigate} />
  }
  return <PerformanceLanding onStart={onStart} onHome={onHome} onNavigate={onNavigate} />
}
