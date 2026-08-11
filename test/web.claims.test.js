// Claims the site is not allowed to make.
//
// These are legal/marketing constraints, not implementation details: a tier that
// promises a subscription, a queue, a human, or lifetime access is describing
// something that does not exist, and the pricing page is where that exposure is
// sharpest (#13, #63, #21).
//
// Source-level assertions because web/ has no test runner and adding one is not
// this issue's job. That is a real limitation — these check the text, not the
// rendered page — but the failures they guard against are textual.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web', 'src');

/** Every source file we author, excluding vendored shadcn components. */
function sourceFiles(dir = WEB, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (p.endsWith(path.join('components', 'ui'))) continue;
      sourceFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** Source with `//` and `/* *​/` comments removed, so a comment naming a banned
 *  claim (to explain why it is banned) does not trip the check. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const FORBIDDEN = [
  [/keep it for life|for life\b/i, 'implies permanent access; retention is 30 days (#21)'],
  [/lifetime/i, 'lifetime access does not exist; retention is 30 days (#21)'],
  [/priority (render )?queue/i, 'there is no queue — the server returns 409 busy (#63)'],
  [/1:1|one[- ]to[- ]one|script consultation/i, 'promises a human; there is not one (#63)'],
  [/per month|\/month|monthly subscription/i, 'no recurring billing exists (#13)'],
  [/full library access/i, 'there is no library (#13)'],
];

test('no page claims something the studio cannot deliver', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const code = codeOnly(fs.readFileSync(file, 'utf8'));
    for (const [pattern, why] of FORBIDDEN) {
      const m = code.match(pattern);
      if (m) offenders.push(`${path.relative(WEB, file)}: "${m[0]}" — ${why}`);
    }
  }
  assert.deepStrictEqual(offenders, [], `forbidden claims on the site:\n${offenders.join('\n')}`);
});

// --------------------------------------------------------------------------
// The pricing ladder
// --------------------------------------------------------------------------

const DATA = fs.readFileSync(path.join(WEB, 'lib', 'data.ts'), 'utf8');
const LANDING = fs.readFileSync(path.join(WEB, 'sections', 'Landing.tsx'), 'utf8');

/**
 * Just the PRICING array.
 *
 * `available` is also a field on GOALS, so counting it across the whole file
 * mixes catalogue titles in with pricing tiers — which is how the first version
 * of this test reported six purchasable tiers.
 */
const PRICING_BLOCK = (() => {
  const start = DATA.indexOf('export const PRICING');
  assert.ok(start >= 0, 'PRICING array not found');
  const end = DATA.indexOf('\n]', start);
  assert.ok(end > start, 'could not find the end of PRICING');
  return DATA.slice(start, end);
})();

test('the pricing ladder is the agreed one', () => {
  // marketing-plan.md §3, including the later decision that moved the anchor
  // from $1,499/five programs to $649/two — at $649 five programs invert the
  // tier into a discount and it stops being an anchor.
  for (const price of ["'$39'", "'$129'", "'$649'"]) {
    assert.ok(PRICING_BLOCK.includes(price), `pricing tier ${price} is missing`);
  }
  assert.ok(!PRICING_BLOCK.includes("'$1,499'"), 'the superseded $1,499 anchor is back');
  assert.ok(!PRICING_BLOCK.includes("'$19'"), 'the subscription tier is back');
  assert.ok(!PRICING_BLOCK.includes("'$99'"), 'the premium tier is back');
});

test('the anchor still costs more than its parts', () => {
  // $649 against $195 of catalog plus two personalized at $129 = $453. If a
  // future edit adds programs without moving the price, the tier inverts into
  // the best deal on the page and stops anchoring anything.
  const anchor = 649;
  const piecemeal = 195 + 2 * 129;
  assert.ok(anchor > piecemeal * 1.25,
    `the anchor is only ${((anchor / piecemeal - 1) * 100).toFixed(0)}% over piecemeal`);
});

test('every tier declares whether it can be bought', () => {
  const tiers = PRICING_BLOCK.split('name:').slice(1);
  assert.strictEqual(tiers.length, 3, 'expected exactly three pricing tiers');
  for (const t of tiers) {
    assert.match(t, /available: (true|false)/,
      'a tier does not say whether it is purchasable');
  }
});

test('only a purchasable tier gets a payment CTA', () => {
  // The launch gate from #13: whatever is live on the pricing page must be
  // purchasable and deliverable on day one. Tiers that are not stay visible —
  // the ladder is what makes $39 read as the easy decision — but must not offer
  // a way to pay.
  assert.match(LANDING, /tier\.available \?/,
    'the pricing CTA is not gated on availability');
  const gate = LANDING.indexOf('tier.available ?');
  const cta = LANDING.indexOf('onClick={onStart}', gate);
  const elseArm = LANDING.indexOf(') : (', gate);
  assert.ok(cta > gate && cta < elseArm,
    'onStart is not inside the available branch — an unbuyable tier can start a purchase');
});

test('exactly one tier is purchasable today', () => {
  const available = (PRICING_BLOCK.match(/available: true/g) || []).length;
  assert.strictEqual(available, 1,
    'the launch decision was one buyable tier; changing that is a business '
    + 'decision, not a refactor');
});

// --------------------------------------------------------------------------
// The advertised program must match the engine that renders it
// --------------------------------------------------------------------------

const ENGINE_TRACKS = (() => {
  // Parse the TRACKS table out of render_program.py. Nothing enforces this
  // coupling across the language boundary, so the test is the enforcement:
  // #14 (durations) and #15 (phase names) were both silent drift between these
  // two tables.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'engine', 'render_program.py'), 'utf8');
  const from = src.indexOf('TRACKS = [');
  const block = src.slice(from, src.indexOf(']', from));
  const rows = [...block.matchAll(/"total_s":\s*(\d+),\s*"phase":\s*"(\w+)"/g)];
  assert.strictEqual(rows.length, 4, 'could not parse the engine TRACKS table');
  return rows.map((m) => ({ totalS: Number(m[1]), phase: m[2] }));
})();

const DECLARED = [...DATA.matchAll(/minimumSeconds: (\d+)/g)].map((m) => Number(m[1]));

test('advertised track lengths are the engine minimums, not invented', () => {
  // The old values (14:20 / 13:45 / 14:55 / 13:10 = 56:10) had no relationship
  // to the engine at all.
  assert.deepStrictEqual(DECLARED, ENGINE_TRACKS.map((t) => t.totalS),
    'the advertised minimums no longer match engine/render_program.py TRACKS');
});

test('no advertised length exceeds what the engine guarantees', () => {
  // The direction that matters: the assembler renders at least total_s, so
  // quoting the floor can only under-promise. Over-promising at the moment of
  // purchase is the misrepresentation #14 was opened about.
  DECLARED.forEach((seconds, i) => {
    assert.ok(seconds <= ENGINE_TRACKS[i].totalS,
      `track ${i + 1} advertises ${seconds}s against an engine floor of ${ENGINE_TRACKS[i].totalS}s`);
  });
});

test('track IV is not advertised at roughly double its length', () => {
  assert.strictEqual(DECLARED[3], 420, 'track IV should be the 420 s the engine renders');
  assert.ok(DECLARED[3] < DECLARED[0], 'the short integration track is not shorter than track I');
});

test('phase names match the engine, which is what the customer receives', () => {
  // The delivery screen renders the manifest's phase. When the two disagreed the
  // badge visibly changed between what was bought and what arrived (#15).
  const declared = [...DATA.matchAll(/phase: '(\w+)', minimumSeconds/g)].map((m) => m[1]);
  assert.deepStrictEqual(declared, ENGINE_TRACKS.map((t) => t.phase),
    'the frontend phase names have drifted from engine/render_program.py');
});

test('the phase union admits exactly the engine names', () => {
  // ReadyTrack.phase was typed `string`, which is why the compiler never noticed
  // the drift. The union is the guard now, so it has to stay in step.
  const union = DATA.match(/export type TrackPhase = ([^\n]+)/);
  assert.ok(union, 'TrackPhase union not found');
  const names = [...union[1].matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(names, [...new Set(ENGINE_TRACKS.map((t) => t.phase))].sort(),
    'TrackPhase does not match the phases the engine writes');
});

// --------------------------------------------------------------------------
// Policy pages (#16) and the retention window (#21)
// --------------------------------------------------------------------------

// Comments stripped: the popstate handler is *described* in a comment that
// mentions "popstate", so slicing raw source found the prose first and produced
// an empty range that matched nothing. Fourth time this pattern has bitten in
// this repo — see the conftest fixture on the Python side.
const APP = codeOnly(fs.readFileSync(path.join(WEB, 'App.tsx'), 'utf8'));
const LEGAL_LIB = fs.readFileSync(path.join(WEB, 'lib', 'legal.ts'), 'utf8');
const FOOTER = fs.readFileSync(path.join(WEB, 'components', 'SiteFooter.tsx'), 'utf8');

test('/terms and /privacy are real routes', () => {
  for (const route of ['/terms', '/privacy']) {
    assert.ok(APP.includes(`'${route}'`), `${route} is not routed`);
  }
});

test('policy routes are resolved on back/forward as well as first load', () => {
  // Both the initial state and the popstate handler have to consult the legal
  // path, or the browser's back button lands on a page that still thinks it is
  // showing the door chooser.
  const pop = APP.slice(APP.indexOf('const onPop'), APP.indexOf('popstate'));
  assert.match(pop, /legalFromPath/, 'popstate does not resolve policy routes');
  assert.match(APP, /useState<LegalPageId \| null>\(\(\) =>\s*legalFromPath/,
    'the initial route does not resolve policy paths, so direct navigation fails');
});

test('the policy links are in the shared footer, not one page', () => {
  // #16 wants them on every page including the wizard. There were three separate
  // footers, which is how one ends up without the link.
  assert.match(FOOTER, /href="\/terms"/);
  assert.match(FOOTER, /href="\/privacy"/);
  for (const surface of ['Landing.tsx', 'DoorChooser.tsx', 'Wizard.tsx']) {
    const src = fs.readFileSync(path.join(WEB, 'sections', surface), 'utf8');
    assert.match(src, /<SiteFooter/, `${surface} does not render the shared footer`);
  }
});

test('the policy links survive a modified click', () => {
  // A policy page should still open in a new tab; intercepting every click would
  // break that, and an <a href> that preventDefaults unconditionally is a link
  // in name only.
  assert.match(FOOTER, /metaKey \|\| event\.ctrlKey/,
    'modified clicks are intercepted, so the links cannot be opened in a new tab');
});

test('the advertised retention window matches what actually deletes the files', () => {
  // server.js is what removes them; the site quoting a different number is the
  // kind of promise that only surfaces when a customer comes back on day 31.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const m = server.match(/RETENTION_DAYS \|\| '(\d+)'/);
  assert.ok(m, 'could not find the server retention default');
  const declared = LEGAL_LIB.match(/RETENTION_DAYS = (\d+)/);
  assert.ok(declared, 'the site does not declare a retention window');
  assert.strictEqual(declared[1], m[1],
    `the site says ${declared[1]} days; the sweep deletes after ${m[1]}`);
});

test('the retention number appears once, not scattered through prose', () => {
  // Two pages quoting it separately is how they drift.
  const legalPage = fs.readFileSync(path.join(WEB, 'sections', 'Legal.tsx'), 'utf8');
  assert.ok(!/\b30 days\b/.test(codeOnly(legalPage)),
    'the retention window is hard-coded in the policy prose instead of using RETENTION_WINDOW');
});

test('the policy pages say what is collected and how long it is kept', () => {
  const legalPage = fs.readFileSync(path.join(WEB, 'sections', 'Legal.tsx'), 'utf8');
  assert.match(legalPage, /RETENTION_WINDOW/, 'no retention window on the policy pages');
  assert.match(legalPage, /DATA_WE_KEEP/, 'the privacy page does not list what is stored');
  assert.match(legalPage, /DISCLAIMER/, 'the non-medical stance is not carried on the policy pages');
});

// --------------------------------------------------------------------------
// Safety copy must be readable (#19) and the seizure warning must stand alone (#65)
// --------------------------------------------------------------------------

/**
 * WCAG 2.1 contrast ratio for white at `alpha` composited on `bg`.
 *
 * Recomputed here rather than trusting the numbers in the issue, because the
 * whole point of the issue is that a number was wrong.
 */
function contrastOnDark(alpha, bg = [0x0b, 0x0b, 0x12]) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const fg = bg.map((c) => alpha * 255 + (1 - alpha) * c);
  const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** The `text-white/NN` on the element rendering `{TOKEN}`. */
function opacityRendering(src, token) {
  const at = src.indexOf(`{${token}}`);
  if (at < 0) return null;
  // The className sits on the opening tag, just above the interpolation.
  const before = src.slice(Math.max(0, at - 400), at);
  const matches = [...before.matchAll(/text-white\/(\d+)/g)];
  return matches.length ? Number(matches[matches.length - 1][1]) / 100 : null;
}

const SAFETY_TOKENS = ['DISCLAIMER', 'HEALING_NONMEDICAL', 'SAFETY_WARNING'];

test('the contrast helper agrees with the measured values in the issue', () => {
  // Sanity-check the helper itself before relying on it: the issue measured
  // white/40 at 3.81 and white/45 at 4.52.
  assert.ok(Math.abs(contrastOnDark(0.4) - 3.81) < 0.05, `white/40 = ${contrastOnDark(0.4)}`);
  assert.ok(Math.abs(contrastOnDark(0.45) - 4.52) < 0.05, `white/45 = ${contrastOnDark(0.45)}`);
});

test('every rendering of safety copy meets WCAG AA', () => {
  const failures = [];
  for (const surface of ['Landing.tsx', 'Wizard.tsx']) {
    const src = fs.readFileSync(path.join(WEB, 'sections', surface), 'utf8');
    for (const token of SAFETY_TOKENS) {
      let from = 0;
      for (;;) {
        const at = src.indexOf(`{${token}}`, from);
        if (at < 0) break;
        const alpha = opacityRendering(src.slice(0, at + token.length + 2), token);
        if (alpha !== null && contrastOnDark(alpha) < 4.5) {
          failures.push(`${surface}: ${token} at white/${alpha * 100} = ${contrastOnDark(alpha).toFixed(2)}:1`);
        }
        from = at + 1;
      }
    }
  }
  assert.deepStrictEqual(failures, [],
    `safety copy below WCAG AA:\n${failures.join('\n')}`);
});

test('safety copy is not left on a 0.01 margin', () => {
  // white/45 is 4.51:1 — passing by a hundredth. For the most legally sensitive
  // text in the product, a rounding change or a background tweak should not be
  // able to drop it below the line.
  for (const surface of ['Landing.tsx', 'Wizard.tsx']) {
    const src = fs.readFileSync(path.join(WEB, 'sections', surface), 'utf8');
    for (const token of SAFETY_TOKENS) {
      const alpha = opacityRendering(src, token);
      if (alpha === null) continue;
      assert.ok(contrastOnDark(alpha) >= 5.0,
        `${surface}: ${token} at ${contrastOnDark(alpha).toFixed(2)}:1 has no headroom`);
    }
  }
});

test('the seizure warning is its own line, not a clause in a paragraph', () => {
  const data = fs.readFileSync(path.join(WEB, 'lib', 'data.ts'), 'utf8');
  assert.match(data, /export const SAFETY_WARNING/,
    'the warning does not exist independently of the general disclaimer');
  const warning = data.slice(data.indexOf('export const SAFETY_WARNING'), data.indexOf('export const DISCLAIMER'));
  assert.match(warning, /seizure/i, 'the standalone warning does not mention seizures');
  assert.match(warning, /photosensitiv/i, 'the standalone warning does not mention photosensitivity');
});

test('the seizure warning appears before purchase, not only in the footer', () => {
  const wizard = fs.readFileSync(path.join(WEB, 'sections', 'Wizard.tsx'), 'utf8');
  assert.match(wizard, /\{SAFETY_WARNING\}/,
    'the purchase flow never shows the standalone safety warning');
  // Above the consent checkbox, so it is not buried inside the thing being
  // consented to — which is what it was.
  assert.ok(wizard.indexOf('{SAFETY_WARNING}') < wizard.indexOf('{DISCLAIMER}'),
    'the warning appears after the consent label rather than before it');
});

test('every door shows the seizure warning, not just the one it was added to', () => {
  // Landing.tsx holds two independent door components. The warning was first
  // added only to PerformanceLanding, so /healing rendered no seizure warning at
  // all — and a file-scoped `LANDING.includes('SAFETY_WARNING')` passed anyway,
  // because the constant *was* in the file. A browser on /healing found it.
  //
  // So assert per component. Each door either renders the warning itself or
  // renders a shared component that does.
  const src = codeOnly(LANDING);

  // Each component's body runs to the next top-level function, NOT to the next
  // *door*. Bounding by door let HealingLanding — the last one — run to EOF and
  // swallow the `Landing` dispatcher below it, which renders
  // `<PerformanceLanding`. The check then "passed" by finding the other door's
  // tag inside healing's slice, and stayed green when the fix was reverted.
  //
  // The `export (default )?` alternation matters for the same reason: the
  // dispatcher is `export default function Landing`, so a bare /^function/
  // does not treat it as a boundary and healing's slice runs to EOF anyway.
  const fns = [...src.matchAll(/^(?:export\s+(?:default\s+)?)?function (\w+)/gm)].map((m, i, all) => ({
    name: m[1],
    body: src.slice(m.index, all[i + 1] ? all[i + 1].index : src.length),
  }));

  const carriers = fns
    .filter((fn) => /\{SAFETY_WARNING\}/.test(fn.body))
    .map((fn) => fn.name);
  assert.ok(carriers.length > 0, 'no component in Landing.tsx renders SAFETY_WARNING');

  for (const door of ['PerformanceLanding', 'HealingLanding']) {
    const fn = fns.find((f) => f.name === door);
    assert.ok(fn, `${door} no longer exists — update this test`);

    const direct = /\{SAFETY_WARNING\}/.test(fn.body);
    const viaShared = carriers.some((c) => c !== door && fn.body.includes(`<${c}`));
    assert.ok(direct || viaShared,
      `${door} never reaches the seizure warning — that door ships without it`);
  }
});

test('the general disclaimer still exists alongside it', () => {
  // #65 wants the disclaimer kept, just no longer the sole carrier.
  const data = fs.readFileSync(path.join(WEB, 'lib', 'data.ts'), 'utf8');
  assert.match(data, /export const DISCLAIMER/);
  assert.match(data, /not medical or psychological treatment/i);
});

// --------------------------------------------------------------------------
// The privacy page must not overstate (#21)
// --------------------------------------------------------------------------

test('every third-party origin the site actually requests is disclosed', () => {
  // The privacy copy says "no analytics, no advertising tags, no third-party
  // scripts". That was written from reading index.html, which is clean — but
  // index.css opens with an @import from fonts.googleapis.com, and Vite leaves
  // it in the emitted CSS. So every visitor's browser requests a stylesheet
  // from Google, disclosing their IP, while the page said nothing left the box.
  //
  // Assert against the real sources rather than against a remembered audit, so
  // adding a CDN cannot silently falsify the policy.
  const sources = ['index.css', path.join('..', 'index.html')]
    .map((f) => path.join(WEB, f))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');

  const found = [...new Set(
    [...sources.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()),
  )].filter((h) => !h.endsWith('hypnosisstudio.com') && h !== 'localhost');

  const legal = fs.readFileSync(path.join(WEB, 'lib', 'legal.ts'), 'utf8');
  const declared = [...legal.matchAll(/'([a-z0-9.-]+\.[a-z]{2,})'/gi)].map((m) =>
    m[1].toLowerCase(),
  );

  for (const host of found) {
    assert.ok(declared.includes(host),
      `${host} is requested at runtime but not declared in THIRD_PARTY_ORIGINS — ` +
      'the privacy page claims no third-party requests');
  }

  // And a declared origin must actually be described in prose, not just listed
  // in an array nobody renders.
  if (found.length > 0) {
    assert.match(legal, /export const FONT_NOTICE/,
      'a third-party request exists with no disclosure copy');
    const page = fs.readFileSync(path.join(WEB, 'sections', 'Legal.tsx'), 'utf8');
    assert.match(codeOnly(page), /\{FONT_NOTICE\}/,
      'the disclosure exists as a constant but the privacy page never renders it');
  }
});

// --------------------------------------------------------------------------
// The refund policy (#17)
// --------------------------------------------------------------------------

const LEGAL_TS = () => fs.readFileSync(path.join(WEB, 'lib', 'legal.ts'), 'utf8');
const LEGAL_TSX = () => fs.readFileSync(path.join(WEB, 'sections', 'Legal.tsx'), 'utf8');
const WIZARD = () => fs.readFileSync(path.join(WEB, 'sections', 'Wizard.tsx'), 'utf8');

test('the refund page is reachable from the footer and the review step', () => {
  // #17's criteria name both surfaces. The footer is shared, so the link must be
  // in SiteFooter rather than on one page.
  const footer = fs.readFileSync(path.join(WEB, 'components', 'SiteFooter.tsx'), 'utf8');
  assert.match(footer, /href="\/refunds"/,
    'the refund policy is not linked from the shared footer');

  const app = codeOnly(fs.readFileSync(path.join(WEB, 'App.tsx'), 'utf8'));
  assert.match(app, /'\/refunds':\s*'refunds'/,
    '/refunds is not routed — the footer link would 404 into the door chooser');

  assert.match(codeOnly(WIZARD()), /onNavigate\('\/refunds'\)/,
    'the review step does not link the refund policy');
});

test('the render-failure guarantee is stated once and rendered', () => {
  // It is the specification for #26, so it must have exactly one home. Two
  // copies is how the page and the code end up promising different things.
  const legal = LEGAL_TS();
  assert.match(legal, /export const RENDER_FAILURE_GUARANTEE/,
    'the guarantee is not a named constant');
  assert.match(codeOnly(LEGAL_TSX()), /\{RENDER_FAILURE_GUARANTEE\}/,
    'the refund page never renders the guarantee');
  assert.match(codeOnly(WIZARD()), /\{RENDER_FAILURE_GUARANTEE\}/,
    'the review step never states the guarantee before purchase');

  const body = legal.slice(legal.indexOf('export const RENDER_FAILURE_GUARANTEE'));
  const text = body.slice(0, body.indexOf('\n\n'));
  assert.match(text, /automatic/i, 'the guarantee does not say the refund is automatic');
  assert.match(text, /in full/i, 'the guarantee does not say the refund is full');
});

test('no page tells a customer to contact an address that does not exist', () => {
  // #18 exists because the old Contact link pointed at `#top`. Recreating that
  // inside the refund policy would be the worst possible place for it, so the
  // contact copy is gated on SUPPORT_EMAIL actually being set.
  const legal = LEGAL_TS();
  const declared = /export const SUPPORT_EMAIL[^=]*=\s*null/.test(legal);
  if (!declared) return; // #18 landed; a real address exists and may be shown.

  const pages = codeOnly(LEGAL_TSX());
  const mailtos = [...pages.matchAll(/mailto:([^`'"}\s]+)/g)].map((m) => m[1]);
  for (const target of mailtos) {
    assert.ok(target.includes('${SUPPORT_EMAIL}') || target.includes('SUPPORT_EMAIL'),
      `a policy page hardcodes the address ${target} while SUPPORT_EMAIL is null`);
  }
  assert.match(pages, /SUPPORT_EMAIL &&/,
    'contact copy is not gated on an address existing');
});

test('the render-failure message is true whether or not payment is live', () => {
  // It said "Nothing was charged — please try again", which is true only while
  // nothing is ever charged, and becomes a false claim about the customer's own
  // money in the screen they read straight after losing it.
  const wizard = codeOnly(WIZARD());
  assert.ok(!/Nothing was charged/i.test(wizard),
    'the failure copy still asserts nothing was charged');
  assert.match(wizard, /\{RENDER_FAILED_ASSURANCE\}|RENDER_FAILED_ASSURANCE/,
    'the failure copy does not carry the refund assurance');

  const legal = LEGAL_TS();
  const at = legal.indexOf('export const RENDER_FAILED_ASSURANCE');
  assert.ok(at > 0, 'the assurance is not a named constant');
  const text = legal.slice(at, legal.indexOf('\n\n', at));
  assert.match(text, /if you were charged/i,
    'the assurance asserts a charge state instead of being true in both');
});

// --------------------------------------------------------------------------
// Age and health attestation (#20)
// --------------------------------------------------------------------------

test('the attestation is a separate checkbox, not a clause in the disclaimer', () => {
  const data = fs.readFileSync(path.join(WEB, 'lib', 'data.ts'), 'utf8');
  assert.match(data, /export const ATTESTATION/,
    'the attestation does not exist independently of DISCLAIMER');

  const wizard = codeOnly(WIZARD());
  // Two distinct checkbox ids, so this cannot be satisfied by relabelling the
  // existing consent box.
  for (const id of ['wizard-consent', 'wizard-attestation']) {
    assert.ok(wizard.includes(`id="${id}"`), `${id} checkbox is missing`);
  }
  assert.match(wizard, /\{ATTESTATION\}/, 'the attestation text is never rendered');

  // The box must be bound to its OWN state. Wiring `checked` to `agreed` while
  // `onCheckedChange` sets `attested` leaves a checkbox that displays the other
  // box's state — it renders, the gate still works, and it is visibly wrong.
  const box = wizard.slice(wizard.indexOf('id="wizard-attestation"'));
  const block = box.slice(0, box.indexOf('/>'));
  assert.match(block, /checked=\{attested\}/,
    'the attestation checkbox does not display its own state');
  assert.match(block, /setAttested\(/,
    'the attestation checkbox does not update its own state');
});

test('generation stays disabled until BOTH boxes are checked', () => {
  // Separate booleans rather than one combined flag: a single flag can be
  // satisfied by the disclaimer alone, which is the state #20 was filed about.
  const wizard = codeOnly(WIZARD());
  assert.match(wizard, /const \[attested, setAttested\] = useState\(false\)/,
    'the attestation has no state of its own');

  const gate = wizard.match(/disabled=\{![^}]*accessCode\.trim\(\)\}/);
  assert.ok(gate, 'could not find the generate gate');
  assert.match(gate[0], /!agreed/, 'the gate no longer requires the disclaimer');
  assert.match(gate[0], /!attested/, 'the gate does not require the attestation');
});

test('the attestation resets when the wizard restarts', () => {
  // A stale `true` would carry one person's attestation into the next person's
  // session on a shared machine.
  const wizard = codeOnly(WIZARD());
  const at = wizard.indexOf('setAgreed(false)');
  assert.ok(at > 0, 'the reset path no longer clears consent');
  assert.match(wizard.slice(at, at + 120), /setAttested\(false\)/,
    'the attestation is not cleared alongside consent on reset');
});

test('the attestation states the contraindications the disclaimer names', () => {
  const data = fs.readFileSync(path.join(WEB, 'lib', 'data.ts'), 'utf8');
  const at = data.indexOf('export const ATTESTATION');
  // Join adjacent string literals before matching. The constant is written as
  // `'…severe mental ' + 'illness…'`, so /mental illness/ tests the source
  // layout rather than the sentence the customer reads — it would fail on
  // correct copy purely because of where the line wrapped.
  const text = data.slice(at, data.indexOf('\n\n', at)).replace(/'\s*\+\s*'/g, '');
  assert.match(text, /18/, 'the attestation does not cover age');
  assert.match(text, /seizure/i, 'the attestation does not cover seizures');
  assert.match(text, /mental illness/i, 'the attestation does not cover mental illness');
  // First person: it must be a statement by the buyer, not a restatement of
  // what the disclaimer says, which is what one blanket box already did.
  // Must OPEN in the first person. An alternation over "I am | I do not |
  // I have" passed a second-person rewrite whose tail still read "…I have
  // spoken to a professional" — one first-person clause survived and satisfied
  // the whole check while the attestation itself had become an instruction.
  assert.match(text, /=\s*\n?\s*'I\s/,
    'the attestation does not open in the first person — it reads as an instruction, not a statement');
  assert.ok(!/\byou (should|must|need to)\b/i.test(text),
    'the attestation tells the reader what to do instead of stating what is true of them');
});

// --------------------------------------------------------------------------
// The main offer must not claim the script is written for the buyer (#61)
// --------------------------------------------------------------------------

/**
 * Surfaces that describe the product to someone who has not bought yet.
 *
 * The engine ships one fixed script per goal, so "written for you" is false
 * everywhere except the personalized tier — which does not exist yet and is not
 * purchasable (#13).
 */
const OFFER_SURFACES = [
  path.join(WEB, 'sections', 'Landing.tsx'),
  path.join(WEB, 'sections', 'DoorChooser.tsx'),
  path.join(WEB, '..', 'index.html'),
  path.join(__dirname, '..', 'README.md'),
];

const PERSONALIZATION_CLAIMS = [
  [/personali[sz]ed/i, 'the script is the same for every buyer'],
  [/written for one mind|for one mind/i, 'the script is not written per buyer'],
  [/for one listener/i, 'the same program ships to every listener'],
  [/rendered fresh for you/i, 'implies the script is generated per buyer'],
  [/scripted and voiced for your goal/i, 'the script is fixed per goal, not per buyer'],
  [/written (just )?for you\b/i, 'the script is not written per buyer'],
];

test('the main offer does not claim the script is written for the buyer', () => {
  const offenders = [];
  for (const file of OFFER_SURFACES) {
    // Identifiers are not copy. `PERSONALIZED_POINTER` is the name of the
    // constant that points readers AT the personalized tier — stripping
    // SCREAMING_SNAKE tokens keeps the scan on prose, which is what the claim
    // is about.
    const src = codeOnly(fs.readFileSync(file, 'utf8'))
      .replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, '');
    for (const [pattern, why] of PERSONALIZATION_CLAIMS) {
      const m = src.match(pattern);
      if (m) offenders.push(`${path.basename(file)}: "${m[0]}" — ${why}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `personalization claims are back on the main offer:\n${offenders.join('\n')}`);
});

test('"personalized" survives only as the name of the tier that is not sold yet', () => {
  // #61 exempts the personalized tier — that tier genuinely would be. The point
  // is that the word must stay inside PRICING and not leak back into copy.
  const outside = codeOnly(DATA).split('export const PRICING')[0];
  assert.ok(!/personali[sz]ed/i.test(outside),
    'the personalization claim has leaked out of the pricing tier into product copy');
});

test('delivery speed is stated as it actually is', () => {
  // #61 asked for instant delivery as a selling point. Delivery is NOT instant:
  // the product renders on purchase (~15-20 min). Instant delivery arrives with
  // the pre-rendered catalog (#58/#59), and claiming it before then would be a
  // false promise discovered only after payment.
  //
  // So this asserts the honest position holds, and fails if an instant-delivery
  // claim appears while the render path is still what ships. Delete this test
  // when #59 lands and the claim becomes true.
  const renderPath = fs.readFileSync(path.join(WEB, 'sections', 'Wizard.tsx'), 'utf8');
  const stillRenders = /takes ~?15-20 minutes/.test(renderPath);
  if (!stillRenders) return; // catalog delivery shipped; the claim may be true now.

  const offenders = [];
  for (const file of OFFER_SURFACES) {
    const src = codeOnly(fs.readFileSync(file, 'utf8'));
    for (const p of [/download(s|ing)? in seconds/i, /instant(ly)? deliver/i,
                     /available immediately/i, /ready in seconds/i]) {
      const m = src.match(p);
      if (m) offenders.push(`${path.basename(file)}: "${m[0]}"`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'instant delivery is claimed while the product still renders on purchase ' +
    `(~15-20 min). That becomes true with #58/#59, not before:\n${offenders.join('\n')}`);

  // And the honest claim must actually be present — removing the false promise
  // is only half of #61.
  const landing = codeOnly(fs.readFileSync(OFFER_SURFACES[0], 'utf8'));
  assert.match(landing, /about twenty minutes/i,
    'the hero states no delivery timing at all — #61 wants delivery as a selling point');

  // The tier feature lists are the sharpest place for this, and were the one
  // place the surface list above missed: the $39 tier — the only purchasable
  // one — advertised "Downloads in seconds" while the server rendered for
  // twenty minutes. A browser found it; a grep over Landing/DoorChooser/meta/
  // README could not, because the string lives in data.ts.
  //
  // Scoped to PURCHASABLE tiers. An `available: false` tier describing what it
  // will do when it opens is a roadmap entry, not a promise to someone holding
  // a card.
  for (const tier of PRICING_BLOCK.split('name:').slice(1)) {
    if (!/available: true/.test(tier)) continue;
    const name = (tier.match(/'([^']+)'/) || [])[1] ?? '(unnamed)';
    for (const p of [/in seconds/i, /instant/i, /immediately/i, /live at purchase/i]) {
      const m = tier.match(p);
      assert.ok(!m,
        `the purchasable tier "${name}" promises "${m && m[0]}" while the product ` +
        'still renders on purchase (~15-20 min). That becomes true with #58/#59.');
    }
  }
});

test('the hero says what the product is, not what it does for you', () => {
  const landing = codeOnly(fs.readFileSync(OFFER_SURFACES[0], 'utf8'));
  const h1 = landing.slice(landing.indexOf('<h1'), landing.indexOf('</h1>'));
  assert.match(h1, /four-track/i, 'the hero does not say the product is four tracks');
  assert.match(h1, /self-hypnosis/i, 'the hero does not say what kind of audio this is');
});

test('no efficacy claims, studies, percentages or testimonials appear', () => {
  // marketing-plan.md §4: the current copy is clean on this and the restraint is
  // an asset. Pinning it so a future rewrite cannot quietly introduce them.
  const banned = [
    [/\b\d{1,3}%/, 'a percentage implies a measured outcome'],
    [/\bstud(y|ies)\b/i, 'no study backs this product'],
    [/clinically|scientifically proven|evidence[- ]based/i, 'an efficacy claim'],
    [/\bguarantee[sd]? results?\b/i, 'results are not guaranteed'],
  ];
  const offenders = [];
  for (const file of OFFER_SURFACES) {
    const src = codeOnly(fs.readFileSync(file, 'utf8'));
    for (const [p, why] of banned) {
      const m = src.match(p);
      if (m) offenders.push(`${path.basename(file)}: "${m[0]}" — ${why}`);
    }
  }
  assert.deepStrictEqual(offenders, [], `efficacy claims introduced:\n${offenders.join('\n')}`);
});

// --------------------------------------------------------------------------
// Goal cards say what they are for (#62)
// --------------------------------------------------------------------------

const GOALS_BLOCK = (() => {
  const start = DATA.indexOf('export const GOALS');
  assert.ok(start >= 0, 'GOALS array not found');
  return DATA.slice(start, DATA.indexOf('\n]', start));
})();

const GOAL_IDS = [...GOALS_BLOCK.matchAll(/^\s{4}id: '([^']+)'/gm)].map((m) => m[1]);

test('every goal has an outcome label and a "Choose this if" line', () => {
  assert.ok(GOAL_IDS.length >= 9, `expected at least 9 goals, parsed ${GOAL_IDS.length}`);

  const entries = GOALS_BLOCK.split(/^\s{4}id: '/m).slice(1);
  assert.strictEqual(entries.length, GOAL_IDS.length, 'goal parsing disagrees with itself');

  const missing = [];
  entries.forEach((entry, i) => {
    for (const field of ['outcome', 'chooseIf']) {
      const m = entry.match(new RegExp(`${field}: '([^']*)'`));
      if (!m || m[1].trim().length < 8) missing.push(`${GOAL_IDS[i]}.${field}`);
    }
  });
  assert.deepStrictEqual(missing, [],
    `goals without a usable outcome/chooseIf:\n${missing.join('\n')}`);
});

test('all three goal-card renderers share one component', () => {
  // The performance grid, the healing practices grid and the wizard's goal step
  // rendered three identical copies of this markup. Three copies is how one of
  // them ends up missing the field you just added — which is exactly how the
  // healing door shipped without a seizure warning (#65).
  const shared = fs.readFileSync(
    path.join(WEB, 'components', 'GoalCardText.tsx'), 'utf8');
  for (const field of ['goal.outcome', 'goal.chooseIf', 'goal.name', 'goal.tagline']) {
    assert.ok(shared.includes(`{${field}}`), `the shared card does not render ${field}`);
  }

  const landing = codeOnly(LANDING);
  const wizard = codeOnly(WIZARD());
  assert.strictEqual((landing.match(/<GoalCardText/g) || []).length, 2,
    'Landing.tsx should render the shared goal card exactly twice (performance + healing)');
  assert.strictEqual((wizard.match(/<GoalCardText/g) || []).length, 1,
    'the wizard goal step does not use the shared goal card');

  // And no renderer may reconstruct the old inline block alongside it.
  for (const [name, src] of [['Landing.tsx', landing], ['Wizard.tsx', wizard]]) {
    assert.ok(!/\{(goal|g)\.tagline\}/.test(src),
      `${name} still renders a goal tagline inline instead of through the shared card`);
  }
});

test('the outcome outranks the metaphor in the card', () => {
  // #62 is a hierarchy fix: the metaphor got 40px and the meaning got 12px at
  // 35% opacity. The outcome must come first in the DOM and the name after it.
  const shared = fs.readFileSync(
    path.join(WEB, 'components', 'GoalCardText.tsx'), 'utf8');
  const code = codeOnly(shared);
  assert.ok(code.indexOf('{goal.outcome}') < code.indexOf('{goal.name}'),
    'the metaphor still leads the card');
  assert.ok(code.indexOf('{goal.description}') < code.indexOf('{goal.chooseIf}'),
    '"Choose this if" should be the last thing read, after the description');
});

test('healing goals describe an experience, not a medical condition', () => {
  // The healing door's stance is HEALING_NONMEDICAL — rest and personal growth,
  // never treatment. A "Choose this if" line naming insomnia or anxiety would
  // quietly turn the catalogue into a list of things we claim to treat.
  const clinical = [
    /\binsomnia\b/i, /\banxiety\b/i, /\bdepress(ion|ed)\b/i, /\btrauma\b/i,
    /\bchronic\b/i, /\bdiagnos(is|ed)\b/i, /\bdisorder\b/i, /\bsymptom/i,
    /\bcure\b/i, /\btreat(ment|s)?\b/i, /\bpain\b/i,
  ];
  const offenders = [];
  for (const entry of GOALS_BLOCK.split(/^\s{4}id: '/m).slice(1)) {
    const id = entry.slice(0, entry.indexOf("'"));
    const choose = (entry.match(/chooseIf: '([^']*)'/) || [])[1] || '';
    const outcome = (entry.match(/outcome: '([^']*)'/) || [])[1] || '';
    for (const p of clinical) {
      for (const [field, text] of [['chooseIf', choose], ['outcome', outcome]]) {
        const m = text.match(p);
        if (m) offenders.push(`${id}.${field}: "${m[0]}"`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    `goal copy names a medical condition:\n${offenders.join('\n')}`);
});

/** Contrast of a solid hex colour against the dark page background. */
function hexContrastOnDark(hex, bg = [0x0b, 0x0b, 0x12]) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [hi, lo] = [lum(rgb), lum(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

test('every colour on the goal card meets AA', () => {
  // #62's fourth criterion. The tagline shipped at text-white/35 — 3.15:1, under
  // AA — and #19 recorded it as out of scope because it was chrome. This issue
  // rewrites that exact hierarchy, so it is the right place to fix it, and the
  // guard belongs on the card rather than on the disclaimer token list.
  const src = codeOnly(fs.readFileSync(
    path.join(WEB, 'components', 'GoalCardText.tsx'), 'utf8'));

  const failures = [];
  let parsed = 0;

  for (const m of src.matchAll(/text-white\/(\d{1,3})/g)) {
    parsed += 1;
    const ratio = contrastOnDark(Number(m[1]) / 100);
    if (ratio < 4.5) failures.push(`text-white/${m[1]} = ${ratio.toFixed(2)}:1`);
  }
  for (const m of src.matchAll(/text-\[(#[0-9a-f]{6})\]/gi)) {
    parsed += 1;
    const ratio = hexContrastOnDark(m[1].toLowerCase());
    if (ratio < 4.5) failures.push(`${m[1]} = ${ratio.toFixed(2)}:1`);
  }

  // Count what was actually parsed, in EITHER notation. The first version
  // guarded on `src.includes('text-white/')`, so refactoring the card to hex
  // colours only would have failed the check for the wrong reason — flagged on
  // #107 as forward-looking, fixed here.
  assert.ok(parsed > 0,
    'no colours parsed from the goal card — the check would pass vacuously');
  assert.deepStrictEqual(failures, [],
    `goal-card text below WCAG AA:\n${failures.join('\n')}`);
});

// --------------------------------------------------------------------------
// Only purchasable programs appear on purchase surfaces (#66)
// --------------------------------------------------------------------------

test('the catalog helper returns only what can be bought', () => {
  // The Healing landing showed three cards with two greyed out — a shelf
  // two-thirds empty, on the page whose job is to make an anxious visitor feel
  // they are in careful hands.
  const src = codeOnly(DATA);
  const fn = src.slice(src.indexOf('export const goalsForDoor'));
  const body = fn.slice(0, fn.indexOf('\n\n'));
  assert.match(body, /g\.available/,
    'goalsForDoor no longer filters on availability — dead cards are back');
});

test('no purchase surface renders an unavailable goal', () => {
  const landing = codeOnly(LANDING);
  const wizard = codeOnly(WIZARD());

  // Every grid must map over a filtered list, never GOALS directly.
  assert.ok(!/GOALS\.filter\(\(g\) => g\.door === door\)(?!\s*&&)/.test(wizard),
    'the wizard goal grid maps over an unfiltered door list');
  assert.match(wizard, /g\.door === door && g\.available/,
    'the wizard purchase screen does not filter to purchasable goals');

  // And the "In production" treatment must be gone from both.
  for (const [name, src] of [['Landing.tsx', landing], ['Wizard.tsx', wizard]]) {
    assert.ok(!/In production/.test(src),
      `${name} still renders an "In production" badge on a card`);
    assert.ok(!/opacity-50|opacity-60/.test(src) || !/available/.test(src),
      `${name} still dims cards by availability`);
  }
});

test('upcoming titles are named in prose, not shown as dead cards', () => {
  const src = codeOnly(DATA);
  assert.match(src, /export const upcomingForDoor/,
    'there is no way to name upcoming titles');
  const fn = src.slice(src.indexOf('export const upcomingForDoor'));
  const body = fn.slice(0, fn.indexOf('\n\n'));
  assert.match(body, /!g\.available/, 'upcomingForDoor does not select unbuilt goals');
  // `custom` is not unfinished — it is the $129 tier, and it was being rendered
  // at 50% opacity under a badge saying it does not exist.
  assert.match(body, /g\.id !== 'custom'/,
    'custom is announced as "in production" when it is actually a pricing tier');

  // Per COMPONENT, not per file. Counting `<UpcomingLine` across Landing.tsx
  // passed with BOTH lines inside PerformanceLanding and none in HealingLanding
  // — the healing door announced nothing and the performance door announced the
  // healing titles. A browser found it; a file-wide count structurally cannot.
  const landing = codeOnly(LANDING);
  const fns = [...landing.matchAll(/^(?:export\s+(?:default\s+)?)?function (\w+)/gm)]
    .map((m, i, all) => ({
      name: m[1],
      body: landing.slice(m.index, all[i + 1] ? all[i + 1].index : landing.length),
    }));
  for (const door of ['PerformanceLanding', 'HealingLanding']) {
    const fn = fns.find((x) => x.name === door);
    assert.ok(fn, `${door} no longer exists — update this test`);
    const lines = fn.body.match(/<UpcomingLine door="(\w+)"/g) || [];
    assert.strictEqual(lines.length, 1,
      `${door} renders ${lines.length} upcoming lines, expected exactly 1`);
    const expected = door === 'HealingLanding' ? 'healing' : 'performance';
    assert.ok(lines[0].includes(`"${expected}"`),
      `${door} announces the wrong door's upcoming titles: ${lines[0]}`);
  }
});

test('nameList reads as English for one, two and three titles', () => {
  // Rendered into a sentence, so "A, B" instead of "A and B" is a visible bug.
  const src = codeOnly(DATA);
  const at = src.indexOf('export function nameList');
  assert.ok(at > 0, 'nameList is missing');
  // +2 to include the closing brace — without it the extracted function is
  // unterminated and new Function fails on a syntax error, not on behaviour.
  const body = src.slice(at, src.indexOf('\n}', at) + 2);
  // Strip the TypeScript annotations so the real implementation can be called.
  // Re-implementing it here would test the copy, not the function — and the
  // off-by-one in an English list join ("A, B" instead of "A and B") is exactly
  // the kind of thing only execution catches.
  const js = body
    .replace('export function', 'function')
    .replace(/:\s*string\[\]/g, '')
    .replace(/\)\s*:\s*string\s*\{/, ') {');
  assert.ok(!/:\s*string/.test(js), `type annotations survived the strip:\n${js}`);
  const nameList = new Function(`${js}; return nameList;`)();
  assert.strictEqual(nameList([]), '');
  assert.strictEqual(nameList(['A']), 'A');
  assert.strictEqual(nameList(['A', 'B']), 'A and B');
  assert.strictEqual(nameList(['A', 'B', 'C']), 'A, B and C');
});

test('the "not in production yet" error is unreachable through the UI', () => {
  // The 422 handler stays: the API can still return it for a hand-crafted
  // request, and deleting a server-error branch because the UI cannot trigger
  // it is how a real 422 becomes an unhandled blank screen. "Unreachable
  // through the flow" is the criterion, and filtering is what delivers it.
  const wizard = codeOnly(WIZARD());
  assert.match(wizard, /res\.status === 422/,
    'the 422 handler was deleted rather than made unreachable');

  const start = wizard.indexOf('const doorGoals');
  const decl = wizard.slice(start, start + 260);
  assert.match(decl, /g\.available/,
    'nothing prevents an unavailable goal reaching the render request');
});

// --------------------------------------------------------------------------
// Program counts derive from the catalog; the funnel does not count obstacles
// (#67, #80)
// --------------------------------------------------------------------------

test('program counts are derived, not written down', () => {
  // "Six considered starting points" was wrong three ways: five goals were
  // named, only four were buyable, and the sentence promised a custom script.
  // A number written into prose drifts the moment the catalog moves, so both
  // places that state one must take it from the array the cards render from.
  const src = codeOnly(LANDING);

  assert.match(src, /const howItWorks = \(programCount: number\)/,
    'the steps no longer take the catalog size as a parameter');
  assert.match(src, /\$\{programCount\} programs/,
    'step one states a program count that is not derived');
  assert.match(src, /howItWorks\(goals\.length\)/,
    'the steps are not rendered from the same list the cards use');
  assert.match(src, /\{goals\.length\} programs/,
    'the goal gallery heading states a count that is not derived');

  // And no spelled-out count may describe the catalog again.
  const banned = /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(programs|goals|starting points|doors in)\b/i;
  const m = src.match(banned);
  assert.ok(!m, `a program count is written into copy again: "${m && m[0]}"`);
});

test('"doors" means storefronts, never products', () => {
  // The site has two doors (Performance, Healing) AND a product called "The
  // Open Gate". "Six doors in" made the word mean three things at once.
  const src = codeOnly(LANDING);
  const m = src.match(/\b\w+\s+doors\s+in\b/i);
  assert.ok(!m, `"doors" is used to count products: "${m && m[0]}"`);
});

test('the funnel heading does not count steps or frame them as distance', () => {
  // Greg: "Three quiet steps between you and the program" sounds like a
  // roadblock. It counts obstacles — the purchase reads as a distance to cross.
  const src = codeOnly(LANDING);
  assert.ok(!/steps between you and/i.test(src),
    'the How It Works heading still frames the purchase as a distance');
  assert.ok(!/\b(two|three|four)\s+(quiet\s+)?steps\b/i.test(src),
    'the heading still counts steps');
});

test('the last step is a download, not a wait', () => {
  // "Receive your program" implies waiting for something to be produced. It is
  // a download — and it stays a download after the catalog is pre-rendered.
  const src = codeOnly(LANDING);
  const at = src.indexOf('const howItWorks');
  const steps = src.slice(at, src.indexOf('] as const', at));
  assert.ok(!/Receive your program/.test(steps),
    'step three still tells the customer to wait to receive something');
  assert.match(steps, /Download your program/,
    'step three does not lead with the download');

  // Same rule as #61: the honest timing, until #58/#59 make instant true.
  const stillRenders = /takes ~?15-20 minutes/.test(WIZARD());
  if (stillRenders) {
    assert.ok(!/in seconds|instantly/i.test(steps),
      'step three claims instant delivery while the product still renders on purchase');
    assert.match(steps, /about twenty minutes/i,
      'step three states no delivery timing at all');
  }
});

test('no step promises a script written around the buyer\'s words', () => {
  const src = codeOnly(LANDING);
  for (const p of [/written around the change you name/i, /one sentence of your own/i,
                   /draw your own/i, /or one sentence/i]) {
    const m = src.match(p);
    assert.ok(!m, `the funnel still promises a custom script: "${m && m[0]}"`);
  }
});

// --------------------------------------------------------------------------
// The AI disclosure (#64)
// --------------------------------------------------------------------------

test('the voices are labelled as AI at the point of listening', () => {
  // "AI" is in the role VALUE, not the markup, because these render in two
  // places — the voice step and the delivery screen — and the aria-label is
  // built from the same string. A disclosure added to one render site is how
  // the other ships without it.
  const data = codeOnly(DATA);
  assert.match(data, /role: 'AI narrator' \| 'AI whisper layer'/,
    'the role type no longer forces an AI label');
  assert.ok(!/role: '(Narrator|Whisper layer)'/.test(data),
    'a voice still has a role that does not say it is synthetic');

  const wizard = codeOnly(WIZARD());
  assert.match(wizard, /\{voice\.role\}/, 'the voice role is never displayed');
  assert.match(wizard, /label=\{`\$\{voice\.name\}, \$\{voice\.role\}`\}/,
    'the audio preview aria-label no longer carries the role');
  assert.ok(!/voice\.role\.toLowerCase\(\)/.test(wizard),
    'the aria-label lowercases the role, so "AI" is announced as a word');
});

test('the disclosure explains why AI enables the whisper layer', () => {
  // Lead with capability, not apology. "AI-generated hypnosis" leads with the
  // commodity; the true argument is that two synthetic voices can land in exact
  // time with each other and two human performers cannot.
  const data = DATA;
  const at = data.indexOf('export const HOW_MADE');
  assert.ok(at > 0, 'there is no HOW_MADE block');
  const block = data.slice(at, data.indexOf('\n]', at));

  // Per ITEM, not across the whole block. Checking keywords over the block let
  // a mutation gut the capability sentence entirely and still pass, because
  // "drift" and "synthetic" survived in the neighbouring literals. One clause
  // satisfying an assertion meant for another is the same weakness the
  // first-person attestation check had (#20).
  // `.slice(1)` is not enough: the type annotation
  // `ReadonlyArray<{ heading: string; body: string }>` contains "heading:" too,
  // so the split yields a phantom leading item with no quoted heading.
  const items = block.split('heading:').slice(1).filter((c) => /^\s*'/.test(c)).map((chunk) => ({
    heading: (chunk.match(/'([^']*)'/) || [])[1] ?? '',
    // Join the concatenated literals so the assertion reads the sentence, not
    // the line wrapping.
    body: (chunk.slice(chunk.indexOf('body:')).match(/'[^']*'(?:\s*\+\s*'[^']*')*/) || [''])[0]
      .replace(/'\s*\+\s*'/g, '')
      .replace(/^'|'$/g, ''),
  }));
  assert.strictEqual(items.length, 3, `expected 3 HOW_MADE items, parsed ${items.length}`);

  const voices = items.find((i) => /voices/i.test(i.heading));
  assert.ok(voices, 'no item explains the voices');
  for (const [pattern, why] of [
    [/synthetic/i, 'does not say the voices are synthetic'],
    [/exact time/i, 'drops the capability argument — two voices landing together'],
    [/drift/i, 'does not say why two human performers could not do this'],
  ]) {
    assert.match(voices.body, pattern, `the voices item ${why}`);
  }

  // Register: capability, not apology, and no contradiction of the disclosure.
  for (const [p, why] of [
    [/AI assistance/i, 'reads as an apology bolted on rather than the reason'],
    [/recorded in a studio|voice actors?|human performers? (record|perform) /i,
     'implies the voices are human, contradicting the disclosure'],
  ]) {
    assert.ok(!p.test(block), `the disclosure ${why}`);
  }

  const scripts = items.find((i) => /scripts/i.test(i.heading));
  assert.ok(scripts && /fixed|locked/i.test(scripts.body),
    'the scripts item does not state they are fixed');
  const bed = items.find((i) => /bed/i.test(i.heading));
  assert.ok(bed && /isochronic/i.test(bed.body),
    'the bed item does not say the bed is isochronic');

  // Never "hand-written" — a claim we would lose an argument about.
  assert.ok(!/hand[- ]?written|handcrafted|hand[- ]?crafted/i.test(block),
    'the disclosure claims the scripts are hand-written');
});

test('both doors carry the disclosure and it links to the personalized tier', () => {
  // Per component, not per file — the mistake that shipped /healing without a
  // seizure warning (#65) and put both upcoming lines on one door (#66).
  const src = codeOnly(LANDING);
  const fns = [...src.matchAll(/^(?:export\s+(?:default\s+)?)?function (\w+)/gm)]
    .map((m, i, all) => ({
      name: m[1],
      body: src.slice(m.index, all[i + 1] ? all[i + 1].index : src.length),
    }));
  const carriers = fns.filter((f) => /<HowMadeSection/.test(f.body)).map((f) => f.name);

  for (const door of ['PerformanceLanding', 'HealingLanding']) {
    const fn = fns.find((f) => f.name === door);
    assert.ok(fn, `${door} no longer exists — update this test`);
    const direct = /<HowMadeSection/.test(fn.body);
    const viaShared = carriers.some((c) => c !== door && fn.body.includes(`<${c}`));
    assert.ok(direct || viaShared, `${door} ships without the AI disclosure`);
  }

  assert.match(src, /\{PERSONALIZED_POINTER\}/,
    'the block does not point at the personalized tier');
});

test('the "See the tiers" link resolves on a door with no pricing section', () => {
  // The tiers live on the performance landing; HealingLanding has no #pricing
  // element, so a bare scroll-to-id would silently do nothing there — the same
  // dead-link failure #18 exists to fix.
  const src = codeOnly(LANDING);
  // The JSX usage, not the import at the top of the file — indexOf finds the
  // import first and the slice then contains none of the link.
  const at = src.indexOf('{PERSONALIZED_POINTER}');
  assert.ok(at > 0, 'the personalized pointer is never rendered');
  const region = src.slice(at, at + 1200);
  assert.match(region, /getElementById\('pricing'\)/,
    'the tier link does not check whether the section is on this page');
  assert.match(region, /onNavigate\('\/performance'\)/,
    'the tier link has no fallback for a door without a pricing section');

  const healing = src.slice(src.indexOf('function HealingLanding'));
  assert.ok(!/id="pricing"/.test(healing),
    'HealingLanding now has a pricing section — simplify the tier link');
});
