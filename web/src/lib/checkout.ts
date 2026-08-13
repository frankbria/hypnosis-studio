/**
 * Stripe Checkout, from the browser's side (#22).
 *
 * There is deliberately no price in this file. The server decides the amount
 * and this module cannot influence it — sending one would be ignored, and a
 * server-side test asserts exactly that against every field name a tampered
 * request would use. The `$39` in `data.ts` is display text, pinned to the
 * server's number by a test rather than sent to it.
 */

/**
 * Why a checkout could not start, in the caller's terms.
 *
 * `disabled` is the normal state today: no `STRIPE_SECRET_KEY` is set, because
 * a completed payment does not start a render until #23 ships. It is a
 * different sentence from `unavailable` (Stripe is configured and refused), and
 * showing the customer the wrong one of those is how a support thread starts.
 */
export type CheckoutFailure = 'disabled' | 'unavailable' | 'rejected' | 'network'

const FAILURE_BY_CODE: Record<string, CheckoutFailure> = {
  checkout_disabled: 'disabled',
  checkout_unavailable: 'unavailable',
  goal_in_production: 'rejected',
  bad_voice_set: 'rejected',
}

export const CHECKOUT_MESSAGE: Record<CheckoutFailure, string> = {
  disabled: 'Checkout is not open yet.',
  unavailable: "We couldn't reach the payment provider. Please try again in a moment.",
  rejected: 'That program is not available to buy.',
  network: "We couldn't reach the studio. Please check your connection and try again.",
}

/**
 * Ask the server for a Checkout Session and send the browser to it.
 *
 * Resolves to `null` only in the case where it never resolves at all in
 * practice — the redirect has been issued and the page is going away. Any
 * failure resolves to a reason instead, so the caller always has something
 * honest to render.
 */
export async function startCheckout(
  goal: string,
  voiceSet: string,
): Promise<CheckoutFailure | null> {
  let res: Response
  try {
    res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal, voiceSet }),
    })
  } catch {
    return 'network'
  }

  let body: { url?: string; error?: string } = {}
  try {
    body = await res.json()
  } catch {
    // A non-JSON body from a proxy or an error page. Fall through — the status
    // is still meaningful and `url` will be absent.
  }

  if (!res.ok) return FAILURE_BY_CODE[body.error ?? ''] ?? 'unavailable'
  if (!body.url) return 'unavailable'

  window.location.href = body.url
  return null
}
