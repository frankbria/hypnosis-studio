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

export const NO_TRACKING_NOTICE =
  'This site loads no analytics, no advertising tags, and no third-party scripts. ' +
  'It sets no cookies and stores nothing in your browser.'

/**
 * The one third-party request the site actually makes.
 *
 * `web/src/index.css` opens with an `@import` from fonts.googleapis.com, and
 * Vite leaves that in the emitted CSS — so it is a request every visitor's
 * browser makes at runtime, disclosing their IP address and User-Agent to
 * Google. Saying "no tracking" while making it is the kind of overstatement
 * this file exists to prevent.
 *
 * Disclosed rather than quietly omitted. Removing the request entirely by
 * self-hosting the font is #102, and this constant goes away when it lands.
 *
 * `THIRD_PARTY_ORIGINS` is asserted against the real stylesheet in
 * test/web.claims.test.js, so a new third-party host cannot be added without
 * either disclosing it here or failing the build.
 */
export const THIRD_PARTY_ORIGINS = ['fonts.googleapis.com'] as const

export const FONT_NOTICE =
  'One exception, so this page is not overstating the case: the site loads its ' +
  'display typeface from Google Fonts, which means your browser requests a ' +
  'stylesheet from Google and Google sees your IP address. We receive nothing ' +
  'from that request and it carries nothing about you or your purchase. We are ' +
  'moving to a self-hosted font to remove it.'
