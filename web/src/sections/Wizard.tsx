import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  Download,
  Loader2,
  Lock,
  RotateCcw,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Textarea } from '@/components/ui/textarea'
import { AudioPreviewButton } from '@/components/AudioPreviewButton'
import { useAudioPreview } from '@/hooks/use-audio-preview'
import {
  DISCLAIMER,
  GENERATION_STAGES,
  GENERATION_TOTAL_MS,
  GOALS,
  HEALING_NONMEDICAL,
  PROGRAM_PRICE,
  VOICE_SETS,
  buildTracks,
} from '@/lib/data'
import type { DoorId, TrackPhase, VoiceSet } from '@/lib/data'
import { cn } from '@/lib/utils'

const STEP_LABELS = ['Goal', 'Voice', 'Review', 'Create', 'Program'] as const

const fmtDuration = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`

interface WizardProps {
  door: DoorId
  onExit: () => void
  onHome: () => void
}

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

// ─── Generation (real API + demo fallback) ──────────────────────────────────

export interface ReadyTrack {
  n: number
  id: string
  title: string
  /**
   * Typed as the union, not `string`. It was `string`, which is why the compiler
   * never noticed the delivery screen showing "Mastery" where the purchase
   * screen said "Suggestion" (#15).
   */
  phase: TrackPhase
  durationSec: number
  mp3: string
  wav: string
}

export interface JobResult {
  jobId: string
  demo: boolean
  tracks?: ReadyTrack[]
}

interface GenerationError {
  message: string
  retryable: boolean
}

const STAGE_INDEX: Record<string, number> = {
  scripting: 0,
  voicing: 1,
  'whisper-layer': 2,
  'entrainment-bed': 3,
  'mastering-qa': 4,
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function GeneratingStep({
  apiGoal,
  voiceSetId,
  custom,
  accessCode,
  onDone,
  onBadCode,
  onStartOver,
}: {
  apiGoal: string
  voiceSetId: VoiceSet['id']
  custom: string
  accessCode: string
  onDone: (result: JobResult) => void
  onBadCode: () => void
  onStartOver: () => void
}) {
  const [visibleStages, setVisibleStages] = useState(1)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<GenerationError | null>(null)
  const [runId, setRunId] = useState(0)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const onBadCodeRef = useRef(onBadCode)
  onBadCodeRef.current = onBadCode

  useEffect(() => {
    let cancelled = false

    // Static-preview fallback: stage the old mock flow when the API is unreachable.
    async function mockFlow() {
      const stageMs = GENERATION_TOTAL_MS / GENERATION_STAGES.length
      const start = Date.now()
      while (!cancelled) {
        const elapsed = Date.now() - start
        setProgress(Math.min(100, (elapsed / GENERATION_TOTAL_MS) * 100))
        setVisibleStages(
          Math.min(GENERATION_STAGES.length, Math.floor(elapsed / stageMs) + 1),
        )
        if (elapsed >= GENERATION_TOTAL_MS + 500) {
          onDoneRef.current({ jobId: 'demo', demo: true })
          return
        }
        await sleep(120)
      }
    }

    async function poll(jobId: string) {
      let failures = 0
      while (!cancelled) {
        await sleep(3000)
        if (cancelled) return
        try {
          const r = await fetch(`/api/jobs/${jobId}`)
          if (!r.ok) throw new Error(`status ${r.status}`)
          failures = 0
          const s = await r.json()
          if (s.state === 'ready') {
            setProgress(100)
            setVisibleStages(GENERATION_STAGES.length)
            onDoneRef.current({ jobId, demo: false, tracks: s.tracks })
            return
          }
          if (s.state === 'failed') {
            setError({
              message: s.error
                ? `The render didn't finish: ${s.error}`
                : "The render didn't finish. Nothing was charged — please try again.",
              retryable: true,
            })
            return
          }
          const idx = STAGE_INDEX[s.stage] ?? 0
          setVisibleStages(idx + 1)
          setProgress(Math.round((s.progress ?? 0) * 100))
        } catch {
          failures += 1
          if (failures >= 10) {
            setError({
              message: 'Lost contact with the studio — check your connection, then retry.',
              retryable: true,
            })
            return
          }
        }
      }
    }

    async function run() {
      setError(null)
      setProgress(0)
      setVisibleStages(1)
      let res: Response
      try {
        res = await fetch('/api/programs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goal: apiGoal, voiceSet: voiceSetId, custom, accessCode }),
        })
      } catch {
        // API not reachable at all (static preview) — demo mode.
        await mockFlow()
        return
      }
      if (res.status === 403) {
        onBadCodeRef.current()
        return
      }
      if (res.status === 409) {
        setError({
          message: 'Another render is in progress — try again in a few minutes.',
          retryable: true,
        })
        return
      }
      if (res.status === 422) {
        setError({
          message: "That program isn't in production yet — choose one of the available goals.",
          retryable: false,
        })
        return
      }
      if (res.status === 429) {
        setError({
          message: "The studio's daily render limit is reached — please try again tomorrow.",
          retryable: false,
        })
        return
      }
      if (res.status === 503) {
        // The studio is refusing work it cannot deliver — a spent monthly
        // allowance, or a renders volume it cannot write to. Distinct from 429:
        // this one does not come back tomorrow on its own.
        let reason = ''
        try {
          reason = ((await res.json()) as { error?: string }).error ?? ''
        } catch {
          reason = ''
        }
        setError({
          message:
            reason === 'budget_exhausted'
              ? 'The studio is at capacity for this month and is not taking new programs right now. Nothing has been charged.'
              : 'The studio is temporarily unavailable. Nothing has been charged — please try again shortly.',
          retryable: reason !== 'budget_exhausted',
        })
        return
      }
      if (res.status === 404) {
        // No API behind this host at all (static preview) — demo mode.
        await mockFlow()
        return
      }
      if (res.status !== 202) {
        // Anything else is a real failure. It must NOT fall through to
        // mockFlow(), which simulates a completed render — that would show
        // "your program is ready" for a render that never started.
        setError({
          message: 'Something went wrong starting your program. Nothing has been charged — please try again.',
          retryable: true,
        })
        return
      }
      const { jobId } = await res.json()
      await poll(jobId)
    }

    run()
    return () => {
      cancelled = true
    }
  }, [runId, apiGoal, voiceSetId, custom, accessCode])

  const complete = progress >= 100

  if (error) {
    return (
      <div className="mx-auto max-w-md py-10 text-center">
        <StepHeader
          eyebrow="Creating your program"
          title="Let's pause here."
          copy={error.message}
        />
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          {error.retryable && (
            <Button
              size="lg"
              onClick={() => setRunId((n) => n + 1)}
              className="bg-primary text-primary-foreground hover:bg-violet-300"
            >
              <RotateCcw className="size-4" />
              Retry
            </Button>
          )}
          <Button
            size="lg"
            variant="outline"
            onClick={onStartOver}
            className="border-white/15 bg-transparent text-white/75 hover:border-violet-300/40 hover:bg-violet-300/10 hover:text-white"
          >
            Start over
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-md py-10">
      <StepHeader
        eyebrow="Creating your program"
        title="Give the studio a moment."
        copy="Script, voices, and entrainment bed — staged below as each pass completes. All four tracks render in one session; this takes ~15-20 minutes. You can safely wait here."
      />
      <Progress
        value={progress}
        className="h-1 bg-white/10 [&>div]:bg-violet-300"
      />
      <ol className="mt-10 space-y-4">
        {GENERATION_STAGES.slice(0, visibleStages).map((stage, i) => {
          const stageDone = i < visibleStages - 1 || complete
          return (
            <li
              key={stage}
              className="animate-fade-up flex items-center gap-3 text-sm"
            >
              {stageDone ? (
                <CheckCircle2 className="size-4 shrink-0 text-violet-300" />
              ) : (
                <Loader2 className="size-4 shrink-0 animate-spin text-[#d4b87f]" />
              )}
              <span className={stageDone ? 'text-white/55' : 'text-white/90'}>
                {stage}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

// ─── Wizard ──────────────────────────────────────────────────────────────────

export default function Wizard({ door, onExit, onHome }: WizardProps) {
  const [step, setStep] = useState(0)
  const [goalId, setGoalId] = useState<string | null>(null)
  const [customText, setCustomText] = useState('')
  const [voiceSetId, setVoiceSetId] = useState<VoiceSet['id'] | null>(null)
  const [agreed, setAgreed] = useState(false)
  const [accessCode, setAccessCode] = useState('')
  const [codeError, setCodeError] = useState<string | null>(null)
  const [jobResult, setJobResult] = useState<JobResult | null>(null)
  const audio = useAudioPreview()

  const doorGoals = useMemo(() => GOALS.filter((g) => g.door === door), [door])
  const goal = doorGoals.find((g) => g.id === goalId) ?? null
  const voiceSet = VOICE_SETS.find((v) => v.id === voiceSetId) ?? null
  const tracks = useMemo(() => (goal ? buildTracks(goal) : []), [goal])

  const goTo = (next: number) => {
    audio.stop()
    setStep(next)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const reset = () => {
    setGoalId(null)
    setCustomText('')
    setVoiceSetId(null)
    setAgreed(false)
    setCodeError(null)
    setJobResult(null)
    goTo(0)
  }

  const handleDone = (result: JobResult) => {
    setJobResult(result)
    goTo(4)
  }

  const handleBadCode = () => {
    setCodeError("That code didn't work — check it and try again.")
    goTo(2)
  }

  const goalValid =
    goalId !== null &&
    (doorGoals.find((g) => g.id === goalId)?.available ?? false) &&
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
                      disabled={!g.available}
                      onClick={() => g.available && setGoalId(g.id)}
                      aria-pressed={selected}
                      className={cn(
                        'relative rounded-2xl border p-7 text-left transition-colors',
                        selected
                          ? 'border-violet-300/60 bg-violet-300/10'
                          : 'border-white/10 bg-white/5 hover:border-white/25',
                        !g.available &&
                          'cursor-not-allowed opacity-50 hover:border-white/10',
                      )}
                    >
                      {!g.available && (
                        <Badge
                          variant="outline"
                          className="absolute right-5 top-5 rounded-full border-white/15 px-3 py-1 text-[10px] font-normal uppercase tracking-[0.2em] text-white/40"
                        >
                          In production
                        </Badge>
                      )}
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
                      <h3 className="mt-5 text-base font-medium text-white/90">
                        {g.name}
                      </h3>
                      <p className="mt-1 text-xs uppercase tracking-[0.15em] text-white/35">
                        {g.tagline}
                      </p>
                      <p className="mt-4 text-sm leading-relaxed text-white/50">
                        {g.description}
                      </p>
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
                              <p className="text-[10px] uppercase tracking-[0.2em] text-white/35">
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
                              label={`${voice.name}, ${voice.role.toLowerCase()}`}
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
                  <span className="text-xs leading-relaxed text-white/45">
                    {DISCLAIMER}
                  </span>
                </label>

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

          {/* ── Step 4 · Generating ───────────────────────── */}
          {step === 3 && goal && voiceSet && (
            <GeneratingStep
              apiGoal={goal.apiGoal ?? goal.id}
              voiceSetId={voiceSet.id}
              custom={customText}
              accessCode={accessCode}
              onDone={handleDone}
              onBadCode={handleBadCode}
              onStartOver={reset}
            />
          )}

          {/* ── Step 5 · Result ───────────────────────────── */}
          {step === 4 && goal && voiceSet && jobResult && (
            <section>
              {(() => {
                const realTracks = jobResult.demo ? undefined : jobResult.tracks
                if (!realTracks || realTracks.length === 0) {
                  // Demo fallback (API unreachable — e.g. static preview)
                  return (
                    <>
                      <StepHeader
                        eyebrow="Your program — demo"
                        title="Your program is ready."
                        copy={`Four tracks, voiced by ${voiceSet.narrator.name} with ${voiceSet.whisper.name} underneath. This demo plays short voice samples.`}
                      />
                      <div className="mx-auto grid max-w-4xl gap-4 sm:grid-cols-2">
                        {tracks.map((track, i) => {
                          const sample =
                            i < 2 ? voiceSet.narrator : voiceSet.whisper
                          return (
                            <div
                              key={track.numeral}
                              className="rounded-2xl border border-white/10 bg-white/5 p-7"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <Badge
                                  variant="outline"
                                  className="rounded-full border-violet-300/30 px-3 py-1 text-[10px] font-normal uppercase tracking-[0.2em] text-violet-200/80"
                                >
                                  {track.phase}
                                </Badge>
                                <span className="flex items-center gap-1.5 text-xs text-white/40">
                                  <Clock className="size-3" />
                                  {track.duration}
                                </span>
                              </div>
                              <h3 className="mt-5 text-sm font-medium leading-snug text-white/90">
                                {track.title}
                              </h3>
                              <div className="mt-6 flex items-center justify-between gap-3 border-t border-white/5 pt-5">
                                <span className="text-xs text-white/35">
                                  Voice sample · {sample.name}
                                </span>
                                <AudioPreviewButton
                                  src={sample.src}
                                  playingSrc={audio.playingSrc}
                                  onToggle={audio.toggle}
                                  label={`${sample.name} voice sample`}
                                />
                              </div>
                            </div>
                          )
                        })}
                      </div>
                      <p className="mt-8 text-center text-xs text-white/35">
                        Demo preview — the studio API wasn't reachable, so this
                        result is a staged sample, not a real render.
                      </p>
                    </>
                  )
                }
                // Real render — all four tracks
                const fileUrl = (name: string) =>
                  `/api/jobs/${jobResult.jobId}/files/${encodeURIComponent(name)}`
                return (
                  <>
                    <StepHeader
                      eyebrow="Your program"
                      title="Your program is ready."
                      copy={`Four tracks, voiced by ${voiceSet.narrator.name} with ${voiceSet.whisper.name} underneath. Listen in order — each track builds on the last.`}
                    />
                    <div className="mx-auto grid max-w-4xl gap-4 sm:grid-cols-2">
                      {realTracks.map((track) => (
                        <div
                          key={track.id}
                          className="rounded-2xl border border-violet-300/30 bg-violet-300/5 p-7"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <Badge
                              variant="outline"
                              className="rounded-full border-violet-300/30 px-3 py-1 text-[10px] font-normal uppercase tracking-[0.2em] text-violet-200/80"
                            >
                              {track.phase}
                            </Badge>
                            <span className="flex items-center gap-1.5 text-xs text-white/40">
                              <Clock className="size-3" />
                              {fmtDuration(track.durationSec)}
                            </span>
                          </div>
                          <h3 className="mt-5 text-sm font-medium leading-snug text-white/90">
                            {track.title}
                          </h3>
                          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                          <audio
                            controls
                            preload="none"
                            src={fileUrl(track.mp3)}
                            className="mt-5 w-full"
                          />
                          <div className="mt-5 flex gap-2 border-t border-white/5 pt-5">
                            <Button
                              asChild
                              size="sm"
                              variant="outline"
                              className="border-white/15 bg-transparent text-white/75 hover:border-violet-300/40 hover:bg-violet-300/10 hover:text-white"
                            >
                              <a href={fileUrl(track.mp3)} download={track.mp3}>
                                <Download className="size-4" />
                                Download MP3
                              </a>
                            </Button>
                            <Button
                              asChild
                              size="sm"
                              variant="outline"
                              className="border-white/15 bg-transparent text-white/75 hover:border-violet-300/40 hover:bg-violet-300/10 hover:text-white"
                            >
                              <a href={fileUrl(track.wav)} download={track.wav}>
                                <Download className="size-4" />
                                Download WAV
                              </a>
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="mt-8 text-center text-xs text-white/35">
                      Save your files — this link lives as long as the studio
                      keeps early-access renders on disk.
                    </p>
                  </>
                )
              })()}
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <Button
                  disabled
                  size="lg"
                  className="cursor-not-allowed bg-white/10 text-white/40"
                >
                  <Lock className="size-4" />
                  Checkout (coming soon)
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  onClick={reset}
                  className="border-white/15 bg-transparent text-white/75 hover:border-violet-300/40 hover:bg-violet-300/10 hover:text-white"
                >
                  <RotateCcw className="size-4" />
                  Create another
                </Button>
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
              <Button
                onClick={() => goTo(3)}
                disabled={!agreed || !accessCode.trim()}
                className="bg-primary text-primary-foreground hover:bg-violet-300 disabled:opacity-30"
              >
                Generate my program
                <ArrowRight className="size-4" />
              </Button>
            )}
          </div>
        )}
      </main>

      {door === 'healing' && (
        <footer className="border-t border-white/5 px-6 py-6">
          <p className="mx-auto max-w-2xl text-center text-[11px] leading-relaxed text-white/30">
            {HEALING_NONMEDICAL}
          </p>
        </footer>
      )}
    </div>
  )
}
