// Automatic refunds when a render fails after payment (issue #26).
//
// /refunds states this as a specification, not a description:
//
//   "If your render fails, you are refunded in full, automatically. You do not
//    have to ask, and you do not have to prove anything — the refund is issued
//    by the same system that noticed the failure."
//
// So the assertions are about EXACTLY ONE refund reaching Stripe per failure —
// the worker exit handler and the stale sweep genuinely race, since a worker
// can exit at the moment the sweep decides it is stale — and about the customer
// being able to see it happened.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SECRET = 'whsec_test_secret';
const PAYMENT_INTENT = 'pi_test_refundme';
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

function request(port, method, p, raw, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port, path: p, method, timeout: 8000,
      headers: raw === undefined ? headers : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(raw),
        ...headers,
      },
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
    if (raw !== undefined) r.write(raw);
    r.end();
  });
}

const sign = (raw, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex')}`;

function paidEvent(sessionId = 'cs_test_1') {
  return JSON.stringify({
    id: `evt_${sessionId}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId, payment_status: 'paid', payment_intent: PAYMENT_INTENT,
        amount_total: 3900, currency: 'usd',
        customer_details: { email: 'buyer@example.com' },
        metadata: { goal: 'polymath', voiceSet: 'male' },
      },
    },
  });
}

/**
 * A Stripe that records every refund and honours Idempotency-Key the way the
 * real one does — a repeated key returns the ORIGINAL refund rather than
 * creating a second.
 */
async function fakeStripe({ refundStatus = 200 } = {}) {
  const refunds = [];
  const byKey = new Map();
  const state = { refundStatus };
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (!req.url.startsWith('/v1/refunds')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: 'cs_x', url: 'https://example/pay' }));
      }
      const key = req.headers['idempotency-key'] || '';
      if (state.refundStatus !== 200) {
        res.writeHead(state.refundStatus, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'refund refused' } }));
      }
      if (byKey.has(key)) {
        // Stripe replays the original response; it does NOT move money twice.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(byKey.get(key)));
      }
      const form = new URLSearchParams(body);
      const refund = { id: `re_${refunds.length + 1}`, payment_intent: form.get('payment_intent') };
      refunds.push({ ...refund, key, form });
      byKey.set(key, refund);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(refund));
    });
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { refunds, state, base: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

/** An engine that behaves however the test needs it to. */
function makeEngine(kind) {
  const p = path.join(os.tmpdir(), `refund-engine-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sh`);
  const bodies = {
    // Exits non-zero having written nothing: the worker-crash path.
    crash: 'exit 1',
    // Reports failure itself, then exits cleanly.
    fail: `printf '{"jobId":"x","state":"failed","stage":null,"progress":0,"error":"the mixer ran out of memory","updatedAt":"%s"}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$outdir/status.json"
exit 0`,
    // Succeeds.
    ok: `printf '{"jobId":"x","state":"ready","stage":"mastering-qa","progress":1,"detail":"done","updatedAt":"%s"}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$outdir/status.json"
exit 0`,
    // Stays alive, so the test can kill it mid-job.
    hang: 'sleep 300',
  };
  fs.writeFileSync(p, `#!/bin/sh
outdir=""
while [ $# -gt 0 ]; do
  case "$1" in --outdir) outdir="$2"; shift 2;; *) shift;; esac
done
${bodies[kind]}
`, { mode: 0o755 });
  return p;
}

async function startServer({ engine = 'fail', env = {}, rendersDir } = {}) {
  const dir = rendersDir || fs.mkdtempSync(path.join(os.tmpdir(), 'refund-'));
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      HYPNO_NO_DOTENV: '1',
      PORT: String(port),
      RENDERS_DIR: dir,
      ENGINE_PY: makeEngine(engine),
      MAX_JOBS_PER_DAY: '100',
      SWEEP_INTERVAL_MS: '600000',
      STRIPE_WEBHOOK_SECRET: SECRET,
      STRIPE_SECRET_KEY: 'sk_test_fake',
      PUBLIC_BASE_URL: 'https://studio.example',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  proc.stdout.on('data', (c) => logs.push(String(c)));
  proc.stderr.on('data', (c) => logs.push(String(c)));
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      if ((await request(port, 'GET', '/api/health')).status === 200) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server never became ready');
    await sleep(50);
  }
  return { proc, port, rendersDir: dir, logs };
}

function stop({ proc, rendersDir }, { keepDir = false } = {}) {
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  if (!keepDir) {
    try { fs.rmSync(rendersDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

async function pay(srv, sessionId = 'cs_test_1') {
  const raw = paidEvent(sessionId);
  const res = await request(srv.port, 'POST', '/api/stripe/webhook', raw,
    { 'Stripe-Signature': sign(raw) });
  await sleep(900);
  return res;
}

const readOrder = (dir, sessionId = 'cs_test_1') =>
  JSON.parse(fs.readFileSync(path.join(dir, '.sessions', `${sessionId}.json`), 'utf8'));

const jobs = (dir) => {
  try { return fs.readdirSync(dir).filter((n) => n.startsWith('job_')); } catch { return []; }
};

// --------------------------------------------------------------------------
// A failed render is refunded
// --------------------------------------------------------------------------

test('a render that fails is refunded in full, automatically', async () => {
  const stripe = await fakeStripe();
  const srv = await startServer({ engine: 'fail', env: { STRIPE_API_BASE: stripe.base } });
  try {
    await pay(srv);
    assert.strictEqual(stripe.refunds.length, 1, 'the customer was not refunded');
    const refund = stripe.refunds[0];
    assert.strictEqual(refund.form.get('payment_intent'), PAYMENT_INTENT);
    // No `amount` field means the whole charge. "Refunded in full" is the
    // policy, and a partial refund would be a quieter way to break it than
    // not refunding at all.
    assert.strictEqual(refund.form.get('amount'), null,
      'a partial refund was requested; the policy promises the full amount');
  } finally {
    stop(srv); stripe.close();
  }
});

test('the refund is recorded against the order', async () => {
  const stripe = await fakeStripe();
  const srv = await startServer({ engine: 'fail', env: { STRIPE_API_BASE: stripe.base } });
  try {
    await pay(srv);
    const order = readOrder(srv.rendersDir);
    assert.strictEqual(order.refund.state, 'refunded');
    assert.strictEqual(order.refund.refundId, 're_1');
    assert.strictEqual(order.refund.amount, 3900);
    // And the order still knows everything it knew before.
    assert.strictEqual(order.paymentIntent, PAYMENT_INTENT);
    assert.strictEqual(order.email, 'buyer@example.com');
  } finally {
    stop(srv); stripe.close();
  }
});

test('a worker that crashes without writing anything is still refunded', async () => {
  // The exit-handler path: no status was ever written by the worker.
  const stripe = await fakeStripe();
  const srv = await startServer({ engine: 'crash', env: { STRIPE_API_BASE: stripe.base } });
  try {
    await pay(srv);
    assert.strictEqual(stripe.refunds.length, 1);
  } finally {
    stop(srv); stripe.close();
  }
});

test('a successful render is NOT refunded', async () => {
  const stripe = await fakeStripe();
  const srv = await startServer({ engine: 'ok', env: { STRIPE_API_BASE: stripe.base } });
  try {
    await pay(srv);
    assert.deepStrictEqual(stripe.refunds, [], 'a delivered program was refunded');
    const order = readOrder(srv.rendersDir);
    assert.strictEqual(order.refund, undefined);
  } finally {
    stop(srv); stripe.close();
  }
});

test('a render with no order behind it refunds nothing', async () => {
  // The ACCESS_CODE path: nothing was ever paid, so there is nothing to give
  // back — and asking Stripe would be an error, not a no-op.
  const stripe = await fakeStripe();
  const srv = await startServer({
    engine: 'fail',
    env: { STRIPE_API_BASE: stripe.base, STRIPE_WEBHOOK_SECRET: '', ACCESS_CODE: 'testcode' },
  });
  try {
    const res = await request(srv.port, 'POST', '/api/programs',
      JSON.stringify({ goal: 'polymath', voiceSet: 'male', accessCode: 'testcode' }));
    assert.strictEqual(res.status, 202, res.body);
    await sleep(900);
    assert.deepStrictEqual(stripe.refunds, []);
  } finally {
    stop(srv); stripe.close();
  }
});

// --------------------------------------------------------------------------
// Exactly one refund
// --------------------------------------------------------------------------

test('a forced mid-job crash produces exactly one refund', async () => {
  // The acceptance criterion, done the way it actually happens: a live worker
  // is killed, so the exit handler fires — and the sweep is invited to fire on
  // the same job at the same time.
  const stripe = await fakeStripe();
  const srv = await startServer({
    engine: 'hang',
    env: { STRIPE_API_BASE: stripe.base, SWEEP_INTERVAL_MS: '250', HARD_TIMEOUT_MS: '1000' },
  });
  try {
    await pay(srv);
    const [job] = jobs(srv.rendersDir);
    assert.ok(job, 'no render started');

    // Kill the worker out from under the server.
    const rec = JSON.parse(fs.readFileSync(path.join(srv.rendersDir, job, 'worker.json'), 'utf8'));
    try { process.kill(rec.pid, 'SIGKILL'); } catch { /* already gone */ }

    // Let the exit handler AND several sweeps run over the same failed job.
    await sleep(2500);

    assert.strictEqual(stripe.refunds.length, 1,
      `${stripe.refunds.length} refunds reached Stripe for one failure`);
    assert.strictEqual(readOrder(srv.rendersDir).refund.state, 'refunded');
  } finally {
    stop(srv); stripe.close();
  }
});

test('the refund request carries a stable idempotency key', async () => {
  // The layer that holds even when the filesystem record is lost: Stripe itself
  // refuses the duplicate.
  const stripe = await fakeStripe();
  const srv = await startServer({ engine: 'fail', env: { STRIPE_API_BASE: stripe.base } });
  try {
    await pay(srv);
    assert.strictEqual(stripe.refunds[0].key, 'refund-cs_test_1');
  } finally {
    stop(srv); stripe.close();
  }
});

test('a lost refund record cannot move the money twice', async () => {
  // Simulates the crash-between-refunding-and-recording case: the evidence is
  // erased and the sweep tries again. Stripe's idempotency is the only thing
  // standing between that and a double refund.
  const stripe = await fakeStripe();
  const srv = await startServer({
    engine: 'fail',
    env: { STRIPE_API_BASE: stripe.base, SWEEP_INTERVAL_MS: '250' },
  });
  try {
    await pay(srv);
    assert.strictEqual(stripe.refunds.length, 1);

    // Erase every trace that the refund happened, and let the sweep run.
    const order = readOrder(srv.rendersDir);
    order.refund = { state: 'failed', attempts: 0, reason: 'the render failed' };
    fs.writeFileSync(path.join(srv.rendersDir, '.sessions', 'cs_test_1.json'),
      JSON.stringify(order));
    await sleep(1200);

    assert.strictEqual(stripe.refunds.length, 1,
      'the money moved twice once the local record was lost');
  } finally {
    stop(srv); stripe.close();
  }
});

// --------------------------------------------------------------------------
// A paid order whose render never started
// --------------------------------------------------------------------------

test('an order that could never be rendered is refunded, not just logged', async () => {
  // budget_exhausted is answered 422, which Stripe does not retry — so without
  // this the customer has paid, has nothing, and no failure path ever runs
  // because there is no job to fail.
  const stripe = await fakeStripe();
  const srv = await startServer({
    engine: 'ok',
    env: {
      STRIPE_API_BASE: stripe.base, MONTHLY_CHAR_BUDGET: '1',
      SWEEP_INTERVAL_MS: '300', REFUND_UNSTARTED_GRACE_MS: '100',
    },
  });
  try {
    const raw = paidEvent();
    const res = await request(srv.port, 'POST', '/api/stripe/webhook', raw,
      { 'Stripe-Signature': sign(raw) });
    assert.strictEqual(res.status, 422, res.body);
    assert.deepStrictEqual(jobs(srv.rendersDir), [], 'a render started with no budget');

    await sleep(1500);
    assert.strictEqual(stripe.refunds.length, 1, 'the customer was never refunded');
    const order = readOrder(srv.rendersDir);
    assert.strictEqual(order.refund.state, 'refunded');
    assert.match(order.refund.reason, /budget_exhausted/);
  } finally {
    stop(srv); stripe.close();
  }
});

test('a refused order is left alone while a retry could still fulfil it', async () => {
  // Stripe retries a 500 within minutes. Refunding immediately would race the
  // retry that is about to succeed.
  const stripe = await fakeStripe();
  const srv = await startServer({
    engine: 'ok',
    env: {
      STRIPE_API_BASE: stripe.base, MONTHLY_CHAR_BUDGET: '1',
      SWEEP_INTERVAL_MS: '300', REFUND_UNSTARTED_GRACE_MS: '900000',
    },
  });
  try {
    const raw = paidEvent();
    await request(srv.port, 'POST', '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    await sleep(1200);
    assert.deepStrictEqual(stripe.refunds, [],
      'an order was refunded while its retry window was still open');
  } finally {
    stop(srv); stripe.close();
  }
});

test('a refunded order is never rendered, however late the retry arrives', async () => {
  // The money has gone back. Delivering afterwards would be giving the program
  // away — and a late Stripe retry of a refused delivery is exactly how.
  const stripe = await fakeStripe();
  const srv = await startServer({
    engine: 'ok',
    env: {
      STRIPE_API_BASE: stripe.base, MONTHLY_CHAR_BUDGET: '1',
      SWEEP_INTERVAL_MS: '300', REFUND_UNSTARTED_GRACE_MS: '100',
    },
  });
  try {
    const raw = paidEvent();
    await request(srv.port, 'POST', '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    await sleep(1500);
    assert.strictEqual(readOrder(srv.rendersDir).refund.state, 'refunded');

    // Stripe retries, long after. Age the claim so it is not simply "someone is
    // mid-spawn", and give the studio budget again so nothing else refuses it.
    const order = readOrder(srv.rendersDir);
    order.claimedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(srv.rendersDir, '.sessions', 'cs_test_1.json'),
      JSON.stringify(order));
    const late = await request(srv.port, 'POST', '/api/stripe/webhook', raw,
      { 'Stripe-Signature': sign(raw) });
    assert.strictEqual(late.status, 200);
    assert.strictEqual(late.json.duplicate, true);
    await sleep(600);
    assert.deepStrictEqual(jobs(srv.rendersDir), [],
      'a refunded order was rendered anyway — the program was given away');
  } finally {
    stop(srv); stripe.close();
  }
});

// --------------------------------------------------------------------------
// The customer can see it
// --------------------------------------------------------------------------

test('the refunded state is visible on the job the customer is watching', async () => {
  const stripe = await fakeStripe();
  const srv = await startServer({ engine: 'fail', env: { STRIPE_API_BASE: stripe.base } });
  try {
    await pay(srv);
    const [job] = jobs(srv.rendersDir);
    const res = await request(srv.port, 'GET', `/api/jobs/${job}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.state, 'failed');
    assert.strictEqual(res.json.refund, 'refunded');
  } finally {
    stop(srv); stripe.close();
  }
});

test('a render with nothing to refund says so, rather than leaving it blank', async () => {
  // The page cannot tell "no refund is coming" from "the refund has not landed
  // yet" unless the server says which. Without this it would wait for something
  // that is never going to arrive, on every unpaid failure.
  const stripe = await fakeStripe();
  const srv = await startServer({
    engine: 'fail',
    env: { STRIPE_API_BASE: stripe.base, STRIPE_WEBHOOK_SECRET: '', ACCESS_CODE: 'testcode' },
  });
  try {
    const started = await request(srv.port, 'POST', '/api/programs',
      JSON.stringify({ goal: 'polymath', voiceSet: 'male', accessCode: 'testcode' }));
    const { jobId } = JSON.parse(started.body);
    await sleep(900);
    const res = await request(srv.port, 'GET', `/api/jobs/${jobId}`);
    assert.strictEqual(res.json.state, 'failed');
    assert.strictEqual(res.json.refund, 'none');
  } finally {
    stop(srv); stripe.close();
  }
});

test('an unrefundable paid order still reaches a terminal state on the page', async () => {
  // Escalating to a human in the log is right, but the customer is watching a
  // page. Leaving `refund` absent would keep it waiting indefinitely.
  const stripe = await fakeStripe();
  const srv = await startServer({
    engine: 'fail',
    env: { STRIPE_API_BASE: stripe.base, STRIPE_SECRET_KEY: '' },
  });
  try {
    await pay(srv);
    const [job] = jobs(srv.rendersDir);
    const res = await request(srv.port, 'GET', `/api/jobs/${job}`);
    assert.strictEqual(res.json.refund, 'failed');
  } finally {
    stop(srv); stripe.close();
  }
});

test('what the customer can see carries no payment details', async () => {
  // #24 keeps the order off this endpoint. A refund id and an amount are still
  // payment data, and "your money is on its way back" is the whole of what
  // someone needs here.
  const stripe = await fakeStripe();
  const srv = await startServer({ engine: 'fail', env: { STRIPE_API_BASE: stripe.base } });
  try {
    await pay(srv);
    const [job] = jobs(srv.rendersDir);
    const res = await request(srv.port, 'GET', `/api/jobs/${job}`);
    for (const secret of [PAYMENT_INTENT, 're_1', 'buyer@example.com', 'cs_test_1', '3900']) {
      assert.ok(!res.body.includes(secret), `the job status leaks ${secret}: ${res.body}`);
    }
  } finally {
    stop(srv); stripe.close();
  }
});

// --------------------------------------------------------------------------
// When the refund itself fails
// --------------------------------------------------------------------------

test('a refused refund is recorded and shouted about, not swallowed', async () => {
  const stripe = await fakeStripe({ refundStatus: 402 });
  const srv = await startServer({ engine: 'fail', env: { STRIPE_API_BASE: stripe.base } });
  try {
    await pay(srv);
    const order = readOrder(srv.rendersDir);
    assert.strictEqual(order.refund.state, 'failed');
    assert.match(order.refund.error, /402/);
    assert.ok(srv.logs.join('').includes('NEEDS A HUMAN'),
      'a customer who paid and has nothing was not escalated');
  } finally {
    stop(srv); stripe.close();
  }
});

test('a refund that fails once is retried by the sweep', async () => {
  // The ways a refund attempt can be lost — a Stripe blip, the process dying
  // mid-refund — must not become a customer who is never refunded.
  const stripe = await fakeStripe({ refundStatus: 500 });
  const srv = await startServer({
    engine: 'fail',
    env: { STRIPE_API_BASE: stripe.base, SWEEP_INTERVAL_MS: '300' },
  });
  try {
    await pay(srv);
    assert.strictEqual(readOrder(srv.rendersDir).refund.state, 'failed');
    stripe.state.refundStatus = 200;         // Stripe comes back
    await sleep(1500);
    assert.strictEqual(readOrder(srv.rendersDir).refund.state, 'refunded',
      'the sweep never retried the owed refund');
    assert.strictEqual(stripe.refunds.length, 1);
  } finally {
    stop(srv); stripe.close();
  }
});

test('the retry gives up rather than calling Stripe forever', async () => {
  const stripe = await fakeStripe({ refundStatus: 402 });
  const srv = await startServer({
    engine: 'fail',
    env: { STRIPE_API_BASE: stripe.base, SWEEP_INTERVAL_MS: '200' },
  });
  try {
    await pay(srv);
    await sleep(2500);
    const attempts = readOrder(srv.rendersDir).refund.attempts;
    assert.ok(attempts <= 5, `the refund was attempted ${attempts} times`);
    assert.strictEqual(readOrder(srv.rendersDir).refund.state, 'failed');
  } finally {
    stop(srv); stripe.close();
  }
});

test('an owed refund survives the retention sweep deleting the job', async () => {
  // The order outlives the audio (#24). A refund still owed when the files age
  // out must still be retryable — the job's back-pointer is inside the
  // directory that just went away.
  const stripe = await fakeStripe({ refundStatus: 500 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-retention-'));
  let srv = await startServer({
    engine: 'fail', rendersDir: dir,
    env: { STRIPE_API_BASE: stripe.base, SWEEP_INTERVAL_MS: '600000' },
  });
  try {
    await pay(srv);
    assert.strictEqual(readOrder(dir).refund.state, 'failed');
    const [job] = jobs(dir);
    const st = JSON.parse(fs.readFileSync(path.join(dir, job, 'status.json'), 'utf8'));
    st.updatedAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(dir, job, 'status.json'), JSON.stringify(st));
  } finally {
    stop(srv, { keepDir: true });
  }

  stripe.state.refundStatus = 200;
  srv = await startServer({
    engine: 'fail', rendersDir: dir,
    env: { STRIPE_API_BASE: stripe.base, SWEEP_INTERVAL_MS: '300', RETENTION_DAYS: '30' },
  });
  try {
    await sleep(1500);
    assert.deepStrictEqual(jobs(dir), [], 'the retention sweep did not run');
    assert.strictEqual(readOrder(dir).refund.state, 'refunded',
      'the refund became unreachable once the job directory was reaped');
  } finally {
    stop(srv, { keepDir: true });
    fs.rmSync(dir, { recursive: true, force: true });
    stripe.close();
  }
});

test('with no Stripe key an owed refund is escalated, not silently dropped', async () => {
  const stripe = await fakeStripe();
  const srv = await startServer({
    engine: 'fail',
    env: { STRIPE_API_BASE: stripe.base, STRIPE_SECRET_KEY: '' },
  });
  try {
    await pay(srv);
    assert.deepStrictEqual(stripe.refunds, []);
    assert.ok(srv.logs.join('').includes('NEEDS A HUMAN'),
      'an unrefundable paid order was not escalated');
  } finally {
    stop(srv); stripe.close();
  }
});
