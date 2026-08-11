import { useCallback, useEffect, useState } from 'react'
import DoorChooser from '@/sections/DoorChooser'
import Landing from '@/sections/Landing'
import Wizard from '@/sections/Wizard'
import { PrivacyPage, RefundPage, TermsPage } from '@/sections/Legal'
import type { LegalPageId } from '@/sections/Legal'
import type { DoorId } from '@/lib/data'

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

// vite base is './', so a trailing-slash URL like /healing/ would resolve
// relative asset URLs against /healing/ and 404. Strip trailing slashes.
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
  const [view, setView] = useState<View>('landing')

  useEffect(() => {
    // Back/forward must work for the policy pages too, so popstate resolves both
    // kinds of route rather than only the door.
    const onPop = () => {
      const path = normalizedPath()
      setDoor(doorFromPath(path))
      setLegal(legalFromPath(path))
      setView('landing')
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    document.title = legal
      ? LEGAL_TITLES[legal]
      : door
        ? DOC_TITLES[door]
        : DOC_TITLES.chooser
  }, [door, legal])

  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [view, door, legal])

  const goHome = useCallback(() => {
    window.history.pushState({}, '', '/')
    setDoor(null)
    setLegal(null)
    setView('landing')
  }, [])

  const enterDoor = useCallback((next: DoorId) => {
    window.history.pushState({}, '', `/${next}`)
    setDoor(next)
    setLegal(null)
    setView('landing')
  }, [])

  const goTo = useCallback((path: string) => {
    window.history.pushState({}, '', path)
    setLegal(legalFromPath(path))
    setDoor(doorFromPath(path))
    setView('landing')
  }, [])

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

  if (door === null) {
    return (
      <div className="min-h-screen">
        <DoorChooser onEnter={enterDoor} onNavigate={goTo} />
      </div>
    )
  }

  return (
    <div className="min-h-screen">
      {view === 'landing' ? (
        <Landing
          door={door}
          onStart={() => setView('wizard')}
          onHome={goHome}
          onNavigate={goTo}
        />
      ) : (
        <Wizard
          door={door}
          onExit={() => setView('landing')}
          onHome={goHome}
          onNavigate={goTo}
        />
      )}
    </div>
  )
}
