import { useCallback, useEffect, useState } from 'react'
import DoorChooser from '@/sections/DoorChooser'
import Landing from '@/sections/Landing'
import Wizard from '@/sections/Wizard'
import type { DoorId } from '@/lib/data'

type View = 'landing' | 'wizard'

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

export default function App() {
  const [door, setDoor] = useState<DoorId | null>(() =>
    doorFromPath(normalizedPath()),
  )
  const [view, setView] = useState<View>('landing')

  useEffect(() => {
    const onPop = () => {
      setDoor(doorFromPath(normalizedPath()))
      setView('landing')
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    document.title = door ? DOC_TITLES[door] : DOC_TITLES.chooser
  }, [door])

  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [view, door])

  const goHome = useCallback(() => {
    window.history.pushState({}, '', '/')
    setDoor(null)
    setView('landing')
  }, [])

  const enterDoor = useCallback((next: DoorId) => {
    window.history.pushState({}, '', `/${next}`)
    setDoor(next)
    setView('landing')
  }, [])

  if (door === null) {
    return (
      <div className="min-h-screen">
        <DoorChooser onEnter={enterDoor} />
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
        />
      ) : (
        <Wizard
          door={door}
          onExit={() => setView('landing')}
          onHome={goHome}
        />
      )}
    </div>
  )
}
