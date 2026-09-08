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
import type { ReadyTrack } from '@/sections/ProgramPage'
import SiteFooter from '@/components/SiteFooter'

interface Order {
  jobId: string | null
  expiresAt: string | null
  /**
   * The catalog program this order bought (#59), or null for a rendered one.
   *
   * A catalog purchase is fulfilled at the moment it is paid for: there is no
   * render, so no `jobId` is ever written. The two must be told apart here,
   * because "no job" is a *success* for one of them and a failure for the other.
   */
  catalog: string | null
  /** Already signed and ready to download, for a catalog order. Empty past the window. */
  tracks: ReadyTrack[]
  voiceSet: string | null
  /**
   * When the signed links in `tracks` stop working — minutes to an hour, and not
   * to be confused with `expiresAt`, which is the customer's 30-day access.
   */
  linksExpireAt: string | null
  /** Why there are no tracks, when there are none — 'expired' or 'withdrawn'. */
  unavailable: string | null
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

/**
 * The order as the page needs it, whatever the server sent.
 *
 * A job order carries no `catalog`/`tracks` at all, and the catalog branch below
 * reads them — defaulting here keeps that decision in one place instead of
 * spreading optional chaining through the render. Shared with the refresh below
 * so the two paths cannot drift.
 */
function normalizeOrder(body: Partial<Order>): Order {
  return {
    jobId: body.jobId ?? null,
    expiresAt: body.expiresAt ?? null,
    catalog: body.catalog ?? null,
    tracks: body.tracks ?? [],
    voiceSet: body.voiceSet ?? null,
    linksExpireAt: body.linksExpireAt ?? null,
    unavailable: body.unavailable ?? null,
  }
}

/** Re-mint this long before the links actually expire. */
const LINK_REFRESH_MARGIN_MS = 60000

/**
 * Never re-mint faster than this, whatever the box's TTL is.
 *
 * Without a floor, a `CATALOG_LINK_TTL_MS` at or below the margin above makes
 * the delay zero: the timer fires at once, the refresh brings a new expiry, that
 * changes this effect's dependencies, and it schedules another zero-delay
 * timer — one fetch and one re-render per tick for as long as the tab is open.
 *
 * With a TTL that short the links cannot be kept continuously fresh by anyone,
 * so the choice is between a briefly stale link and a hot loop against the
 * server. The stale link is recoverable: the refocus refresh below and a reload
 * both fix it.
 */
const MIN_LINK_REFRESH_MS = 30000

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
            setState({
              kind: 'found',
              order: normalizeOrder((await res.json()) as Partial<Order>),
            })
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

  // A catalog order's download links are signed and expire in about an hour
  // (CATALOG_LINK_TTL_MS), but this page tells the customer their access runs
  // for 30 days — so a tab left open outlives its own links and every download
  // button starts refusing, blaming a link the customer did nothing to.
  //
  // The order route mints fresh links on every fetch, and the durable capability
  // is this page's own URL, so asking again when the page comes back to the
  // foreground is the whole fix. Only for catalog orders: a job order's file
  // routes carry no signature and never go stale.
  const catalogKey = state.kind === 'found' ? state.order.catalog : null
  const linksExpireAt = state.kind === 'found' ? state.order.linksExpireAt : null
  useEffect(() => {
    if (!catalogKey) return

    let cancelled = false
    const refresh = () => {
      void (async () => {
        try {
          const res = await fetch(`/api/orders/${encodeURIComponent(token)}`)
          if (cancelled || !res.ok) return
          setState({
            kind: 'found',
            order: normalizeOrder((await res.json()) as Partial<Order>),
          })
        } catch {
          // Keep the links we already have — stale ones may still work, and a
          // failed refresh is not worth replacing a working page with an error.
        }
      })()
    }

    // Scheduled off the server's own expiry rather than a TTL guessed here, so
    // shortening CATALOG_LINK_TTL_MS on the box cannot leave this page holding
    // dead links. Each refresh brings a new expiry, which re-runs this effect
    // and schedules the next one.
    const due = linksExpireAt ? Date.parse(linksExpireAt) : NaN
    const wait = Number.isFinite(due)
      ? Math.max(MIN_LINK_REFRESH_MS, due - Date.now() - LINK_REFRESH_MARGIN_MS)
      : null
    const timer = wait === null ? null : setTimeout(refresh, wait)

    // A backgrounded tab throttles timers, so the one case the timer alone
    // misses is exactly the common one: left open, come back tomorrow.
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [catalogKey, linksExpireAt, token])

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

  // A catalog purchase (#59): no job, and none was ever needed. The files
  // already exist and the order carries signed links to them, so this is the
  // delivery screen — the same one a finished render gets.
  //
  // This branch has to come first. Before #137 there was only the test below,
  // and a catalog order fell into it: the one screen a paying customer sees told
  // them the studio could not start their render and a refund was on its way,
  // with their downloads sitting unread in the same response.
  if (order.catalog) {
    return (
      <ProgramPage
        jobId={null}
        delivered={{
          tracks: order.tracks,
          voiceSet: order.voiceSet,
          unavailable: order.unavailable,
        }}
        expiresAt={order.expiresAt}
        onHome={onHome}
        onNavigate={onNavigate}
      />
    )
  }

  // Paid, but nothing was ever rendered — a studio that refused at the time
  // (#26 refunds these, and says so).
  if (!order.jobId && !order.catalog) {
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
