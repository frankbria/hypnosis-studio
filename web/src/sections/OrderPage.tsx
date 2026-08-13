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
  /** Seen a 404, still expecting the order to appear. See the poll below. */
  | { kind: 'confirming' }
  | { kind: 'found'; order: Order }
  | { kind: 'missing' }
  | { kind: 'unreachable' }

/**
 * How long to keep expecting an order that is not there yet.
 *
 * Stripe redirects the browser the moment payment completes, but the webhook
 * that writes the order is a SEPARATE, asynchronous delivery — so this page can
 * be open before the order exists. Treating that 404 as "wrong link" tells
 * someone who has just paid that their link is bad, on the first screen they
 * see afterwards.
 *
 * Deliveries normally arrive in under a second; thirty is a wide margin for a
 * screen nobody should be looking at for long.
 */
const CONFIRM_WINDOW_MS = 30000
const CONFIRM_POLL_MS = 1500

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
      const deadline = Date.now() + CONFIRM_WINDOW_MS
      for (;;) {
        if (cancelled) return
        try {
          const res = await fetch(`/api/orders/${encodeURIComponent(token)}`)
          if (cancelled) return
          if (res.ok) {
            setState({ kind: 'found', order: (await res.json()) as Order })
            return
          }
          if (res.status !== 404) {
            setState({ kind: 'unreachable' })
            return
          }
          // Not there YET. The webhook may still be in flight.
          if (Date.now() >= deadline) {
            setState({ kind: 'missing' })
            return
          }
          setState({ kind: 'confirming' })
        } catch {
          if (cancelled) return
          setState({ kind: 'unreachable' })
          return
        }
        await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  if (state.kind === 'loading' || state.kind === 'confirming') {
    return (
      <Shell onHome={onHome} onNavigate={onNavigate}>
        <div className="mx-auto max-w-md py-10 text-center text-sm text-white/50">
          <Loader2 className="mx-auto mb-4 size-5 animate-spin text-[#d4b87f]" />
          {state.kind === 'confirming'
            ? 'Confirming your payment…'
            : 'Finding your order…'}
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
            {missing ? "We can't confirm that order yet." : "We can't reach the studio."}
          </h1>
          <p className="mx-auto mt-4 max-w-lg text-sm leading-relaxed text-white/50">
            {missing
              ? 'If you have just paid, the studio may still be confirming it — wait a moment and reload this page. Otherwise the link may be wrong or very old, and we can send it to you again at the address you used at checkout.'
              : 'Your order is not lost — this page is. Keep this link and open it again in a few minutes.'}
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            {missing ? (
              <>
                <Button
                  size="lg"
                  onClick={() => window.location.reload()}
                  className="bg-primary text-primary-foreground hover:bg-violet-300"
                >
                  Reload
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  onClick={() => onNavigate('/resend')}
                  className="border-white/15 bg-transparent text-white/75 hover:border-violet-300/40 hover:bg-violet-300/10 hover:text-white"
                >
                  Send my link again
                </Button>
              </>
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
