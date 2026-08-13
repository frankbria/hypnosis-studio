/**
 * The front door: a catalog, not a gate (#68).
 *
 * `/` used to ask a cold visitor to choose an identity — Performance or
 * Healing — before showing them anything. There was no product on that page, no
 * price, no proof and no audio; the closest thing to a description of what was
 * being sold was eight words at 12px and 40% opacity.
 *
 * Worse, the branches were wildly asymmetric: the Healing door has exactly one
 * buyable program, so the chooser routed roughly half of all cold traffic to
 * the weakest page on the site. And it hid the pricing ladder behind an
 * identity choice, which the anchor tier cannot survive — an anchor nobody sees
 * is not anchoring anything.
 *
 * The doors remain as real routes (`/performance`, `/healing`) for paid traffic
 * and SEO. They are simply no longer mandatory.
 */
import { ArrowRight, Brain, Check, Waves } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { AudioPreviewButton } from '@/components/AudioPreviewButton'
import GoalCardText from '@/components/GoalCardText'
import SiteFooter from '@/components/SiteFooter'
import { useAudioPreview } from '@/hooks/use-audio-preview'
import {
  DISCLAIMER,
  HEALING_NONMEDICAL,
  PRICING,
  SAFETY_WARNING,
  VOICE_SETS,
  goalsForDoor,
} from '@/lib/data'
import type { DoorId, Goal } from '@/lib/data'
import { cn } from '@/lib/utils'

/**
 * The samples a cold visitor can hear without choosing anything.
 *
 * NARRATOR voices only, deliberately. #60 is opening about the whisper layer
 * being previewed solo — unmixed, with no narrator over it and no bed
 * underneath, which is the most uncanny configuration synthetic audio can be
 * in. Putting that on the front page would make the conversion leak worse, not
 * better. These are honest samples of the voice that carries the program, and
 * #60's two-minute mixed program samples are what should replace them.
 */
const SAMPLE_VOICES = VOICE_SETS.map((v) => v.narrator)
const SAMPLE_CLIPS: readonly string[] = SAMPLE_VOICES.map((v) => v.src)

const SECTIONS: ReadonlyArray<{
  door: DoorId
  icon: typeof Brain
  title: string
  blurb: string
  note?: string
}> = [
  {
    door: 'performance',
    icon: Brain,
    title: 'Performance',
    blurb:
      'Programs for focus, follow-through and the way you work. Four tracks, written for one outcome and locked — the same program every listener gets.',
  },
  {
    door: 'healing',
    icon: Waves,
    title: 'Healing',
    blurb:
      'Guided imagery in the tradition of therapeutic visualization: deep relaxation, symbolic repair imagery, and a rehearsal of wellness.',
    note: HEALING_NONMEDICAL,
  },
]

export default function CatalogHome({
  onEnterDoor,
  onChooseProgram,
  onNavigate,
  onHome,
}: {
  onEnterDoor: (door: DoorId) => void
  /**
   * Buy a specific program. It carries the goal, not just a tier: this page has
   * no door, so "start the wizard" alone would have nowhere to start — and the
   * visitor has already chosen, so making them choose again on the next screen
   * would be the same forgetting #69 was about.
   */
  onChooseProgram: (goal: Goal) => void
  onNavigate: (path: string) => void
  onHome: () => void
}) {
  const audio = useAudioPreview(SAMPLE_CLIPS)

  return (
    <div id="top" className="animate-fade-in">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/5 bg-[#0b0b12]/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <button
            onClick={onHome}
            className="text-xs font-medium tracking-[0.3em] text-white/70 transition-colors hover:text-white"
          >
            HYPNOSIS&nbsp;STUDIO
          </button>
          <nav className="hidden items-center gap-8 text-sm text-white/50 md:flex">
            <a href="#catalog" className="transition-colors hover:text-white/90">
              Programs
            </a>
            <a href="#listen" className="transition-colors hover:text-white/90">
              Listen
            </a>
            <a href="#pricing" className="transition-colors hover:text-white/90">
              Pricing
            </a>
          </nav>
          {/* Browses, does not buy — the same rule as the door landings (#69). */}
          <Button
            asChild
            size="sm"
            className="bg-primary text-primary-foreground hover:bg-violet-300"
          >
            <a href="#catalog">See the programs</a>
          </Button>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────── */}
      <section className="relative overflow-hidden px-6 pb-16 pt-40">
        <div
          aria-hidden
          className="animate-glow absolute left-1/2 top-24 -z-10 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-violet-500/10 blur-3xl"
        />
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-white/40">
            Self-hypnosis programs
          </p>
          <h1 className="font-display mt-6 text-5xl leading-[1.08] text-[#e8e6f0] md:text-7xl">
            Four-track self-hypnosis programs, each built for{' '}
            <em className="text-violet-300">one outcome.</em>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-white/55 md:text-lg">
            Written for a single goal, revised, then locked. Two AI voices render
            from that one script and land in exact time with each other: a
            narrator to follow, a whisper underneath. Ready in about twenty
            minutes.
          </p>
        </div>
      </section>

      {/* ── Listen ──────────────────────────────────────── */}
      <section id="listen" className="scroll-mt-24 px-6 pb-16">
        <div className="mx-auto max-w-3xl">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-8">
            <h2 className="font-display text-2xl text-[#e8e6f0]">
              Hear a voice before you decide.
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-white/50">
              Every program is narrated by one of these. Nothing to choose first
              — press play.
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              {SAMPLE_VOICES.map((voice) => (
                <div
                  key={voice.src}
                  className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
                >
                  <div>
                    <p className="text-sm text-white/85">{voice.name}</p>
                    <p className="text-xs text-white/45">
                      {voice.description} · {voice.role}
                    </p>
                  </div>
                  <AudioPreviewButton
                    src={voice.src}
                    playingSrc={audio.playingSrc}
                    pendingSrc={audio.pendingSrc}
                    onToggle={audio.toggle}
                    label={`${voice.name}, ${voice.role}`}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── The catalog ─────────────────────────────────── */}
      <section id="catalog" className="scroll-mt-24 px-6 py-16">
        <div className="mx-auto max-w-6xl">
          {SECTIONS.map((section) => {
            const goals: Goal[] = goalsForDoor(section.door)
            return (
              <div key={section.door} className="mb-20 last:mb-0">
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-3">
                      <section.icon className="size-5 text-violet-300" />
                      <h2 className="font-display text-3xl text-[#e8e6f0]">
                        {section.title}
                      </h2>
                      <Badge
                        variant="outline"
                        className="rounded-full border-white/15 px-3 py-1 text-[10px] font-normal uppercase tracking-[0.2em] text-white/50"
                      >
                        {goals.length} {goals.length === 1 ? 'program' : 'programs'}
                      </Badge>
                    </div>
                    <p className="mt-4 max-w-2xl text-sm leading-relaxed text-white/50">
                      {section.blurb}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => onEnterDoor(section.door)}
                    className="border-white/15 bg-transparent text-white/75 hover:border-violet-300/40 hover:bg-violet-300/10 hover:text-white"
                  >
                    More about {section.title}
                    <ArrowRight className="size-4" />
                  </Button>
                </div>

                {section.note && (
                  <p className="mt-5 max-w-2xl text-sm leading-relaxed text-white/60">
                    {section.note}
                  </p>
                )}

                <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {goals.map((goal) => (
                    <Card
                      key={goal.id}
                      className="rounded-2xl border-white/10 bg-white/5 shadow-none transition-colors hover:border-violet-300/30"
                    >
                      <CardContent className="flex h-full flex-col p-7">
                        <GoalCardText goal={goal} />
                        <Button
                          onClick={() => onChooseProgram(goal)}
                          className="mt-6 w-full bg-primary text-primary-foreground hover:bg-violet-300"
                        >
                          Choose this program
                        </Button>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* ── Pricing ─────────────────────────────────────── */}
      <section id="pricing" className="scroll-mt-24 border-t border-white/5 px-6 py-20">
        <div className="mx-auto max-w-5xl">
          <div className="text-center">
            <p className="text-xs uppercase tracking-[0.2em] text-white/40">Pricing</p>
            <h2 className="font-display mt-4 text-4xl text-[#e8e6f0]">
              One payment, per program.
            </h2>
          </div>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {PRICING.map((tier) => (
              <Card
                key={tier.id}
                className={cn(
                  'rounded-2xl border-white/10 bg-white/5 shadow-none',
                  tier.highlighted && 'border-violet-300/40 bg-violet-300/5',
                )}
              >
                <CardContent className="flex h-full flex-col p-8">
                  {tier.badge && (
                    <Badge
                      variant="outline"
                      className="mb-4 w-fit rounded-full border-violet-300/30 px-3 py-1 text-[10px] font-normal uppercase tracking-[0.2em] text-violet-200/80"
                    >
                      {tier.badge}
                    </Badge>
                  )}
                  <h3 className="text-sm font-medium text-white/85">{tier.name}</h3>
                  <p className="mt-4 flex items-baseline gap-2">
                    <span className="font-display text-4xl text-[#d4b87f]">
                      {tier.price}
                    </span>
                    <span className="text-sm text-white/40">{tier.cadence}</span>
                  </p>
                  <ul className="mt-7 flex-1 space-y-3">
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
                    /*
                      Scrolls to the catalog rather than starting a purchase.
                      The tier is chosen here; the PROGRAM is not, and this page
                      has no door to start one in. Sending someone into a flow
                      that then asks them to choose again — or worse, picks for
                      them — is the forgetting #69 was about.
                    */
                    <Button
                      asChild
                      variant={tier.highlighted ? 'default' : 'outline'}
                      className={
                        tier.highlighted
                          ? 'mt-8 w-full bg-primary text-primary-foreground hover:bg-violet-300'
                          : 'mt-8 w-full border-white/15 bg-transparent text-white/80 hover:border-violet-300/40 hover:bg-violet-300/10 hover:text-white'
                      }
                    >
                      <a href="#catalog">{tier.cta}</a>
                    </Button>
                  ) : (
                    /* Deliberately not a button. A control that looks clickable
                       and does nothing is worse than none, and a payment CTA
                       here would sell something the studio cannot deliver on
                       the day of sale (#13). */
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

      {/* ── Safety ──────────────────────────────────────── */}
      <section className="border-t border-white/5 px-6 py-14">
        <div className="mx-auto max-w-2xl space-y-5 text-center">
          <p className="text-sm leading-relaxed text-white/60">{SAFETY_WARNING}</p>
          <p className="text-sm leading-relaxed text-white/60">{DISCLAIMER}</p>
        </div>
      </section>

      <SiteFooter onHome={onHome} onNavigate={onNavigate} />
    </div>
  )
}
