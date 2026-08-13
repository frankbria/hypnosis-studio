// Credit preflight before checkout (issue #25).
//
// The failure this prevents is specific: a customer pays, waits twenty minutes,
// and receives a quota-exhaustion failure. The check therefore has to happen
// before the Checkout Session exists, and "no session was created" is the
// assertion that matters — not the status code.
//
// Both limits are covered. The ElevenLabs plan balance is the one the issue
// names; the local monthly ledger is the one that already produced exactly this
// failure, because startRender() runs from the webhook and every refusal it
// makes now lands after the charge.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function request(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, path: p, method, timeout: 8000,
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {},
    }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(out); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: out, json });
      });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

/** A Stripe that records whether it was called at all. */
async function fakeStripe() {
  const calls = [];
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }));
    });
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { calls, base: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

/**
 * An ElevenLabs that reports a balance and counts how often it is asked.
 *
 * `mode` can be flipped mid-test, which is how the stale-reading behaviour is
 * exercised without waiting for anything.
 */
async function fakeElevenLabs({ used = 0, limit = 500000, mode = 'ok' } = {}) {
  const state = { used, limit, mode, calls: 0 };
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    state.calls += 1;
    if (state.mode === 'down') { req.destroy(); return; }
    if (state.mode === 'unauthorized') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ detail: 'missing_permissions: user_read' }));
    }
    if (state.mode === 'garbage') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html>nope</html>');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ character_count: state.used, character_limit: state.limit }));
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { state, base: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

async function startServer(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credit-'));
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      HYPNO_NO_DOTENV: '1',
      PORT: String(port),
      RENDERS_DIR: dir,
      ENGINE_PY: '/bin/false',
      SWEEP_INTERVAL_MS: '600000',
      STRIPE_SECRET_KEY: 'sk_test_fake',
      PUBLIC_BASE_URL: 'https://studio.example',
      ELEVENLABS_API_KEY: 'xi_test_key',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      if ((await request(port, 'GET', '/api/health')).status === 200) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server never became ready');
    await sleep(50);
  }
  return { proc, port, rendersDir: dir };
}

function stop({ proc, rendersDir }) {
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  try { fs.rmSync(rendersDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

const buy = (srv, goal = 'polymath', voiceSet = 'male') =>
  request(srv.port, 'POST', '/api/checkout', { goal, voiceSet });

// --------------------------------------------------------------------------
// The provider balance
// --------------------------------------------------------------------------

test('an exhausted plan is refused before a session exists', async () => {
  const stripe = await fakeStripe();
  const eleven = await fakeElevenLabs({ used: 499000, limit: 500000 });   // 1k left
  const srv = await startServer({ STRIPE_API_BASE: stripe.base, ELEVENLABS_API_BASE: eleven.base });
  try {
    const res = await buy(srv);
    assert.strictEqual(res.status, 503, res.body);
    assert.strictEqual(res.json.error, 'temporarily_unavailable');
    assert.deepStrictEqual(stripe.calls, [],
      'a session was created for a program that cannot be rendered');
  } finally {
    stop(srv); stripe.close(); eleven.close();
  }
});

test('a healthy plan sells normally', async () => {
  const stripe = await fakeStripe();
  const eleven = await fakeElevenLabs({ used: 0, limit: 500000 });
  const srv = await startServer({ STRIPE_API_BASE: stripe.base, ELEVENLABS_API_BASE: eleven.base });
  try {
    const res = await buy(srv);
    assert.strictEqual(res.status, 200, res.body);
    assert.strictEqual(stripe.calls.length, 1);
  } finally {
    stop(srv); stripe.close(); eleven.close();
  }
});

test('the refusal names no provider and no numbers to the customer', async () => {
  // "ElevenLabs has 900 characters left" tells a stranger what the studio runs
  // on and how close to empty it is. The log carries the detail; the response
  // does not.
  const stripe = await fakeStripe();
  const eleven = await fakeElevenLabs({ used: 499100, limit: 500000 });
  const srv = await startServer({ STRIPE_API_BASE: stripe.base, ELEVENLABS_API_BASE: eleven.base });
  try {
    const res = await buy(srv);
    assert.strictEqual(res.status, 503);
    const lowered = res.body.toLowerCase();
    for (const leak of ['eleven', 'character', '900', '500000']) {
      assert.ok(!lowered.includes(leak), `the refusal leaks "${leak}": ${res.body}`);
    }
  } finally {
    stop(srv); stripe.close(); eleven.close();
  }
});

// --------------------------------------------------------------------------
// The cache
// --------------------------------------------------------------------------

test('the balance is not fetched once per checkout', async () => {
  const stripe = await fakeStripe();
  const eleven = await fakeElevenLabs();
  const srv = await startServer({
    STRIPE_API_BASE: stripe.base, ELEVENLABS_API_BASE: eleven.base,
    CREDIT_CACHE_MS: '60000',
  });
  try {
    for (let i = 0; i < 5; i += 1) assert.strictEqual((await buy(srv)).status, 200);
    assert.strictEqual(eleven.state.calls, 1,
      `the provider was asked ${eleven.state.calls} times for 5 checkouts`);
  } finally {
    stop(srv); stripe.close(); eleven.close();
  }
});

test('concurrent checkouts on a cold cache make one provider request', async () => {
  const stripe = await fakeStripe();
  const eleven = await fakeElevenLabs();
  const srv = await startServer({ STRIPE_API_BASE: stripe.base, ELEVENLABS_API_BASE: eleven.base });
  try {
    const all = await Promise.all(Array.from({ length: 6 }, () => buy(srv)));
    for (const r of all) assert.strictEqual(r.status, 200, r.body);
    assert.strictEqual(eleven.state.calls, 1,
      `a burst opened ${eleven.state.calls} requests to the provider`);
  } finally {
    stop(srv); stripe.close(); eleven.close();
  }
});

test('the cache expires, so an exhausted plan is noticed', async () => {
  const stripe = await fakeStripe();
  const eleven = await fakeElevenLabs();
  const srv = await startServer({
    STRIPE_API_BASE: stripe.base, ELEVENLABS_API_BASE: eleven.base,
    CREDIT_CACHE_MS: '300',
  });
  try {
    assert.strictEqual((await buy(srv)).status, 200);
    eleven.state.used = 499999;              // the plan runs out
    await sleep(400);
    const res = await buy(srv);
    assert.strictEqual(res.status, 503, 'a stale cache kept selling past the plan');
  } finally {
    stop(srv); stripe.close(); eleven.close();
  }
});

// --------------------------------------------------------------------------
// When the provider cannot be reached
// --------------------------------------------------------------------------

test('an unreachable provider does not close the shop', async () => {
  // The monthly ledger is local and still bounds our own spend. Refusing every
  // sale because a metering endpoint is briefly down is a bigger failure than
  // the one being prevented.
  const stripe = await fakeStripe();
  const eleven = await fakeElevenLabs({ mode: 'down' });
  const srv = await startServer({ STRIPE_API_BASE: stripe.base, ELEVENLABS_API_BASE: eleven.base });
  try {
    const res = await buy(srv);
    assert.strictEqual(res.status, 200, res.body);
    assert.strictEqual(stripe.calls.length, 1);
  } finally {
    stop(srv); stripe.close(); eleven.close();
  }
});

test('a key without the user_read scope does not close the shop', async () => {
  const stripe = await fakeStripe();
  const eleven = await fakeElevenLabs({ mode: 'unauthorized' });
  const srv = await startServer({ STRIPE_API_BASE: stripe.base, ELEVENLABS_API_BASE: eleven.base });
  try {
    assert.strictEqual((await buy(srv)).status, 200);
  } finally {
    stop(srv); stripe.close(); eleven.close();
  }
});

test('a nonsense response does not close the shop', async () => {
  const stripe = await fakeStripe();
  const eleven = await fakeElevenLabs({ mode: 'garbage' });
  const srv = await startServer({ STRIPE_API_BASE: stripe.base, ELEVENLABS_API_BASE: eleven.base });
  try {
    assert.strictEqual((await buy(srv)).status, 200);
  } finally {
    stop(srv); stripe.close(); eleven.close();
  }
});

test('a reading that has gone stale still beats no reading at all', async () => {
  // Credits do not move quickly at ~20k a program, so a value from ten minutes
  // ago is far closer to the truth than a shrug — and it must keep refusing.
  const stripe = await fakeStripe();
  const eleven = await fakeElevenLabs({ used: 499000, limit: 500000 });
  const srv = await startServer({
    STRIPE_API_BASE: stripe.base, ELEVENLABS_API_BASE: eleven.base,
    CREDIT_CACHE_MS: '300',
  });
  try {
    assert.strictEqual((await buy(srv)).status, 503, 'the exhausted plan was not read');
    eleven.state.mode = 'down';              // the provider goes away
    await sleep(400);                        // and the reading goes stale
    const res = await buy(srv);
    assert.strictEqual(res.status, 503,
      'an unreachable provider erased what was already known to be true');
  } finally {
    stop(srv); stripe.close(); eleven.close();
  }
});

test('with no API key at all the shop stays open', async () => {
  // A prototype with no key configured must still be able to demonstrate
  // checkout; the render is what needs the key.
  const stripe = await fakeStripe();
  const eleven = await fakeElevenLabs();
  const srv = await startServer({
    STRIPE_API_BASE: stripe.base, ELEVENLABS_API_BASE: eleven.base,
    ELEVENLABS_API_KEY: '',
  });
  try {
    assert.strictEqual((await buy(srv)).status, 200);
    assert.strictEqual(eleven.state.calls, 0, 'a keyless server called the provider anyway');
  } finally {
    stop(srv); stripe.close(); eleven.close();
  }
});

// --------------------------------------------------------------------------
// The local ledger — the half that needed no provider call
// --------------------------------------------------------------------------

test('a spent monthly allowance is refused before a session exists', async () => {
  // startRender() checks this too, but it runs from the webhook — so before
  // this change the check fired after the customer had paid, which is the exact
  // sequence the issue was opened about.
  const stripe = await fakeStripe();
  const eleven = await fakeElevenLabs();
  const srv = await startServer({
    STRIPE_API_BASE: stripe.base, ELEVENLABS_API_BASE: eleven.base,
    MONTHLY_CHAR_BUDGET: '1',
  });
  try {
    const res = await buy(srv);
    assert.strictEqual(res.status, 503, res.body);
    assert.strictEqual(res.json.error, 'temporarily_unavailable');
    assert.deepStrictEqual(stripe.calls, []);
  } finally {
    stop(srv); stripe.close(); eleven.close();
  }
});

test('a refused checkout does not spend a rate-cap slot', async () => {
  const stripe = await fakeStripe();
  const eleven = await fakeElevenLabs();
  const srv = await startServer({
    STRIPE_API_BASE: stripe.base, ELEVENLABS_API_BASE: eleven.base,
    MONTHLY_CHAR_BUDGET: '1', CHECKOUT_MAX_PER_MINUTE: '2',
  });
  try {
    for (let i = 0; i < 5; i += 1) {
      assert.strictEqual((await buy(srv)).status, 503);
    }
  } finally {
    stop(srv); stripe.close(); eleven.close();
  }
  // And with the budget restored, the cap is untouched.
  const stripe2 = await fakeStripe();
  const eleven2 = await fakeElevenLabs();
  const srv2 = await startServer({
    STRIPE_API_BASE: stripe2.base, ELEVENLABS_API_BASE: eleven2.base,
    CHECKOUT_MAX_PER_MINUTE: '2',
  });
  try {
    assert.strictEqual((await buy(srv2)).status, 200);
    assert.strictEqual((await buy(srv2)).status, 200);
  } finally {
    stop(srv2); stripe2.close(); eleven2.close();
  }
});

test('an invalid program is still rejected without asking the provider anything', async () => {
  const stripe = await fakeStripe();
  const eleven = await fakeElevenLabs();
  const srv = await startServer({ STRIPE_API_BASE: stripe.base, ELEVENLABS_API_BASE: eleven.base });
  try {
    assert.strictEqual((await buy(srv, 'not_a_goal')).status, 422);
    assert.strictEqual(eleven.state.calls, 0,
      'a request that could never be fulfilled cost a provider round-trip');
  } finally {
    stop(srv); stripe.close(); eleven.close();
  }
});
