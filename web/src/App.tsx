import { useEffect, useState } from 'react'
import Landing from '@/sections/Landing'
import Wizard from '@/sections/Wizard'

type View = 'landing' | 'wizard'

export default function App() {
  const [view, setView] = useState<View>('landing')

  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [view])

  return (
    <div className="min-h-screen">
      {view === 'landing' ? (
        <Landing onStart={() => setView('wizard')} />
      ) : (
        <Wizard onExit={() => setView('landing')} />
      )}
    </div>
  )
}
