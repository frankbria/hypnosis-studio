import { useCallback, useEffect, useState } from 'react'
import CatalogHome from '@/sections/CatalogHome'
import Landing from '@/sections/Landing'
import Wizard from '@/sections/Wizard'
import ProgramPage from '@/sections/ProgramPage'
import OrderPage from '@/sections/OrderPage'
import ResendPage from '@/sections/ResendPage'
import { PrivacyPage, RefundPage, TermsPage } from '@/sections/Legal'
import type { LegalPageId } from '@/sections/Legal'
import type { DoorId, Goal, TierId } from '@/lib/data'

type View = 'landing' | 'wizard'

/**
 * Policy pages live at their own paths so they can be linked to and bookmarked.
 * The server already serves index.html for any extension-less path it does not
 * recognise (serveStatic's SPA fallback), so direct navigation to /terms works
 * without a server change — the routing is entirely here.
 */
const LEGAL_PATHS: Record<string, LegalPageId> = {
  '/terms': 'terms',
  '/privacy': 'privacy',
  '/refunds': 'refunds',
}

const LEGAL_PAGES: Record<LegalPageId, (p: { onHome: () => void }) => React.ReactNode> = {
  terms: TermsPage,
  privacy: PrivacyPage,
  refunds: RefundPage,
}

function legalFromPath(pathname: string): LegalPageId | null {
  return LEGAL_PATHS[pathname] ?? null
}

/**
 * A render lives at its own URL so it survives a reload, a closed tab, and a
 * laptop that slept through the twenty-minute wait (#27).
 *
 * The character class matches what the server's own job-id regex accepts, so a
 * path that could never name a job never reaches the page — it falls through to
 * the door chooser instead of rendering "we can't find that program" for
 * something that was never a program.
 */
function jobFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/program\/([A-Za-z0-9_-]+)$/)
  return m ? m[1] : null
}

/**
 * An order, addressed by the Stripe session id (#70).
 *
 * This is where the post-checkout redirect lands and where the delivery email
 * points, so it is the one link a customer has. The character class matches
 * what the server's own route accepts, so a path that could never name an order
 * falls through to the chooser rather than rendering "we can't find that".
 */
function orderFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/order\/([A-Za-z0-9_-]+)$/)
  return m ? m[1] : null
}

// Dependency-free routing: the door comes from window.location.pathname.
// `/` (or anything unknown) → door chooser; `/performance` and `/healing` →
// that door's landing. The wizard keeps the door path in the URL bar.
function doorFromPath(pathname: string): DoorId | null {
  if (pathname === '/performance' || pathname.startsWith('/performance/'))
    return 'performance'
  if (pathname === '/healing' || pathname.startsWith('/healing/'))
    return 'healing'
  return null
}

// Trailing slashes are stripped so the URL bar stays tidy and routes match
// exactly. (This also used to be load-bearing: with vite's base at './', a URL
// like /healing/ resolved relative asset URLs against /healing/ and 404'd. The
// base is absolute since #27, so that class of failure is gone — but an
// unnormalised path would still miss the route table.)
function normalizedPath(): string {
  const p = window.location.pathname
  if (p.length > 1 && p.endsWith('/')) {
    const clean = p.replace(/\/+$/, '')
    window.history.replaceState(
      {},
      '',
      clean + window.location.search + window.location.hash,
    )
    return clean
  }
  return p
}

const DOC_TITLES: Record<DoorId | 'chooser', string> = {
  chooser: 'Hypnosis Studio',
  performance: 'Hypnosis Studio — Performance',
  healing: 'Hypnosis Studio — Healing',
}

const LEGAL_TITLES: Record<LegalPageId, string> = {
  terms: 'Terms of use — Hypnosis Studio',
  privacy: 'Privacy — Hypnosis Studio',
  refunds: 'Refunds — Hypnosis Studio',
}

export default function App() {
  const [door, setDoor] = useState<DoorId | null>(() =>
    doorFromPath(normalizedPath()),
  )
  const [legal, setLegal] = useState<LegalPageId | null>(() =>
    legalFromPath(normalizedPath()),
  )
  const [job, setJob] = useState<string | null>(() => jobFromPath(normalizedPath()))
  const [order, setOrder] = useState<string | null>(() => orderFromPath(normalizedPath()))
  const [resend, setResend] = useState(() => normalizedPath() === '/resend')
  const [view, setView] = useState<View>('landing')
  /** Which tier the visitor chose, carried to the flow that fulfils it (#69). */
  const [tier, setTier] = useState<TierId>('program')
  /** A program chosen from the catalog, so the wizard does not ask again. */
  const [initialGoal, setInitialGoal] = useState<string | null>(null)

  useEffect(() => {
    // Back/forward must work for the policy pages too, so popstate resolves both
    // kinds of route rather than only the door.
    const onPop = () => {
      const path = normalizedPath()
      setDoor(doorFromPath(path))
      setLegal(legalFromPath(path))
      setJob(jobFromPath(path))
      setOrder(orderFromPath(path))
      setResend(path === '/resend')
      setInitialGoal(null)
      setView('landing')
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    document.title = order || job
      ? 'Your program — Hypnosis Studio'
      : resend
        ? 'Send my link again — Hypnosis Studio'
      : legal
        ? LEGAL_TITLES[legal]
        : door
          ? DOC_TITLES[door]
          : DOC_TITLES.chooser
  }, [door, legal, job, order, resend])

  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [view, door, legal, job, order, resend])

  const goHome = useCallback(() => {
    window.history.pushState({}, '', '/')
    setDoor(null)
    setLegal(null)
    setJob(null)
    setOrder(null)
    setResend(false)
    setInitialGoal(null)
    setView('landing')
  }, [])

  const enterDoor = useCallback((next: DoorId) => {
    window.history.pushState({}, '', `/${next}`)
    setDoor(next)
    setLegal(null)
    setJob(null)
    setOrder(null)
    setResend(false)
    setInitialGoal(null)
    setView('landing')
  }, [])

  const goTo = useCallback((path: string) => {
    window.history.pushState({}, '', path)
    setLegal(legalFromPath(path))
    setDoor(doorFromPath(path))
    setJob(jobFromPath(path))
    setOrder(orderFromPath(path))
    setResend(path === '/resend')
    setInitialGoal(null)
    setView('landing')
  }, [])

  /**
   * Begin buying a specific tier.
   *
   * Only the catalog tier can be fulfilled today, and the pricing page renders
   * no CTA for a tier that cannot (`tier.available`), so the other ids are
   * unreachable rather than unhandled. They are named here anyway: the bug this
   * fixes was a tier silently becoming a different one, and a fallback that
   * quietly routed everything to the catalog flow would be the same bug wearing
   * a switch statement.
   */
  function startPurchase(next: TierId) {
    // Cleared, or a program chosen earlier from the catalog leaks into this
    // entry — and if it belonged to the OTHER door, `goal` resolves to null and
    // the wizard renders a blank step. Entering from a tier CTA means the
    // visitor has chosen a tier, not a program.
    setInitialGoal(null)
    if (next !== 'program') {
      // #73 builds the intake this routes to. Until then, refusing loudly beats
      // selling someone the wrong thing.
      console.error('no flow exists yet for the', next, 'tier');
      return
    }
    setTier(next)
    setView('wizard')
  }

  /**
   * Buy a specific program straight from the catalog (#68).
   *
   * The wizard lives inside a door, so this sets one from the program itself —
   * the catalog has no door of its own, and picking a default would send a
   * healing visitor into the performance flow. The goal is carried through so
   * the wizard opens on the program that was chosen rather than asking again.
   */
  function chooseProgram(goal: Goal) {
    window.history.pushState({}, '', `/${goal.door}`)
    setDoor(goal.door)
    setLegal(null)
    setJob(null)
    setOrder(null)
    setResend(false)
    setTier('program')
    setInitialGoal(goal.id)
    setView('wizard')
  }

  // Checked first: someone arriving at their order or their program has come
  // back for something they bought, and must not be handed the door chooser
  // because they happen to have no door in the URL.
  if (order !== null) {
    return (
      <div className="min-h-screen">
        <OrderPage token={order} onHome={goHome} onNavigate={goTo} />
      </div>
    )
  }

  if (resend) {
    return (
      <div className="min-h-screen">
        <ResendPage onHome={goHome} onNavigate={goTo} />
      </div>
    )
  }

  if (job !== null) {
    return (
      <div className="min-h-screen">
        <ProgramPage jobId={job} onHome={goHome} onNavigate={goTo} />
      </div>
    )
  }

  // Checked before the door, so /terms renders the policy rather than the
  // chooser regardless of which door the visitor came from.
  if (legal !== null) {
    const Page = LEGAL_PAGES[legal]
    return (
      <div className="min-h-screen">
        <Page onHome={goHome} />
      </div>
    )
  }

  // `/` is the catalog itself since #68, not a gate. The doors are still real
  // routes below — they are simply no longer mandatory, and a cold visitor sees
  // programs, audio and prices without first declaring who they are.
  if (door === null) {
    return (
      <div className="min-h-screen">
        <CatalogHome
          onEnterDoor={enterDoor}
          onChooseProgram={chooseProgram}
          onNavigate={goTo}
          onHome={goHome}
        />
      </div>
    )
  }

  return (
    <div className="min-h-screen">
      {view === 'landing' ? (
        <Landing
          door={door}
          onStart={startPurchase}
          onHome={goHome}
          onNavigate={goTo}
        />
      ) : (
        <Wizard
          door={door}
          tier={tier}
          initialGoalId={initialGoal}
          onExit={() => setView('landing')}
          onHome={goHome}
          onNavigate={goTo}
        />
      )}
    </div>
  )
}
