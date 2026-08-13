import { Loader2, Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface AudioPreviewButtonProps {
  src: string
  playingSrc: string | null
  /** Pressed, but not yet audible (#81). */
  pendingSrc?: string | null
  onToggle: (src: string) => void
  /** Accessible label, e.g. "Brian — narrator" */
  label: string
  className?: string
}

export function AudioPreviewButton({
  src,
  playingSrc,
  pendingSrc = null,
  onToggle,
  label,
  className,
}: AudioPreviewButtonProps) {
  const playing = playingSrc === src
  // A third state, not a shade of the other two. The press used to show
  // "Playing" immediately, over silence, for as long as the clip took to load —
  // which reads as a broken button on the one control that has to feel
  // trustworthy (#81).
  const pending = pendingSrc === src
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={`${playing || pending ? 'Pause' : 'Play'} ${label}`}
      aria-pressed={playing || pending}
      // Announced when it flips, so a screen-reader user gets the same
      // acknowledgement a sighted one does.
      aria-busy={pending}
      onClick={(e) => {
        e.stopPropagation()
        onToggle(src)
      }}
      className={cn(
        'h-8 gap-2 rounded-full border-white/15 bg-white/5 px-3 text-xs text-white/70 transition-colors',
        'hover:border-violet-300/40 hover:bg-violet-300/10 hover:text-white',
        (playing || pending) && 'border-violet-300/60 bg-violet-300/15 text-violet-200',
        className,
      )}
    >
      {pending ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : playing ? (
        <Pause className="size-3.5" />
      ) : (
        <Play className="size-3.5" />
      )}
      {pending ? 'Loading…' : playing ? 'Playing' : 'Preview'}
    </Button>
  )
}
