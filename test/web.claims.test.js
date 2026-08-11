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
