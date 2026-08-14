// Stripe Checkout Session creation (issue #22).
//
// The point of this endpoint is that the amount is decided here and nowhere
// else. Until now the price existed only as the string '$39' in the frontend
// bundle, which means it was whatever the browser said it was. So the
// assertions that matter are not "a session was created" — they are "the
// number that reached Stripe came from the server, no matter what the caller
// sent" and "a request that could never be fulfilled never reaches Stripe at
// all".
//
// STRIPE_API_BASE points the server at a fake Stripe on localhost, for the same
// reason ENGINE_PY and RENDERS_DIR are overridable: a test needs a dependency it
// controls. The fake records every request it receives, so "zero calls" is an
// assertion this suite can actually make.
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
      host: '127.0.0.1', port, path: p, method, timeout: 5000,
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {},
    }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: out, json: safeJson(out) }));
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * A Stripe that answers like the real one and remembers what it was asked.
 *
 * `calls` is the assertion surface: the form body is parsed with
 * URLSearchParams because that is exactly what Stripe accepts, so a test that
 * reads `line_items[0][price_data][unit_amount]` is reading the wire, not an
 * internal representation the server happens to use.
 */
async function fakeStripe({ fail = false } = {}) {
  const calls = [];
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({
        method: req.method,
        path: req.url,
        auth: req.headers.authorization || '',
        form: new URLSearchParams(body),
        raw: body,
      });
      if (fail) {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'card declined' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'cs_test_123',
        url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      }));
    });
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { calls, port, base: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

async function startServer(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-'));
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      HYPNO_NO_DOTENV: '1',
      PORT: String(port),
      RENDERS_DIR: dir,
      ENGINE_PY: '/bin/false',
      SWEEP_INTERVAL_MS: '60000',
      STRIPE_SECRET_KEY: 'sk_test_fake',
      PUBLIC_BASE_URL: 'https://studio.example',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Poll rather than sleep a fixed interval. The sibling suites use a flat
  // 1300 ms, which is a bet on how loaded the machine is — under CI load the
  // first request lands before the listener and the failure looks like a bug in
  // the endpoint. /api/health needs no configuration to answer.
  await waitUntilListening(port);
  return { proc, port, rendersDir: dir };
}

async function waitUntilListening(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await request(port, 'GET', '/api/health');
      if (res.status === 200) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server on ${port} never became ready`);
    await sleep(50);
  }
}

function stop({ proc, rendersDir }) {
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  try { fs.rmSync(rendersDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

test('creates a session and hands back the URL to redirect to', async () => {
  const stripe = await fakeStripe();
  const srv = await startServer({ STRIPE_API_BASE: stripe.base });
  try {
    const res = await request(srv.port, 'POST', '/api/checkout', {
      goal: 'polymath', voiceSet: 'male',
    });
    assert.strictEqual(res.status, 200, res.body);
    assert.strictEqual(res.json.url, 'https://checkout.stripe.com/c/pay/cs_test_123');
    assert.strictEqual(res.json.sessionId, 'cs_test_123');

    assert.strictEqual(stripe.calls.length, 1);
    const call = stripe.calls[0];
    assert.strictEqual(call.method, 'POST');
    assert.strictEqual(call.path, '/v1/checkout/sessions');
    assert.strictEqual(call.auth, 'Bearer sk_test_fake');
    assert.strictEqual(call.form.get('mode'), 'payment');
  } finally {
    stop(srv);
    stripe.close();
  }
});

test('the amount comes from the server, not the request', async () => {
  const stripe = await fakeStripe();
  const srv = await startServer({ STRIPE_API_BASE: stripe.base });
  try {
    // Every shape a tamperer would reach for, in one request.
    const res = await request(srv.port, 'POST', '/api/checkout', {
      goal: 'river',
      voiceSet: 'female',
      unit_amount: 1,
      amount: 1,
      price: '$0.01',
      priceCents: 1,
      currency: 'xxx',
      line_items: [{ price_data: { unit_amount: 1, currency: 'xxx' } }],
    });
    assert.strictEqual(res.status, 200, res.body);

    const form = stripe.calls[0].form;
    assert.strictEqual(form.get('line_items[0][price_data][unit_amount]'), '3900');
    assert.strictEqual(form.get('line_items[0][price_data][currency]'), 'usd');
    assert.strictEqual(form.get('line_items[0][quantity]'), '1');
    assert.ok(!stripe.calls[0].raw.includes('xxx'), 'client currency reached Stripe');
  } finally {
    stop(srv);
    stripe.close();
  }
});

test('the configured price is what is charged', async () => {
  const stripe = await fakeStripe();
  const srv = await startServer({
    STRIPE_API_BASE: stripe.base,
    PROGRAM_PRICE_CENTS: '4900',
    PROGRAM_CURRENCY: 'gbp',
  });
  try {
    const res = await request(srv.port, 'POST', '/api/checkout', {
      goal: 'open_gate', voiceSet: 'male',
    });
    assert.strictEqual(res.status, 200, res.body);
    const form = stripe.calls[0].form;
    assert.strictEqual(form.get('line_items[0][price_data][unit_amount]'), '4900');
    assert.strictEqual(form.get('line_items[0][price_data][currency]'), 'gbp');
  } finally {
    stop(srv);
    stripe.close();
  }
});

test('a nonsense price falls back to the documented default rather than charging it', async () => {
  const stripe = await fakeStripe();
  const srv = await startServer({ STRIPE_API_BASE: stripe.base, PROGRAM_PRICE_CENTS: '-1' });
  try {
    const res = await request(srv.port, 'POST', '/api/checkout', {
      goal: 'polymath', voiceSet: 'male',
    });
    assert.strictEqual(res.status, 200, res.body);
    assert.strictEqual(stripe.calls[0].form.get('line_items[0][price_data][unit_amount]'), '3900');
  } finally {
    stop(srv);
    stripe.close();
  }
});

test('a scientific-notation price does not silently become one cent', async () => {
  // parseInt('1e21', 10) is 1 — it stops at the 'e'. An operator writing that to
  // mean "a lot" would charge $0.01, and Number.isInteger(1) is true, so the
  // obvious guard waves it through. This is the assertion that the price is
  // parsed as money rather than as whatever a lenient parser salvages.
  const stripe = await fakeStripe();
  const srv = await startServer({ STRIPE_API_BASE: stripe.base, PROGRAM_PRICE_CENTS: '1e21' });
  try {
    const res = await request(srv.port, 'POST', '/api/checkout', {
      goal: 'polymath', voiceSet: 'male',
    });
    assert.strictEqual(res.status, 200, res.body);
    assert.strictEqual(stripe.calls[0].form.get('line_items[0][price_data][unit_amount]'), '3900');
  } finally {
    stop(srv);
    stripe.close();
  }
});

test('a price past the safe integer range is refused, not rounded', async () => {
  const stripe = await fakeStripe();
  const srv = await startServer({
    STRIPE_API_BASE: stripe.base,
    PROGRAM_PRICE_CENTS: '99999999999999999999',
  });
  try {
    await request(srv.port, 'POST', '/api/checkout', { goal: 'polymath', voiceSet: 'male' });
    assert.strictEqual(stripe.calls[0].form.get('line_items[0][price_data][unit_amount]'), '3900');
  } finally {
    stop(srv);
    stripe.close();
  }
});

test('a currency Stripe would reject never reaches the moment of purchase', async () => {
  const stripe = await fakeStripe();
  const srv = await startServer({ STRIPE_API_BASE: stripe.base, PROGRAM_CURRENCY: 'dollars' });
  try {
    await request(srv.port, 'POST', '/api/checkout', { goal: 'polymath', voiceSet: 'male' });
    assert.strictEqual(stripe.calls[0].form.get('line_items[0][price_data][currency]'), 'usd');
  } finally {
    stop(srv);
    stripe.close();
  }
});

test('a malformed return address disables checkout rather than 502ing at purchase', async () => {
  // `hypnosisstudio.app` with no scheme builds a success_url Stripe rejects. The
  // operator would see only checkout_unavailable, with nothing pointing at their
  // env file. checkout_disabled is the code that means "you have not configured
  // this", so that is the one they get.
  const stripe = await fakeStripe();
  const srv = await startServer({
    STRIPE_API_BASE: stripe.base,
    PUBLIC_BASE_URL: 'hypnosisstudio.app',
  });
  try {
    const res = await request(srv.port, 'POST', '/api/checkout', {
      goal: 'polymath', voiceSet: 'male',
    });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.json.error, 'checkout_disabled');
    assert.deepStrictEqual(stripe.calls, []);
  } finally {
    stop(srv);
    stripe.close();
  }
});

test('a body of literal null is a client error, not an internal one', async () => {
  // JSON.parse('null') succeeds and is not an object, so `body.goal` throws and
  // the request backstop reports 500 for what is plainly a bad request.
  const stripe = await fakeStripe();
  const srv = await startServer({ STRIPE_API_BASE: stripe.base });
  try {
    const res = await new Promise((resolve, reject) => {
      const r = http.request({
        host: '127.0.0.1', port: srv.port, path: '/api/checkout', method: 'POST',
        timeout: 5000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': 4 },
      }, (res2) => {
        let out = '';
        res2.on('data', (c) => (out += c));
        res2.on('end', () => resolve({ status: res2.statusCode, json: safeJson(out) }));
      });
      r.on('error', reject);
      r.end('null');
    });
    assert.strictEqual(res.status, 422, 'a null body is reported as an internal error');
    assert.strictEqual(res.json.error, 'goal_in_production');
    assert.deepStrictEqual(stripe.calls, []);
  } finally {
    stop(srv);
    stripe.close();
  }
});

test('the number of sessions asked of Stripe is capped', async () => {
  // /api/programs is gated by ACCESS_CODE, the daily quota and the monthly
  // budget. /api/checkout can have none of those — it is what a customer who
  // has not bought anything reaches — so a loop against it would otherwise run
  // unbounded requests against our Stripe account.
  const stripe = await fakeStripe();
  const srv = await startServer({ STRIPE_API_BASE: stripe.base, CHECKOUT_MAX_PER_MINUTE: '3' });
  try {
    const codes = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await request(srv.port, 'POST', '/api/checkout', {
        goal: 'polymath', voiceSet: 'male',
      });
      codes.push(res.status);
    }
    assert.deepStrictEqual(codes, [200, 200, 200, 429, 429]);
    assert.strictEqual(stripe.calls.length, 3, 'the cap did not bound calls to Stripe');
  } finally {
    stop(srv);
    stripe.close();
  }
});

test('a rejected request does not spend a slot in the cap', async () => {
  // The cap exists to bound calls to Stripe. A 422 never makes one, so charging
  // it a slot would let junk requests lock out real customers.
  const stripe = await fakeStripe();
  const srv = await startServer({ STRIPE_API_BASE: stripe.base, CHECKOUT_MAX_PER_MINUTE: '2' });
  try {
    for (let i = 0; i < 5; i += 1) {
      await request(srv.port, 'POST', '/api/checkout', { goal: 'nope', voiceSet: 'male' });
    }
    const res = await request(srv.port, 'POST', '/api/checkout', {
      goal: 'polymath', voiceSet: 'male',
    });
    assert.strictEqual(res.status, 200, res.body);
  } finally {
    stop(srv);
    stripe.close();
  }
});

test('an invalid goal is rejected before Stripe is called at all', async () => {
  const stripe = await fakeStripe();
  const srv = await startServer({ STRIPE_API_BASE: stripe.base });
  try {
    const res = await request(srv.port, 'POST', '/api/checkout', {
      goal: 'not_a_goal', voiceSet: 'male',
    });
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.json.error, 'goal_in_production');
    assert.deepStrictEqual(stripe.calls, [], 'an unfulfillable request reached Stripe');
  } finally {
    stop(srv);
    stripe.close();
  }
});

test('an invalid voice set is rejected before Stripe is called at all', async () => {
  const stripe = await fakeStripe();
  const srv = await startServer({ STRIPE_API_BASE: stripe.base });
  try {
    const res = await request(srv.port, 'POST', '/api/checkout', {
      goal: 'polymath', voiceSet: 'robot',
    });
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.json.error, 'bad_voice_set');
    assert.deepStrictEqual(stripe.calls, [], 'an unfulfillable request reached Stripe');
  } finally {
    stop(srv);
    stripe.close();
  }
});

test('with no secret key the endpoint refuses instead of half-working', async () => {
  const stripe = await fakeStripe();
  const srv = await startServer({ STRIPE_API_BASE: stripe.base, STRIPE_SECRET_KEY: '' });
  try {
    const res = await request(srv.port, 'POST', '/api/checkout', {
      goal: 'polymath', voiceSet: 'male',
    });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.json.error, 'checkout_disabled');
    assert.deepStrictEqual(stripe.calls, []);
  } finally {
    stop(srv);
    stripe.close();
  }
});

test('with no return address the endpoint refuses rather than guessing one', async () => {
  // success_url is deliberately NOT derived from the request's Host header:
  // that header is attacker-controlled, and a forged one would land the
  // customer on somebody else's site the instant after paying us. So an
  // unset PUBLIC_BASE_URL is a disabled checkout, not a best-effort one.
  const stripe = await fakeStripe();
  const srv = await startServer({ STRIPE_API_BASE: stripe.base, PUBLIC_BASE_URL: '' });
  try {
    const res = await request(srv.port, 'POST', '/api/checkout', {
      goal: 'polymath', voiceSet: 'male',
    });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.json.error, 'checkout_disabled');
    assert.deepStrictEqual(stripe.calls, []);
  } finally {
    stop(srv);
    stripe.close();
  }
});

test('a forged Host header cannot redirect the customer off-site', async () => {
  const stripe = await fakeStripe();
  const srv = await startServer({ STRIPE_API_BASE: stripe.base });
  try {
    await new Promise((resolve, reject) => {
      const data = JSON.stringify({ goal: 'polymath', voiceSet: 'male' });
      const r = http.request({
        host: '127.0.0.1', port: srv.port, path: '/api/checkout', method: 'POST',
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          Host: 'evil.example',
          'X-Forwarded-Proto': 'http',
        },
      }, (res) => { res.resume(); res.on('end', resolve); });
      r.on('error', reject);
      r.write(data);
      r.end();
    });
    const form = stripe.calls[0].form;
    assert.ok(!form.get('success_url').includes('evil.example'),
      'the Host header reached the post-payment redirect');
    assert.match(form.get('success_url'), /^https:\/\/studio\.example\//);
  } finally {
    stop(srv);
    stripe.close();
  }
});

test('a Stripe failure is a 502, not a session the caller cannot use', async () => {
  const stripe = await fakeStripe({ fail: true });
  const srv = await startServer({ STRIPE_API_BASE: stripe.base });
  try {
    const res = await request(srv.port, 'POST', '/api/checkout', {
      goal: 'polymath', voiceSet: 'male',
    });
    assert.strictEqual(res.status, 502);
    assert.strictEqual(res.json.error, 'checkout_unavailable');
    assert.ok(!res.body.includes('sk_test'), 'the secret key leaked into an error body');
  } finally {
    stop(srv);
    stripe.close();
  }
});

test('GET is not a way to create a session', async () => {
  const stripe = await fakeStripe();
  const srv = await startServer({ STRIPE_API_BASE: stripe.base });
  try {
    const res = await request(srv.port, 'GET', '/api/checkout');
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(stripe.calls, []);
  } finally {
    stop(srv);
    stripe.close();
  }
});

test('the return URLs point back at this site and carry the session id', async () => {
  const stripe = await fakeStripe();
  const srv = await startServer({ STRIPE_API_BASE: stripe.base });
  try {
    await request(srv.port, 'POST', '/api/checkout', { goal: 'polymath', voiceSet: 'male' });
    const form = stripe.calls[0].form;
    assert.match(form.get('success_url'), /^https:\/\/studio\.example\//);
    assert.match(form.get('success_url'), /\{CHECKOUT_SESSION_ID\}/);
    assert.match(form.get('cancel_url'), /^https:\/\/studio\.example\//);
  } finally {
    stop(srv);
    stripe.close();
  }
});

test('what was bought is recorded on the session for the webhook to read', async () => {
  const stripe = await fakeStripe();
  const srv = await startServer({ STRIPE_API_BASE: stripe.base });
  try {
    await request(srv.port, 'POST', '/api/checkout', { goal: 'golden_thread', voiceSet: 'female' });
    const form = stripe.calls[0].form;
    // #23 gates the render on the webhook; it can only start the right render
    // if the session says which one was paid for.
    assert.strictEqual(form.get('metadata[goal]'), 'golden_thread');
    assert.strictEqual(form.get('metadata[voiceSet]'), 'female');
  } finally {
    stop(srv);
    stripe.close();
  }
});
