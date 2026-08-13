/**
 * An order, at the address the customer was given (#70).
 *
 * With 30-day retention and no accounts, someone needs a durable way back to
 * files they bought. Stripe Checkout already collects an email — that is the
 * account, and no login is needed.
 *
 * This resolves the token to a job and then renders ProgramPage. It does NOT
 * carry its own copy of the delivery screen: two copies is how one of them ends
 * up missing the field you just added, which this repo has been bitten by more
 * than once (#65, #66) and which #27 moved specifically to avoid.
 */
import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SUPPORT_EMAIL } from '@/lib/legal'
import ProgramPage from '@/sections/ProgramPage'
import SiteFooter from '@/components/SiteFooter'

interface Order {
  jobId: string | null
  expiresAt: string | null
}

type State =
  | { kind: 'loading' }
  | { kind: 'found'; order: Order }
  | { kind: 'missing' }
  | { kind: 'unreachable' }

function Shell({
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

export default function OrderPage({
  token,
  onHome,
  onNavigate,
}: {
  token: string
  onHome: () => void
  onNavigate: (path: string) => void
}) {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/orders/${encodeURIComponent(token)}`)
        if (cancelled) return
        if (res.status === 404) return setState({ kind: 'missing' })
        if (!res.ok) return setState({ kind: 'unreachable' })
        setState({ kind: 'found', order: (await res.json()) as Order })
      } catch {
        if (!cancelled) setState({ kind: 'unreachable' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  if (state.kind === 'loading') {
    return (
      <Shell onHome={onHome} onNavigate={onNavigate}>
        <div className="mx-auto max-w-md py-10 text-center text-sm text-white/50">
          <Loader2 className="mx-auto mb-4 size-5 animate-spin text-[#d4b87f]" />
          Finding your order…
        </div>
      </Shell>
    )
  }

  if (state.kind === 'missing' || state.kind === 'unreachable') {
    const missing = state.kind === 'missing'
    return (
      <Shell onHome={onHome} onNavigate={onNavigate}>
        <div className="mx-auto max-w-md py-10 text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-white/40">Your order</p>
          <h1 className="font-display mt-4 text-4xl leading-tight text-[#e8e6f0]">
            {missing ? "We can't find that order." : "We can't reach the studio."}
          </h1>
          <p className="mx-auto mt-4 max-w-lg text-sm leading-relaxed text-white/50">
            {missing
              ? 'This link is either wrong or very old. If you bought a program, ask us to send the link again — it goes to the address you used at checkout.'
              : 'Your order is not lost — this page is. Keep this link and open it again in a few minutes.'}
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            {missing ? (
              <Button
                size="lg"
                onClick={() => onNavigate('/resend')}
                className="bg-primary text-primary-foreground hover:bg-violet-300"
              >
                Send my link again
              </Button>
            ) : (
              <Button
                size="lg"
                onClick={() => window.location.reload()}
                className="bg-primary text-primary-foreground hover:bg-violet-300"
              >
                Try again
              </Button>
            )}
          </div>
          <p className="mt-8 text-xs leading-relaxed text-white/60">
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="text-violet-300 underline underline-offset-2"
            >
              {SUPPORT_EMAIL}
            </a>{' '}
            — a person reads it.
          </p>
        </div>
      </Shell>
    )
  }

  const { order } = state

  // Paid, but nothing was ever rendered — a studio that refused at the time
  // (#26 refunds these, and says so).
  if (!order.jobId) {
    return (
      <Shell onHome={onHome} onNavigate={onNavigate}>
        <div className="mx-auto max-w-md py-10 text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-white/40">Your order</p>
          <h1 className="font-display mt-4 text-4xl leading-tight text-[#e8e6f0]">
            This order has no program yet.
          </h1>
          <p className="mx-auto mt-4 max-w-lg text-sm leading-relaxed text-white/50">
            The studio could not start your render when you bought it. If you
            were charged, your refund is on its way automatically — you do not
            need to ask.
          </p>
          <p className="mt-8 text-xs leading-relaxed text-white/60">
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="text-violet-300 underline underline-offset-2"
            >
              {SUPPORT_EMAIL}
            </a>{' '}
            — a person reads it.
          </p>
        </div>
      </Shell>
    )
  }

  return (
    <ProgramPage
      jobId={order.jobId}
      expiresAt={order.expiresAt}
      onHome={onHome}
      onNavigate={onNavigate}
    />
  )
}
