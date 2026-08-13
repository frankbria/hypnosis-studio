/**
 * Facts the policy pages state, kept in one place so they cannot drift apart —
 * a retention window quoted differently on two pages is worse than not quoting
 * it at all.
 */

/**
 * How long a finished render stays downloadable.
 *
 * Must equal `RETENTION_DAYS` in server.js, which is what actually deletes the
 * files. Nothing enforces that across the language boundary, so it is asserted
 * in test/web.claims.test.js.
 */
export const RETENTION_DAYS = 30

/** "30 days" — for prose, so the number appears once. */
export const RETENTION_WINDOW = `${RETENTION_DAYS} days`

/**
 * Everything the service records about a purchase.
 *
 * Verified against the code rather than assumed, because a privacy policy that
 * overstates or understates is worse than none:
 *   - web/index.html loads no third-party script — no analytics, no tags.
 *   - the app sets no cookie and writes nothing to localStorage/sessionStorage.
 *   - the server stores, per render: the goal and voice set chosen, progress
 *     state, the track manifest, a worker log, and the audio itself.
 *   - there are no accounts, so no name, email, or password is collected.
 */
export const DATA_WE_KEEP: ReadonlyArray<{ what: string; why: string }> = [
  {
    what: 'The program and voice you chose',
    why: 'To render your audio and to show you what you bought.',
  },
  {
    what: 'The progress of your render',
    why: 'So the page can tell you how far along it is, and what went wrong if it fails.',
  },
  {
    what: 'The audio files themselves',
    why: `So you can download them. Deleted automatically after ${RETENTION_WINDOW}.`,
  },
]

export const NO_ACCOUNT_NOTICE =
  'There are no accounts. We do not ask for your name, email address, or a password, ' +
  'and we do not have one on file for you.'

/**
 * The refund guarantee, stated once (#17).
 *
 * This string is the specification for #26, not a description of it. The issue
 * asked for the policy to be written first precisely so the refund behaviour
 * would be decided before the payment code exists — so if these two ever
 * disagree, the code is wrong, not this constant.
 *
 * `server.js` already refunds the internal ledgers (`releaseQuota`,
 * `refundBudget`) on the transition to `state: 'failed'`. #26 attaches the money
 * refund to that same transition, which is what makes this promise
 * implementable rather than aspirational.
 */
export const RENDER_FAILURE_GUARANTEE =
  'If your render fails, you are refunded in full, automatically. You do not ' +
  'have to ask, and you do not have to prove anything — the refund is issued ' +
  'by the same system that noticed the failure.'

/**
 * What the customer is told at the moment their render fails.
 *
 * The previous copy said "Nothing was charged — please try again." That was true
 * only because nothing is ever charged yet, and it becomes a false statement
 * about the customer's own money the day payment is switched on — in the one
 * screen someone reads directly after losing it.
 *
 * Phrased to be true in both worlds, so switching payment on cannot silently
 * turn it into a lie.
 */
export const RENDER_FAILED_ASSURANCE =
  'If you were charged, your refund is already on its way. You do not need to ask for it.'

/**
 * Why there is no automatic refund after a successful render.
 *
 * Stated plainly rather than buried: the audio is downloadable the moment it
 * finishes and cannot be un-delivered.
 */
export const DELIVERED_GOODS_NOTICE =
  'Once your program renders successfully, it is yours immediately — the files ' +
  'are downloadable straight away and cannot be returned. So a completed ' +
  'program is not automatically refundable.'

/**
 * The address customers are told a person reads (#18).
 *
 * Overridable at build time so production does not need a code edit:
 * set `VITE_SUPPORT_EMAIL` in the environment (see .env.example). Vite inlines
 * it, so this is baked into the bundle — changing it means rebuilding, not
 * restarting.
 *
 * This was `null` until an address existed, because #18 was filed over a
 * Contact link that pointed at `#top` and went nowhere, and inventing a
 * plausible-looking address would have recreated that bug inside the refund
 * policy. It is real now, so the contact copy renders.
 *
 * Whatever it is set to must be monitored by a person: /refunds states that a
 * person reads it.
 */
export const SUPPORT_EMAIL: string =
  import.meta.env.VITE_SUPPORT_EMAIL || 'frank.bria@pm.me'

export const NO_TRACKING_NOTICE =
  'This site loads no analytics, no advertising tags, and no third-party scripts. ' +
  'It sets no cookies and stores nothing in your browser.'

/**
 * The site now makes no third-party requests at all (#102).
 *
 * There used to be a `THIRD_PARTY_ORIGINS` list and a `FONT_NOTICE` paragraph
 * here, because index.css opened with an @import from fonts.googleapis.com and
 * NO_TRACKING_NOTICE above would otherwise have been false. The typeface is
 * self-hosted now, so the claim is true without qualification and the
 * disclosure is gone rather than merely reworded.
 *
 * test/web.claims.test.js still derives the origin list from the real
 * stylesheet and index.html. It now asserts BOTH directions: no undisclosed
 * origin, and — while there are none — no leftover disclosure copy claiming
 * otherwise.
 */
