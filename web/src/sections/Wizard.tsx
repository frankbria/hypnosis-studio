import { useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Clock, Loader2, Lock, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { AudioPreviewButton } from '@/components/AudioPreviewButton'
import { useAudioPreview } from '@/hooks/use-audio-preview'
import {
  ATTESTATION,
  DISCLAIMER,
  GOALS,
  HEALING_NONMEDICAL,
  SAFETY_WARNING,
  PROGRAM_PRICE,
  VOICE_SETS,
  buildTracks,
} from '@/lib/data'
import type { DoorId, VoiceSet } from '@/lib/data'
import {
  NOTHING_CHARGED_ASSURANCE,
  RENDER_FAILURE_GUARANTEE,
  SUPPORT_EMAIL,
} from '@/lib/legal'
import { CHECKOUT_MESSAGE, startCheckout } from '@/lib/checkout'
import type { CheckoutFailure } from '@/lib/checkout'
import GoalCardText from '@/components/GoalCardText'
import SiteFooter from '@/components/SiteFooter'
import { cn } from '@/lib/utils'

// The wizard now ends at Review. Watching the render and downloading it live
// at /program/<jobId>, which survives a reload and a closed tab (#27).
const STEP_LABELS = ['Goal', 'Voice', 'Review'] as const

interface WizardProps {
  door: DoorId
  onExit: () => void
  onHome: () => void
  onNavigate: (path: string) => void
}

/**
 * What the studio said, in the customer's terms.
 *
 * Every one of these used to be a fabricated success screen (#29). They are
 * separate sentences rather than one apology because they call for different
 * things: two are permanent, three come back on their own, one is a fault
 * worth reporting.
 *
 * Every one of them happens BEFORE any charge — this screen is the last point
 * before checkout, and the early-access path only exists while payment is
 * switched off. So NOTHING_CHARGED_ASSURANCE is appended to all of them rather
 * than written into each, which is what stops one of them quietly acquiring a
 * different claim about the customer's money (#30).
 */
const START_ERRORS: Record<string, string> = {
  // The studio takes payment now, so the early-access door is shut for good.
  rendering_requires_payment:
    'Early access has closed — programs are now bought through checkout.',
  // No ACCESS_CODE is configured, so this path is switched off entirely.
  rendering_disabled:
    'The studio is not taking early-access programs at the moment.',
  // Real limits, and both come back on their own.
  budget_exhausted:
    'The studio is at capacity for this month and is not taking new programs right now.',
  temporarily_unavailable:
    'The studio is at capacity and is not taking new programs right now. Please try later.',
  daily_cap: "The studio's limit for today is reached — please try again tomorrow.",
  busy: 'Another program is rendering right now. Please try again in a few minutes.',
  storage_unavailable:
    'The studio could not start your program because of a problem on our side.',
}

const GENERIC_START_ERROR = 'The studio could not start your program.'

// ─── Stepper ─────────────────────────────────────────────────────────────────

function Stepper({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2 sm:gap-3">
      {STEP_LABELS.map((label, i) => {
        const done = i < current
        const active = i === current
        return (
          <li key={label} className="flex items-center gap-2 sm:gap-3">
            {i > 0 && (
              <span
                className={cn(
                  'h-px w-3 sm:w-6',
                  i <= current ? 'bg-violet-300/50' : 'bg-white/10',
                )}
              />
            )}
            <span
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] transition-colors',
                done && 'border-violet-300/60 bg-violet-300/20 text-violet-200',
                active && 'border-violet-300 bg-violet-300 text-[#0b0b12]',
                !done && !active && 'border-white/15 text-white/35',
              )}
            >
              {done ? <Check className="size-3" /> : i + 1}
            </span>
            <span
              className={cn(
                'hidden text-xs md:block',
                active ? 'text-white/85' : 'text-white/35',
              )}
            >
              {label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

// ─── Step headers ────────────────────────────────────────────────────────────

function StepHeader({
  eyebrow,
  title,
  copy,
}: {
  eyebrow: string
  title: string
  copy: string
}) {
  return (
    <div className="mb-10 text-center">
      <p className="text-xs uppercase tracking-[0.2em] text-white/40">{eyebrow}</p>
      <h1 className="font-display mt-4 text-4xl leading-tight text-[#e8e6f0] md:text-5xl">
        {title}
      </h1>
      <p className="mx-auto mt-4 max-w-lg text-sm leading-relaxed text-white/50">
        {copy}
      </p>
    </div>
  )
}

// ─── Starting a render ───────────────────────────────────────────────────────
//
// There is no demo fallback any more (#29). Any non-202 used to route into
// mockFlow(), which fabricated a staged success — headline "Your program is
// ready." over four cards playing voice samples — for a 500, an nginx 502, or
// a `503 rendering_disabled`. That made sense while the frontend was a static
// preview. With a real backend behind a real payment, a customer who has been
// charged and hits a 500 must not be shown a success screen.

// ─── Wizard ──────────────────────────────────────────────────────────────────

export default function Wizard({ door, onExit, onHome, onNavigate }: WizardProps) {
  const [step, setStep] = useState(0)
  const [goalId, setGoalId] = useState<string | null>(null)
  const [customText, setCustomText] = useState('')
  const [voiceSetId, setVoiceSetId] = useState<VoiceSet['id'] | null>(null)
  const [agreed, setAgreed] = useState(false)
  const [attested, setAttested] = useState(false)
  const [accessCode, setAccessCode] = useState('')
  const [codeError, setCodeError] = useState<string | null>(null)
  // A server-side refusal, as opposed to a wrong access code. Kept apart
  // because they belong in different places on the screen and only one of them
  // is the customer's to fix.
  const [startError, setStartError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [checkoutBusy, setCheckoutBusy] = useState(false)
  const [checkoutError, setCheckoutError] = useState<CheckoutFailure | null>(null)
  const audio = useAudioPreview()

  // Only what can be bought. Step 1 is the purchase screen: someone who has
  // already decided to pay was being shown two products they cannot have, one
  // of which (`custom`) is not unfinished at all — it is the $129 tier, greyed
  // out under a badge saying it does not exist (#66).
  const doorGoals = useMemo(
    () => GOALS.filter((g) => g.door === door && g.available),
    [door],
  )
  const goal = doorGoals.find((g) => g.id === goalId) ?? null
  const voiceSet = VOICE_SETS.find((v) => v.id === voiceSetId) ?? null
  const tracks = useMemo(() => (goal ? buildTracks(goal) : []), [goal])

  const goTo = (next: number) => {
    audio.stop()
    setStep(next)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  /**
   * Start the render, then hand off to its own URL.
   *
   * The job id used to live only in this component's state, so a reload during
   * a fifteen-minute render lost it for good (#27). The wizard's job ends the
   * moment the render exists.
   */
  const startRender = async () => {
    if (!goal || !voiceSet) return
    setStarting(true)
    setCodeError(null)
    setStartError(null)
    let res: Response
    try {
      res = await fetch('/api/programs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal: goal.apiGoal ?? goal.id,
          voiceSet: voiceSet.id,
          custom: customText,
          accessCode,
        }),
      })
    } catch {
      setStarting(false)
      setStartError(
        `We couldn't reach the studio. Check your connection and try again. `
        + NOTHING_CHARGED_ASSURANCE,
      )
      return
    }
    if (res.status === 403) {
      setStarting(false)
      setCodeError("That code didn't work — check it and try again.")
      return
    }
    if (res.status === 422) {
      // Kept even though the UI filters unavailable goals: the API can still
      // return it for a hand-crafted request, and deleting a server-error
      // branch because the UI cannot trigger it is how a real 422 becomes an
      // unhandled blank screen (#66).
      setStarting(false)
      setStartError(
        "That program isn't in production yet — choose one of the available goals. "
        + NOTHING_CHARGED_ASSURANCE,
      )
      return
    }
    if (res.status !== 202) {
      setStarting(false)
      let reason = ''
      try {
        reason = ((await res.json()) as { error?: string }).error ?? ''
      } catch {
        reason = ''
      }
      // Every branch names what happened. The old code showed a fabricated
      // success for all of these (#29).
      setStartError(
        `${START_ERRORS[reason] ?? `${GENERIC_START_ERROR} (HTTP ${res.status})`} `
        + NOTHING_CHARGED_ASSURANCE,
      )
      return
    }
    // Guarded: an unparseable body here would reject the handler and leave
    // `starting` true, disabling both ways out of this screen with nothing
    // said. And a body without a jobId would navigate to /program/undefined,
    // which reads as "deleted after 30 days" for a render that just started.
    let jobId: unknown
    try {
      jobId = ((await res.json()) as { jobId?: unknown }).jobId
    } catch {
      jobId = undefined
    }
    if (typeof jobId !== 'string' || jobId === '') {
      setStarting(false)
      setStartError(
        'Your program started, but the studio did not say where to find it. ' +
          'Please get in touch before trying again.',
        // Deliberately no charge claim: the render DID start, so this is the
        // one failure on this screen where "nothing was charged" might not be
        // true (#30).
      )
      return
    }
    onNavigate(`/program/${jobId}`)
  }

  const goalValid =
    goalId !== null &&
    // doorGoals is the catalog now, so `.available` would be a tautology. What
    // still matters is that the selection belongs to THIS door — a goalId can
    // survive a door switch.
    doorGoals.some((g) => g.id === goalId) &&
    (goalId !== 'custom' || customText.trim().length > 0)

  return (
    <div className="animate-fade-in min-h-screen">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b border-white/5 bg-[#0b0b12]/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6">
          <button
            type="button"
            onClick={onHome}
            className="text-xs font-medium tracking-[0.3em] text-white/70 transition-colors hover:text-white"
            title="Back to the door chooser"
          >
            HYPNOSIS&nbsp;STUDIO
          </button>
          <Stepper current={step} />
          <Button
            variant="ghost"
            size="sm"
            onClick={onExit}
            className="text-white/40 hover:bg-white/5 hover:text-white/80"
            aria-label="Exit to landing page"
          >
            <X className="size-4" />
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-14">
        <div key={step} className="animate-fade-up">
          {/* ── Step 1 · Goal ─────────────────────────────── */}
          {step === 0 && (
            <section>
              <StepHeader
                eyebrow={door === 'healing' ? 'Step 1 · Practice' : 'Step 1 · Goal'}
                title={
                  door === 'healing'
                    ? 'What kind of rest do you need?'
                    : 'What should the program change?'
                }
                copy={
                  door === 'healing'
                    ? 'Choose the practice. Every script is a guided descent into deep rest and symbolic renewal — rest and personal growth, never medical treatment.'
                    : 'Choose the territory. The script, the metaphor, and the suggestions are all written from this choice.'
                }
              />
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {doorGoals.map((g) => {
                  const selected = goalId === g.id
                  return (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => setGoalId(g.id)}
                      aria-pressed={selected}
                      className={cn(
                        'relative rounded-2xl border p-7 text-left transition-colors',
                        selected
                          ? 'border-violet-300/60 bg-violet-300/10'
                          : 'border-white/10 bg-white/5 hover:border-white/25',
                      )}
                    >
                      {selected && (
                        <span className="absolute right-5 top-5 flex size-5 items-center justify-center rounded-full bg-violet-300 text-[#0b0b12]">
                          <Check className="size-3" />
                        </span>
                      )}
                      <g.icon
                        className={cn(
                          'size-5',
                          selected ? 'text-[#d4b87f]' : 'text-violet-300',
                        )}
                      />
                      <GoalCardText goal={g} />
                    </button>
                  )
                })}
              </div>
              {goalId === 'custom' && (
                <div className="animate-fade-up mx-auto mt-8 max-w-xl">
                  <Textarea
                    value={customText}
                    onChange={(e) => setCustomText(e.target.value)}
                    placeholder="Describe the change you want, in a sentence or two"
                    rows={4}
                    className="resize-none rounded-2xl border-white/15 bg-white/5 text-sm text-white/85 placeholder:text-white/30 focus-visible:ring-violet-300/50"
                  />
                  <p className="mt-2 text-xs text-white/35">
                    A sentence or two is enough — the script does the rest.
                  </p>
                </div>
              )}
            </section>
          )}

          {/* ── Step 2 · Voice ────────────────────────────── */}
          {step === 1 && (
            <section>
              <StepHeader
                eyebrow="Step 2 · Voice"
                title="Who guides you down?"
                copy="Every program pairs a narrator with a whisper layer. Preview both voices in each set."
              />
              <div className="mx-auto grid max-w-3xl gap-4 md:grid-cols-2">
                {VOICE_SETS.map((set) => {
                  const selected = voiceSetId === set.id
                  return (
                    <div
                      key={set.id}
                      role="button"
                      tabIndex={0}
                      aria-pressed={selected}
                      onClick={() => setVoiceSetId(set.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setVoiceSetId(set.id)
                        }
                      }}
                      className={cn(
                        'relative cursor-pointer rounded-2xl border p-7 transition-colors',
                        selected
                          ? 'border-violet-300/60 bg-violet-300/10'
                          : 'border-white/10 bg-white/5 hover:border-white/25',
                      )}
                    >
                      {selected && (
                        <span className="absolute right-5 top-5 flex size-5 items-center justify-center rounded-full bg-violet-300 text-[#0b0b12]">
                          <Check className="size-3" />
                        </span>
                      )}
                      <h3 className="text-sm font-medium uppercase tracking-[0.15em] text-white/85">
                        {set.label}
                      </h3>
                      <div className="mt-6 space-y-3">
                        {[set.narrator, set.whisper].map((voice) => (
                          <div
                            key={voice.name}
                            className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
                          >
                            <div className="min-w-0">
                              <p className="text-[10px] uppercase tracking-[0.2em] text-white/60">
                                {voice.role}
                              </p>
                              <p className="truncate text-sm text-white/85">
                                {voice.name}
                                <span className="text-white/40">
                                  {' '}
                                  · {voice.description}
                                </span>
                              </p>
                            </div>
                            <AudioPreviewButton
                              src={voice.src}
                              playingSrc={audio.playingSrc}
                              onToggle={audio.toggle}
                              // Not lowercased: the role now begins with "AI", and "ai narrator" is
                              // read aloud as a word by some screen readers rather than as
                              // the two letters. The role already reads naturally as-is.
                              label={`${voice.name}, ${voice.role}`}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
              <p className="font-display mx-auto mt-10 max-w-md text-center text-lg italic leading-relaxed text-white/45">
                “The narrator guides you down. The whisper layer carries the
                suggestions underneath — you barely hear it, and that’s the
                point.”
              </p>
            </section>
          )}

          {/* ── Step 3 · Review ───────────────────────────── */}
          {step === 2 && goal && (
            <section>
              <StepHeader
                eyebrow="Step 3 · Review"
                title="Read it back before we begin."
                copy="This is exactly what the studio will build. The price is a single payment — no subscription."
              />
              <div className="mx-auto max-w-2xl space-y-4">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-8">
                  <dl className="space-y-5">
                    <div className="flex items-start justify-between gap-6">
                      <dt className="text-xs uppercase tracking-[0.2em] text-white/35">
                        {door === 'healing' ? 'Practice' : 'Goal'}
                      </dt>
                      <dd className="text-right text-sm text-white/85">
                        {goal.name}
                        {goal.id === 'custom' && customText.trim() && (
                          <span className="mt-1 block max-w-sm text-xs italic leading-relaxed text-white/45">
                            “{customText.trim()}”
                          </span>
                        )}
                      </dd>
                    </div>
                    <div className="flex items-start justify-between gap-6 border-t border-white/5 pt-5">
                      <dt className="text-xs uppercase tracking-[0.2em] text-white/35">
                        Voices
                      </dt>
                      <dd className="text-right text-sm text-white/85">
                        {voiceSet?.label}
                        <span className="mt-1 block text-xs text-white/45">
                          {voiceSet?.narrator.name} narrates ·{' '}
                          {voiceSet?.whisper.name} whispers
                        </span>
                      </dd>
                    </div>
                    <div className="flex items-start justify-between gap-6 border-t border-white/5 pt-5">
                      <dt className="text-xs uppercase tracking-[0.2em] text-white/35">
                        Price
                      </dt>
                      <dd className="text-right">
                        <span className="font-display text-2xl text-[#d4b87f]">
                          {PROGRAM_PRICE}
                        </span>
                        <span className="ml-2 text-xs text-white/40">
                          one-time
                        </span>
                      </dd>
                    </div>
                  </dl>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/5 p-8">
                  <p className="text-xs uppercase tracking-[0.2em] text-white/35">
                    Your four tracks
                  </p>
                  <ol className="mt-5 space-y-3">
                    {tracks.map((track) => (
                      <li
                        key={track.numeral}
                        className="flex items-center justify-between gap-4 text-sm"
                      >
                        <span className="text-white/80">{track.title}</span>
                        <span className="flex shrink-0 items-center gap-1.5 text-xs text-white/40">
                          <Clock className="size-3" />
                          {track.duration}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>

                <p className="mb-5 rounded-lg border border-amber-200/25 bg-amber-100/[0.06] px-5 py-3.5 text-sm leading-relaxed text-white/75">
                  {SAFETY_WARNING}
                </p>
                <label
                  htmlFor="wizard-consent"
                  className="flex cursor-pointer items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-6"
                >
                  <Checkbox
                    id="wizard-consent"
                    checked={agreed}
                    onCheckedChange={(value) => setAgreed(value === true)}
                    className="mt-0.5 border-white/25 data-[state=checked]:border-violet-300 data-[state=checked]:bg-violet-300 data-[state=checked]:text-[#0b0b12]"
                  />
                  <span className="text-xs leading-relaxed text-white/60">
                    {DISCLAIMER}
                  </span>
                </label>

                <label
                  htmlFor="wizard-attestation"
                  className="mt-3 flex cursor-pointer items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-6"
                >
                  <Checkbox
                    id="wizard-attestation"
                    checked={attested}
                    onCheckedChange={(value) => setAttested(value === true)}
                    className="mt-0.5 border-white/25 data-[state=checked]:border-violet-300 data-[state=checked]:bg-violet-300 data-[state=checked]:text-[#0b0b12]"
                  />
                  <span className="text-xs leading-relaxed text-white/60">
                    {ATTESTATION}
                  </span>
                </label>

                <p className="mt-4 text-xs leading-relaxed text-white/60">
                  {RENDER_FAILURE_GUARANTEE}{' '}
                  <a
                    href="/refunds"
                    onClick={(event) => {
                      if (
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.button !== 0
                      )
                        return
                      event.preventDefault()
                      onNavigate('/refunds')
                    }}
                    className="text-violet-300 underline underline-offset-2"
                  >
                    Read the refund policy
                  </a>
                  .
                </p>

                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
                  <Label
                    htmlFor="wizard-access-code"
                    className="text-xs uppercase tracking-[0.2em] text-white/35"
                  >
                    Early-access code
                  </Label>
                  <Input
                    id="wizard-access-code"
                    type="password"
                    value={accessCode}
                    onChange={(e) => {
                      setAccessCode(e.target.value)
                      setCodeError(null)
                    }}
                    autoComplete="off"
                    className="mt-3 border-white/15 bg-white/5 text-sm text-white/85 placeholder:text-white/30 focus-visible:ring-violet-300/50"
                    placeholder="Enter your code"
                  />
                  <p className="mt-2 text-xs text-white/35">
                    Prototype access only — full checkout lands at launch.
                  </p>
                  {codeError && (
                    <p className="mt-2 text-xs text-red-300/90">{codeError}</p>
                  )}
                </div>
              </div>
            </section>
          )}

        </div>

        {/* Step navigation */}
        {step <= 2 && (
          <div className="mx-auto mt-12 flex max-w-2xl items-center justify-between">
            {step > 0 ? (
              <Button
                variant="ghost"
                onClick={() => goTo(step - 1)}
                className="text-white/50 hover:bg-white/5 hover:text-white"
              >
                <ArrowLeft className="size-4" />
                Back
              </Button>
            ) : (
              <span />
            )}
            {step === 0 && (
              <Button
                onClick={() => goTo(1)}
                disabled={!goalValid}
                className="bg-primary text-primary-foreground hover:bg-violet-300 disabled:opacity-30"
              >
                Continue
                <ArrowRight className="size-4" />
              </Button>
            )}
            {step === 1 && (
              <Button
                onClick={() => goTo(2)}
                disabled={voiceSetId === null}
                className="bg-primary text-primary-foreground hover:bg-violet-300 disabled:opacity-30"
              >
                Continue
                <ArrowRight className="size-4" />
              </Button>
            )}
            {step === 2 && (
              <div className="flex flex-col items-end gap-3">
                <div className="flex flex-wrap items-center justify-end gap-3">
                  {/*
                    Buying starts where choosing ends. #22 parked the checkout
                    button on the post-render screen, which only made sense
                    while renders were free; this is the screen that shows the
                    price and the consent the purchase is made under.
                  */}
                  <Button
                    onClick={async () => {
                      setCheckoutBusy(true)
                      setCheckoutError(null)
                      const failure = await startCheckout(
                        goal ? (goal.apiGoal ?? goal.id) : '',
                        voiceSet ? voiceSet.id : '',
                      )
                      if (failure) {
                        setCheckoutError(failure)
                        setCheckoutBusy(false)
                      }
                    }}
                    disabled={!agreed || !attested || checkoutBusy || starting}
                    className="bg-primary text-primary-foreground hover:bg-violet-300 disabled:opacity-30"
                  >
                    {checkoutBusy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Lock className="size-4" />
                    )}
                    {checkoutBusy ? 'Opening checkout…' : `Checkout · ${PROGRAM_PRICE}`}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={startRender}
                    disabled={
                      !agreed || !attested || !accessCode.trim() || starting || checkoutBusy
                    }
                    className="border-white/15 bg-transparent text-white/75 hover:border-violet-300/40 hover:bg-violet-300/10 hover:text-white disabled:opacity-30"
                  >
                    {starting ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ArrowRight className="size-4" />
                    )}
                    {starting ? 'Starting…' : 'Use my early-access code'}
                  </Button>
                </div>
                {checkoutError && (
                  <p role="status" className="text-right text-sm text-white/70">
                    {CHECKOUT_MESSAGE[checkoutError]}
                  </p>
                )}
                {startError && (
                  <p
                    role="alert"
                    className="max-w-md text-right text-sm leading-relaxed text-white/70"
                  >
                    {startError}{' '}
                    {/*
                      The address on every failure, not only the ones that look
                      like faults: the customer cannot tell which is which, and
                      #18 exists because a screen like this offered no way to
                      reach anyone.
                    */}
                    <a
                      href={`mailto:${SUPPORT_EMAIL}`}
                      className="text-violet-300 underline underline-offset-2"
                    >
                      {SUPPORT_EMAIL}
                    </a>{' '}
                    — a person reads it.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </main>

      {door === 'healing' && (
        <div className="border-t border-white/5 px-6 py-6">
          <p className="mx-auto max-w-2xl text-center text-xs leading-relaxed text-white/60">
            {HEALING_NONMEDICAL}
          </p>
        </div>
      )}
      {/* The policy links belong here too — the wizard is where money changes
          hands, and it was the one surface with no way to reach them (#16). */}
      <SiteFooter onHome={onHome} onNavigate={onNavigate} />
    </div>
  )
}
