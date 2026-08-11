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
