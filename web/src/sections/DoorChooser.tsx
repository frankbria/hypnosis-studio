import { ArrowRight, Brain, Moon, Waves } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { DoorId } from '@/lib/data'

interface DoorChooserProps {
  onEnter: (door: DoorId) => void
}

const DOORS = [
  {
    id: 'performance' as DoorId,
    icon: Brain,
    title: 'Performance',
    subtitle: 'Train the mind',
    body: 'Self-hypnosis audio programs for learning, focus, creativity, and seeing opportunity. Four-track programs, rendered fresh for you, in the voice you choose.',
    cta: 'Enter Performance',
  },
  {
    id: 'healing' as DoorId,
    icon: Waves,
    title: 'Healing',
    subtitle: 'Rest the body',
    body: 'Guided imagery and deep-relaxation audio for people who believe the mind and body repair together. Not medicine. Not treatment. Always alongside — never instead of — medical care.',
    cta: 'Enter Healing',
  },
] as const

export default function DoorChooser({ onEnter }: DoorChooserProps) {
  return (
    <div id="top" className="animate-fade-in">
      {/* ── Nav ─────────────────────────────────────────── */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/5 bg-[#0b0b12]/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-center px-6">
          <span className="text-sm font-medium tracking-[0.3em] text-white/90">
            HYPNOSIS&nbsp;STUDIO
          </span>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────── */}
      <section className="relative overflow-hidden px-6 pb-10 pt-40">
        <div
          aria-hidden
          className="animate-glow absolute left-1/2 top-24 -z-10 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-violet-500/10 blur-3xl"
        />
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-white/40">
            Personalized self-hypnosis audio
          </p>
          <h1 className="font-display mt-6 text-5xl leading-[1.08] text-[#e8e6f0] md:text-7xl">
            Two doors into <em className="text-violet-300">the studio.</em>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-white/55 md:text-lg">
            Every program is scripted, voiced, and mastered for one listener.
            Choose the door that matches what you need tonight.
          </p>
        </div>
      </section>

      {/* ── Doors ───────────────────────────────────────── */}
      <section className="px-6 pb-24 pt-10">
        <div className="mx-auto grid max-w-4xl gap-6 md:grid-cols-2">
          {DOORS.map((door) => (
            <Card
              key={door.id}
              role="button"
              tabIndex={0}
              onClick={() => onEnter(door.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onEnter(door.id)
                }
              }}
              className="group cursor-pointer rounded-2xl border-white/10 bg-white/5 shadow-none transition-colors hover:border-violet-300/30"
            >
              <CardContent className="flex h-full flex-col p-10">
                <door.icon className="size-6 text-violet-300 transition-colors group-hover:text-[#d4b87f]" />
                <p className="mt-8 text-xs uppercase tracking-[0.2em] text-white/40">
                  {door.subtitle}
                </p>
                <h2 className="font-display mt-3 text-4xl text-[#e8e6f0]">
                  {door.title}
                </h2>
                <p className="mt-5 flex-1 text-sm leading-relaxed text-white/50">
                  {door.body}
                </p>
                <Button
                  onClick={() => onEnter(door.id)}
                  className="mt-8 w-full bg-primary text-primary-foreground hover:bg-violet-300"
                >
                  {door.cta}
                  <ArrowRight className="size-4" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────── */}
      <footer className="border-t border-white/5 px-6 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 sm:flex-row">
          <div className="flex items-center gap-3">
            <Moon className="size-4 text-violet-300/70" />
            <span className="text-xs font-medium tracking-[0.3em] text-white/70">
              HYPNOSIS&nbsp;STUDIO
            </span>
          </div>
          <p className="text-xs text-white/30">© 2026 Hypnosis Studio</p>
        </div>
      </footer>
    </div>
  )
}
