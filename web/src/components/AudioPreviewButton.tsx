import { Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface AudioPreviewButtonProps {
  src: string
  playingSrc: string | null
  onToggle: (src: string) => void
  /** Accessible label, e.g. "Brian — narrator" */
  label: string
  className?: string
}

export function AudioPreviewButton({
  src,
  playingSrc,
  onToggle,
  label,
  className,
}: AudioPreviewButtonProps) {
  const playing = playingSrc === src
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={`${playing ? 'Pause' : 'Play'} ${label}`}
      aria-pressed={playing}
      onClick={(e) => {
        e.stopPropagation()
        onToggle(src)
      }}
      className={cn(
        'h-8 gap-2 rounded-full border-white/15 bg-white/5 px-3 text-xs text-white/70 transition-colors',
        'hover:border-violet-300/40 hover:bg-violet-300/10 hover:text-white',
        playing && 'border-violet-300/60 bg-violet-300/15 text-violet-200',
        className,
      )}
    >
      {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
      {playing ? 'Playing' : 'Preview'}
    </Button>
  )
}
