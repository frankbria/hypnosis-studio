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
export type CheckoutFailure =
  | 'disabled'
  | 'unavailable'
  | 'busy'
  | 'at_capacity'
  | 'rejected'
  | 'network'

const FAILURE_BY_CODE: Record<string, CheckoutFailure> = {
  checkout_disabled: 'disabled',
  checkout_unavailable: 'unavailable',
  rate_limited: 'busy',
  temporarily_unavailable: 'at_capacity',
  goal_in_production: 'rejected',
  bad_voice_set: 'rejected',
}

/**
 * Every one of these happens before a Checkout Session exists, so no charge has
 * been made and none can have been. Said plainly rather than left to inference
 * (#30) — this is a payment screen, and silence about money on a payment screen
 * is what people assume the worst about.
 */
export const CHECKOUT_MESSAGE: Record<CheckoutFailure, string> = {
  disabled: 'Checkout is not open yet. Nothing was charged.',
  unavailable:
    "We couldn't reach the payment provider. Please try again in a moment — "
    + 'nothing was charged.',
  // The server's own cap, not the provider's. "We couldn't reach Stripe" would
  // send the customer to check a connection that is working fine.
  busy: 'The studio is busy right now. Please try again in a minute — nothing was charged.',
  // The studio cannot render this program at all at the moment (#25). Said
  // plainly, and without the "nothing has been charged" reassurance the other
  // messages carry — nothing was charged because nothing was ever attempted,
  // and volunteering it here invites the question.
  at_capacity:
    'The studio is at capacity and is not taking new programs right now. ' +
    'Please try again later — nothing was charged.',
  rejected: 'That program is not available to buy. Nothing was charged.',
  network:
    "We couldn't reach the studio. Please check your connection and try again — "
    + 'nothing was charged.',
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
