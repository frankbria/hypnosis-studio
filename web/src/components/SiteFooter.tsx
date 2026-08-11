import { Moon } from 'lucide-react'

/**
 * One footer for every surface.
 *
 * #16 requires the policy links on every page *including the wizard*, and there
 * were three separate footers: the landing had a Disclaimer link and a Contact
 * link pointing at `#top`, the door chooser had no links at all, and the wizard
 * had only the healing notice. Three copies is how one of them ends up without
 * the link the law wants on it.
 */
export default function SiteFooter({
  onHome,
  onNavigate,
  className = '',
}: {
  onHome?: () => void
  /** Client-side navigation to a policy page; falls back to a plain link. */
  onNavigate?: (path: string) => void
  className?: string
}) {
  const go = (path: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!onNavigate) return
    // Let the browser handle modified clicks — a policy page should still be
    // openable in a new tab.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    onNavigate(path)
  }

  return (
    <footer className={`border-t border-white/5 px-6 py-10 ${className}`}>
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 sm:flex-row">
        <button
          type="button"
          onClick={onHome}
          className="flex items-center gap-3 transition-colors hover:text-white"
          aria-label="Hypnosis Studio home"
        >
          <Moon className="size-4 text-violet-300/70" />
          <span className="text-xs font-medium tracking-[0.3em] text-white/70">
            HYPNOSIS&nbsp;STUDIO
          </span>
        </button>

        <p className="text-xs text-white/40">© 2026 Hypnosis Studio</p>

        <nav className="flex items-center gap-6 text-xs text-white/55">
          <a href="/terms" onClick={go('/terms')} className="transition-colors hover:text-white">
            Terms
          </a>
          <a href="/privacy" onClick={go('/privacy')} className="transition-colors hover:text-white">
            Privacy
          </a>
        </nav>
      </div>
    </footer>
  )
}
