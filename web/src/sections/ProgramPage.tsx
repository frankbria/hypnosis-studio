/**
 * A render, at its own URL (#27).
 *
 * The job id used to exist only in React state inside a mounted wizard step, so
 * closing the tab, reloading, or a laptop sleeping through a fifteen-minute
 * render lost it permanently — and after payment that is someone who paid and
 * has no route back to what they bought. Nobody watches a progress bar for
 * twenty minutes; this is the normal path, not the edge case.
 *
 * The polling loop and the delivery screen MOVED here rather than being copied.
 * Two copies of a delivery screen is how one of them ends up missing the field
 * you just added, which this repo has been bitten by more than once (#65, #66).
 * The wizard now collects the choices and hands off.
 */
import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Clock, Download, Loader2, RotateCcw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { GENERATION_STAGES, VOICE_SETS } from '@/lib/data'
import type { TrackPhase, VoiceSet } from '@/lib/data'
import { FAILURE_ASSURANCE, RETENTION_WINDOW, SUPPORT_EMAIL } from '@/lib/legal'
import type { RefundState } from '@/lib/legal'
import SiteFooter from '@/components/SiteFooter'
import { plainDate } from '@/lib/utils'

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

/**
 * A purchase that was already fulfilled when the page loaded (#59, #137).
 *
 * A catalog order has no render and no job to watch: the masters exist, and the
 * order endpoint hands back the tracks with their links already signed. So this
 * page shows the delivery screen straight away rather than polling for a status
 * that will never be written.
 *
 * It is the same screen a finished render gets, deliberately. #27 moved the
 * delivery screen here precisely so there would be one of it — two copies is how
 * one of them ends up missing the field you just added (#65, #66).
 */
export interface DeliveredProgram {
  tracks: ReadyTrack[]
  /** Which voice set, so the delivery copy names the voices as it does for a render. */
  voiceSet: string | null
}

interface JobStatus {
  state: 'rendering' | 'ready' | 'failed'
  stage?: string
  progress?: number
  error?: string
  refund?: RefundState
  goal?: string
  voiceSet?: string
  tracks?: ReadyTrack[]
}

const STAGE_INDEX: Record<string, number> = {
  scripting: 0,
  voicing: 1,
  'whisper-layer': 2,
  'entrainment-bed': 3,
  'mastering-qa': 4,
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const fmtDuration = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`

/** What this page is showing right now. */
type Screen =
  | { kind: 'loading' }
  | { kind: 'rendering'; stages: number; progress: number }
  | { kind: 'ready'; tracks: ReadyTrack[]; voices: VoiceSet | null }
  | { kind: 'failed'; message: string; refunded: boolean }
  | { kind: 'empty' }
  /**
   * A catalog purchase whose 30-day window has closed, or whose program was
   * unpublished pending a fresh listen (#137). Distinct from `empty`, which
   * blames a render — there was never one to blame, and the customer is holding
   * a valid receipt rather than looking at a broken page.
   */
  | { kind: 'expired' }
  | { kind: 'missing' }
  | { kind: 'unreachable' }

function Frame({
  children,
  onHome,
  onNavigate,
}: {
  children: React.ReactNode
  onHome: () => void
  onNavigate: (path: string) => void
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-white/5 px-6 py-5">
        <button
          onClick={onHome}
          className="text-xs uppercase tracking-[0.3em] text-white/50 transition-colors hover:text-white/80"
        >
          Hypnosis Studio
        </button>
      </header>
      <main className="flex-1 px-6 py-12">{children}</main>
      <SiteFooter onHome={onHome} onNavigate={onNavigate} />
    </div>
  )
}

function Header({
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

export default function ProgramPage({
  jobId,
  delivered = null,
  expiresAt = null,
  onHome,
  onNavigate,
}: {
  /** Null for a catalog order, which has no render to watch. */
  jobId: string | null
  /**
   * Set when the purchase was already fulfilled — a catalog order (#59). The
   * page skips polling entirely and its file links are used as minted.
   */
  delivered?: DeliveredProgram | null
  /**
   * When these files are deleted, in plain language on the page (#70). Supplied
   * by the order route, which is the only caller that knows it — the job itself
   * does not, and the retention sweep measures from the terminal status write.
   */
  expiresAt?: string | null
  onHome: () => void
  onNavigate: (path: string) => void
}) {
  // A delivered purchase is not state to be fetched — it arrived with the props,
  // so it is derived during render rather than pushed into state by an effect.
  // Setting it in an effect would also re-fire on every render, because the
  // caller builds `delivered` fresh each time.
  //
  // `tracks` is empty past the access window or while the program is
  // unpublished; the server sends the order anyway, because it is the
  // customer's receipt.
  const deliveredScreen: Screen | null = !delivered
    ? null
    : delivered.tracks.length === 0
      ? { kind: 'expired' }
      : {
          kind: 'ready',
          tracks: delivered.tracks,
          voices: VOICE_SETS.find((v) => v.id === delivered.voiceSet) ?? null,
        }

  const [polledScreen, setScreen] = useState<Screen>({ kind: 'loading' })
  const screen = deliveredScreen ?? polledScreen
  // Highest stage reached, so a status that briefly reports an earlier stage
  // cannot make the list appear to go backwards.
  const highWater = useRef(1)

  useEffect(() => {
    let cancelled = false
    highWater.current = 1

    // Nothing to watch: the files already exist, and the screen for them is
    // derived above. Polling `/api/jobs/null` would be a 404 loop on a page
    // someone reached by paying.
    if (!jobId) return

    async function run(id: string) {
      // The refund is issued asynchronously from the same transition that marks
      // a job failed, so `refund` lands a beat after `state: 'failed'`. Settling
      // immediately showed the hedged wording to customers whose money was
      // already on its way back (#26).
      let refundWaits = 0
      let networkFailures = 0
      let delay = 0

      while (!cancelled) {
        if (delay) await sleep(delay)
        if (cancelled) return
        delay = 3000

        let res: Response
        try {
          res = await fetch(`/api/jobs/${encodeURIComponent(id)}`)
        } catch {
          // The studio is unreachable. Two in a row before saying so, since a
          // single dropped request during a twenty-minute wait is normal.
          networkFailures += 1
          if (networkFailures >= 2) setScreen({ kind: 'unreachable' })
          continue
        }

        if (res.status === 404) {
          setScreen({ kind: 'missing' })
          return
        }
        if (!res.ok) {
          networkFailures += 1
          if (networkFailures >= 2) setScreen({ kind: 'unreachable' })
          continue
        }
        networkFailures = 0

        let s: JobStatus
        try {
          s = (await res.json()) as JobStatus
        } catch {
          continue
        }

        if (s.state === 'ready') {
          // Ready, but nothing to hand over. Reachable from a legacy
          // single-track manifest or an unreadable manifest.json — and
          // "Your program is ready." above an empty grid is the worst possible
          // way to say it. The old result step had a guard for this; the move
          // dropped it.
          if (!s.tracks || s.tracks.length === 0) {
            setScreen({ kind: 'empty' })
            return
          }
          setScreen({
            kind: 'ready',
            tracks: s.tracks,
            voices: VOICE_SETS.find((v) => v.id === s.voiceSet) ?? null,
          })
          return
        }

        if (s.state === 'failed') {
          if ((s.refund === undefined || s.refund === 'pending') && refundWaits < 8) {
            refundWaits += 1
            delay = 500
            continue
          }
          // A total mapping, so no state can fall through to another state's
          // sentence (#30). An unrecognised value is `unknown`, which hedges —
          // the only case where hedging is true.
          const state: RefundState =
            s.refund && s.refund in FAILURE_ASSURANCE ? s.refund : 'unknown'
          setScreen({
            kind: 'failed',
            message: `${
              s.error ? `The render didn't finish: ${s.error}` : "The render didn't finish."
            } ${FAILURE_ASSURANCE[state]}`,
            refunded: state === 'refunded',
          })
          return
        }

        const idx = (STAGE_INDEX[s.stage ?? ''] ?? 0) + 1
        highWater.current = Math.max(highWater.current, idx)
        setScreen({
          kind: 'rendering',
          stages: highWater.current,
          progress: Math.round((s.progress ?? 0) * 100),
        })
      }
    }

    run(jobId)
    return () => {
      cancelled = true
    }
  }, [jobId])

  if (screen.kind === 'loading') {
    return (
      <Frame onHome={onHome} onNavigate={onNavigate}>
        <div className="mx-auto max-w-md py-10 text-center text-sm text-white/50">
          <Loader2 className="mx-auto mb-4 size-5 animate-spin text-[#d4b87f]" />
          Finding your program…
        </div>
      </Frame>
    )
  }

  if (screen.kind === 'missing') {
    return (
      <Frame onHome={onHome} onNavigate={onNavigate}>
        <div className="mx-auto max-w-md py-10 text-center">
          <Header
            eyebrow="Program"
            title="We can't find that program."
            copy="This link is either wrong, or the program has passed the 30 days the studio keeps finished renders on disk. Downloads are deleted after that; the link outlives the files."
          />
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button
              size="lg"
              onClick={onHome}
              className="bg-primary text-primary-foreground hover:bg-violet-300"
            >
              Back to the studio
            </Button>
          </div>
          <p className="mt-8 text-xs leading-relaxed text-white/60">
            Bought this recently?{' '}
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="text-violet-300 underline underline-offset-2"
            >
              {SUPPORT_EMAIL}
            </a>{' '}
            — a person reads it.
          </p>
        </div>
      </Frame>
    )
  }

  if (screen.kind === 'empty') {
    return (
      <Frame onHome={onHome} onNavigate={onNavigate}>
        <div className="mx-auto max-w-md py-10 text-center">
          <Header
            eyebrow="Your program"
            title="Your program finished, but we can't list the files."
            copy="The render completed and the audio should exist. Something is wrong with this page's view of it, not with your program — please get in touch and we will send it to you directly."
          />
          <p className="mt-8 text-xs leading-relaxed text-white/60">
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="text-violet-300 underline underline-offset-2"
            >
              {SUPPORT_EMAIL}
            </a>{' '}
            — a person reads it. Quote this page's address.
          </p>
        </div>
      </Frame>
    )
  }

  if (screen.kind === 'expired') {
    return (
      <Frame onHome={onHome} onNavigate={onNavigate}>
        <div className="mx-auto max-w-md py-10 text-center">
          <Header
            eyebrow="Your order"
            title="This order's download window has closed."
            copy={`Your purchase is still on record — this page is your receipt. The studio keeps files for ${RETENTION_WINDOW} after purchase and then deletes them, so there is nothing left here to download.`}
          />
          <p className="mt-8 text-xs leading-relaxed text-white/60">
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="text-violet-300 underline underline-offset-2"
            >
              {SUPPORT_EMAIL}
            </a>{' '}
            — a person reads it. Quote this page's address.
          </p>
        </div>
      </Frame>
    )
  }

  if (screen.kind === 'unreachable') {
    return (
      <Frame onHome={onHome} onNavigate={onNavigate}>
        <div className="mx-auto max-w-md py-10 text-center">
          <Header
            eyebrow="Program"
            title="We can't reach the studio."
            copy="Your program is not lost — this page is. Keep this link and open it again in a few minutes."
          />
          <Button
            size="lg"
            onClick={() => window.location.reload()}
            className="bg-primary text-primary-foreground hover:bg-violet-300"
          >
            <RotateCcw className="size-4" />
            Try again
          </Button>
        </div>
      </Frame>
    )
  }

  if (screen.kind === 'failed') {
    return (
      <Frame onHome={onHome} onNavigate={onNavigate}>
        <div className="mx-auto max-w-md py-10 text-center">
          <Header
            eyebrow="Creating your program"
            title="Let's pause here."
            copy={screen.message}
          />
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button
              size="lg"
              variant="outline"
              onClick={onHome}
              className="border-white/15 bg-transparent text-white/75 hover:border-violet-300/40 hover:bg-violet-300/10 hover:text-white"
            >
              Back to the studio
            </Button>
          </div>
          {/*
            #18 requires the address on the render-failure screen specifically.
            This is the one moment a customer most needs a human.
          */}
          <p className="mt-8 text-xs leading-relaxed text-white/60">
            Still stuck?{' '}
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="text-violet-300 underline underline-offset-2"
            >
              {SUPPORT_EMAIL}
            </a>{' '}
            — a person reads it.
          </p>
        </div>
      </Frame>
    )
  }

  if (screen.kind === 'rendering') {
    return (
      <Frame onHome={onHome} onNavigate={onNavigate}>
        <div className="mx-auto max-w-md py-10">
          <Header
            eyebrow="Creating your program"
            title="Give the studio a moment."
            copy="Script, voices, and entrainment bed — staged below as each pass completes. All four tracks render in one session; this takes ~15-20 minutes. You can close this page and come back to this link."
          />
          <Progress
            value={screen.progress}
            className="h-1 bg-white/10 [&>div]:bg-violet-300"
          />
          <ol className="mt-10 space-y-4">
            {GENERATION_STAGES.slice(0, screen.stages).map((stage, i) => {
              const stageDone = i < screen.stages - 1
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
          <p className="mt-10 text-center text-xs leading-relaxed text-white/40">
            This page is yours to keep — bookmark it, or just leave the tab open.
          </p>
        </div>
      </Frame>
    )
  }

  // Ready.
  const { tracks, voices } = screen

  // A catalog order's links are signed and expiring, and arrive complete (#59).
  // A job order's `mp3`/`wav` are bare filenames served out of the job
  // directory. Told apart by which prop the caller supplied rather than by the
  // shape of the string: a signature check that fails because the url was
  // re-encoded is a download that 404s for someone who has paid, and guessing
  // from shape is how that happens quietly.
  const signedFiles = delivered !== null
  const fileUrl = (name: string) =>
    signedFiles
      ? name
      : `/api/jobs/${encodeURIComponent(jobId ?? '')}/files/${encodeURIComponent(name)}`
  // `download` names the saved file, so it must be the filename and never the
  // whole signed url — otherwise the browser saves `polymath_track1.mp3?exp=...`.
  //
  // decodeURIComponent throws on a stray `%`, and this runs during the render of
  // the one screen a paying customer needs. A wrong-looking filename is a far
  // smaller problem than a blank delivery page, so it falls back rather than
  // throwing.
  const fileName = (name: string) => {
    if (!signedFiles) return name
    const base = name.split('?')[0].split('/').pop() || name
    try { return decodeURIComponent(base) } catch { return base }
  }

  return (
    <Frame onHome={onHome} onNavigate={onNavigate}>
      <section>
        <Header
          eyebrow="Your program"
          title="Your program is ready."
          copy={
            voices
              ? `Four tracks, voiced by ${voices.narrator.name} with ${voices.whisper.name} underneath. Listen in order — each track builds on the last.`
              : 'Four tracks. Listen in order — each track builds on the last.'
          }
        />
        <div className="mx-auto grid max-w-4xl gap-4 sm:grid-cols-2">
          {tracks.map((track) => (
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
                  <a href={fileUrl(track.mp3)} download={fileName(track.mp3)}>
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
                  <a href={fileUrl(track.wav)} download={fileName(track.wav)}>
                    <Download className="size-4" />
                    Download WAV
                  </a>
                </Button>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-8 text-center text-xs text-white/35">
          {expiresAt
            ? `Save your files. This link works until ${plainDate(expiresAt)}, after which the studio deletes finished renders.`
            : 'Save your files — this link lives as long as the studio keeps finished renders on disk.'}
        </p>
        <div className="mt-8 flex items-center justify-center">
          {/*
            No checkout button here. #22 parked one on the post-render screen as
            a stand-in, which made sense only while renders were free — on the
            delivery page for a program someone has already paid for, "buy
            another" with a hardcoded goal is nonsense. Choosing is where buying
            starts, so the CTA now lives on the review step.
          */}
          <Button
            size="lg"
            variant="outline"
            onClick={onHome}
            className="border-white/15 bg-transparent text-white/75 hover:border-violet-300/40 hover:bg-violet-300/10 hover:text-white"
          >
            <RotateCcw className="size-4" />
            Create another
          </Button>
        </div>
      </section>
    </Frame>
  )
}
