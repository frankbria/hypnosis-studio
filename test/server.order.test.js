// The order record (issue #24).
//
// Nothing tied a render to a buyer, so a refund (#26), a delivery email (#27)
// and a re-download were all impossible. This is that record.
//
// Two properties carry the weight here. It must SURVIVE — including past the
// retention sweep that deletes the audio, because a refund request arrives
// after the files are gone, not before. And it must not LEAK: the job status
// endpoint is public and unauthenticated, and an order carries an email address
// and a payment reference.
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
const EMAIL = 'buyer@example.com';
const PAYMENT_INTENT = 'pi_test_12345';
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
      host: '127.0.0.1', port, path: p, method, timeout: 5000,
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

function sign(raw, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

/** A completed session as Stripe actually sends one. */
function paidEvent({
  sessionId = 'cs_test_1',
  goal = 'polymath',
  voiceSet = 'male',
  paymentIntent = PAYMENT_INTENT,
  email = EMAIL,
  customerEmail = null,
  amountTotal = 3900,
  currency = 'usd',
} = {}) {
  const object = {
    id: sessionId,
    payment_status: 'paid',
    payment_intent: paymentIntent,
    amount_total: amountTotal,
    currency,
    customer_details: email === null ? {} : { email },
    metadata: { goal, voiceSet },
  };
  if (customerEmail !== null) object.customer_email = customerEmail;
  return JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object } });
}

function makeEngine() {
  const p = path.join(os.tmpdir(), `order-engine-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sh`);
  fs.writeFileSync(p, `#!/bin/sh
outdir=""
while [ $# -gt 0 ]; do
  case "$1" in --outdir) outdir="$2"; shift 2;; *) shift;; esac
done
printf '{"tracks":[{"n":1,"id":"t1","title":"I","phase":"induction","durationSec":700,"mp3":"t1.mp3","wav":"t1.wav"}]}' > "$outdir/manifest.json"
: > "$outdir/t1.mp3"; : > "$outdir/t1.wav"
printf '{"jobId":"x","state":"ready","stage":"mastering-qa","progress":1,"detail":"done","updatedAt":"%s"}' \\
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$outdir/status.json"
exit 0
`, { mode: 0o755 });
  return p;
}

async function startServer(env = {}) {
  const dir = env.RENDERS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'order-'));
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      HYPNO_NO_DOTENV: '1',
      PORT: String(port),
      RENDERS_DIR: dir,
      ENGINE_PY: makeEngine(),
      MAX_JOBS_PER_DAY: '100',
      SWEEP_INTERVAL_MS: '600000',
      STRIPE_WEBHOOK_SECRET: SECRET,
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

function stop({ proc, rendersDir }, { keepDir = false } = {}) {
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  if (!keepDir) {
    try { fs.rmSync(rendersDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function jobs(dir) {
  try { return fs.readdirSync(dir).filter((n) => n.startsWith('job_')); } catch { return []; }
}

function order(dir, sessionId = 'cs_test_1') {
  return JSON.parse(fs.readFileSync(path.join(dir, '.sessions', `${sessionId}.json`), 'utf8'));
}

async function pay(srv, opts) {
  const raw = paidEvent(opts);
  const res = await request(srv.port, 'POST', '/api/stripe/webhook', raw,
    { 'Stripe-Signature': sign(raw) });
  await sleep(400);
  return res;
}

// --------------------------------------------------------------------------
// What is recorded
// --------------------------------------------------------------------------

test('the order records the payment intent and the customer email', async () => {
  const srv = await startServer();
  try {
    const res = await pay(srv);
    assert.strictEqual(res.status, 200, res.body);
    const rec = order(srv.rendersDir);
    assert.strictEqual(rec.paymentIntent, PAYMENT_INTENT);
    assert.strictEqual(rec.email, EMAIL);
    assert.strictEqual(rec.sessionId, 'cs_test_1');
  } finally {
    stop(srv);
  }
});

test('the order records what was paid, not what the price happens to be now', async () => {
  // A refund (#26) has to return the amount actually taken. Reading today's
  // PROGRAM_PRICE_CENTS would refund the wrong number after any price change.
  const srv = await startServer();
  try {
    await pay(srv, { amountTotal: 4900, currency: 'gbp' });
    const rec = order(srv.rendersDir);
    assert.strictEqual(rec.amountTotal, 4900);
    assert.strictEqual(rec.currency, 'gbp');
  } finally {
    stop(srv);
  }
});

test('the order and the job point at each other', async () => {
  const srv = await startServer();
  try {
    await pay(srv);
    const [job] = jobs(srv.rendersDir);
    assert.ok(job, 'no render started');
    assert.strictEqual(order(srv.rendersDir).jobId, job);
    const backPointer = JSON.parse(
      fs.readFileSync(path.join(srv.rendersDir, job, 'order.json'), 'utf8'));
    assert.strictEqual(backPointer.sessionId, 'cs_test_1',
      'the job cannot find the order it belongs to');
  } finally {
    stop(srv);
  }
});

test('customer_email is used when customer_details has none', async () => {
  // Stripe populates one or the other depending on how the session was created.
  const srv = await startServer();
  try {
    await pay(srv, { email: null, customerEmail: 'fallback@example.com' });
    assert.strictEqual(order(srv.rendersDir).email, 'fallback@example.com');
  } finally {
    stop(srv);
  }
});

test('a session with no email still renders and records the rest', async () => {
  // The render is paid for. Refusing it because an optional field is absent
  // would be taking money and delivering nothing over a missing string.
  const srv = await startServer();
  try {
    const res = await pay(srv, { email: null });
    assert.strictEqual(res.status, 200, res.body);
    assert.strictEqual(jobs(srv.rendersDir).length, 1, 'a paid order did not render');
    const rec = order(srv.rendersDir);
    assert.strictEqual(rec.email, null);
    assert.strictEqual(rec.paymentIntent, PAYMENT_INTENT);
  } finally {
    stop(srv);
  }
});

test('a payment intent sent as an expanded object is still recorded as its id', async () => {
  // Stripe sends `payment_intent` as a string id, or as the whole object when
  // the endpoint expands it. Storing "[object Object]" would make the refund in
  // #26 fail at the moment it is needed.
  const srv = await startServer();
  try {
    const raw = JSON.stringify({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_1', payment_status: 'paid',
          payment_intent: { id: 'pi_expanded_9', object: 'payment_intent' },
          amount_total: 3900, currency: 'usd',
          customer_details: { email: EMAIL },
          metadata: { goal: 'polymath', voiceSet: 'male' },
        },
      },
    });
    await request(srv.port, 'POST', '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    await sleep(400);
    assert.strictEqual(order(srv.rendersDir).paymentIntent, 'pi_expanded_9');
  } finally {
    stop(srv);
  }
});

test('an order refused a render still records who paid and what for', async () => {
  // This is the case a refund exists for: money taken, nothing rendered.
  const srv = await startServer({ MONTHLY_CHAR_BUDGET: '1' });
  try {
    await pay(srv);
    const rec = order(srv.rendersDir);
    assert.strictEqual(rec.paymentIntent, PAYMENT_INTENT);
    assert.strictEqual(rec.email, EMAIL);
    assert.strictEqual(rec.lastError, 'budget_exhausted');
    assert.strictEqual(rec.jobId, undefined);
  } finally {
    stop(srv);
  }
});

// --------------------------------------------------------------------------
// Durability
// --------------------------------------------------------------------------

test('the order survives a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-restart-'));
  let srv = await startServer({ RENDERS_DIR: dir });
  try {
    await pay(srv);
  } finally {
    stop(srv, { keepDir: true });
  }
  assert.strictEqual(order(dir).email, EMAIL, 'the order did not survive the process');

  srv = await startServer({ RENDERS_DIR: dir });
  try {
    // And the restarted server still reads it as an order it has handled.
    const res = await pay(srv);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.duplicate, true, 'a restart lost the order');
  } finally {
    stop(srv, { keepDir: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the order outlives the audio the retention sweep deletes', async () => {
  // A refund request arrives after the files are gone, not before. An order
  // stored inside the job directory would be deleted with it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-retention-'));
  let srv = await startServer({ RENDERS_DIR: dir, RETENTION_DAYS: '30' });
  try {
    await pay(srv);
    const [job] = jobs(dir);
    assert.ok(job, 'no render started');
    // Age the job past the window.
    const st = JSON.parse(fs.readFileSync(path.join(dir, job, 'status.json'), 'utf8'));
    st.updatedAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(dir, job, 'status.json'), JSON.stringify(st));
  } finally {
    stop(srv, { keepDir: true });
  }

  // A restart runs the sweep on boot.
  srv = await startServer({ RENDERS_DIR: dir, RETENTION_DAYS: '30' });
  try {
    await sleep(600);
    assert.deepStrictEqual(jobs(dir), [], 'the sweep did not run');
    const rec = order(dir);
    assert.strictEqual(rec.email, EMAIL, 'the order was deleted with the audio');
    assert.strictEqual(rec.paymentIntent, PAYMENT_INTENT);
  } finally {
    stop(srv, { keepDir: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the order is written atomically', async () => {
  // Via temp + rename, the same way status.json is written. A half-written
  // order is unparseable, and #23 treats an unparseable claim as "cannot tell",
  // which strands a paid order.
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const fn = src.slice(src.indexOf('function writeClaim'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /\.tmp/, 'the order is not written through a temp file');
  assert.match(body, /renameSync/, 'the order is not renamed into place');
});

// --------------------------------------------------------------------------
// It must not leak
// --------------------------------------------------------------------------

test('the job status says what it is rendering, so a resumed page can draw itself', async () => {
  // A page arriving at /program/<id> knowing only the job id has none of the
  // wizard's state (#27). The goal and voice set are what its copy is built
  // from, and they must survive the worker rewriting status.json wholesale.
  const srv = await startServer();
  try {
    await pay(srv, { goal: 'river', voiceSet: 'female' });
    const [job] = jobs(srv.rendersDir);
    const res = await request(srv.port, 'GET', `/api/jobs/${job}`);
    assert.strictEqual(res.json.goal, 'river');
    assert.strictEqual(res.json.voiceSet, 'female');
    // The worker has already written `ready` over status.json by now, which is
    // exactly why this lives in a sidecar rather than in that file.
    assert.strictEqual(res.json.state, 'ready');
  } finally {
    stop(srv);
  }
});

test('the job status endpoint exposes no part of the order', async () => {
  const srv = await startServer();
  try {
    await pay(srv);
    const [job] = jobs(srv.rendersDir);
    const res = await request(srv.port, 'GET', `/api/jobs/${job}`);
    assert.strictEqual(res.status, 200, res.body);
    for (const secret of [EMAIL, PAYMENT_INTENT, 'cs_test_1', 'example.com']) {
      assert.ok(!res.body.includes(secret),
        `the public job status leaks ${secret}: ${res.body}`);
    }
    for (const field of ['email', 'paymentIntent', 'sessionId', 'amountTotal', 'customer']) {
      assert.ok(!Object.keys(res.json).includes(field), `status.json exposes ${field}`);
    }
    // And it still answers the question it exists to answer.
    assert.strictEqual(res.json.state, 'ready');
  } finally {
    stop(srv);
  }
});

test('the order back-pointer is not downloadable as a job file', async () => {
  // The file endpoint allowlists from the manifest's tracks, so this should
  // already hold — pinned because the order now sits in that directory.
  const srv = await startServer();
  try {
    await pay(srv);
    const [job] = jobs(srv.rendersDir);
    for (const name of ['order.json', 'status.json', 'manifest.json', 'worker.json']) {
      const res = await request(srv.port, 'GET', `/api/jobs/${job}/files/${name}`);
      assert.strictEqual(res.status, 404, `${name} is downloadable`);
    }
    // The real tracks still are.
    assert.strictEqual((await request(srv.port, 'GET', `/api/jobs/${job}/files/t1.mp3`)).status, 200);
  } finally {
    stop(srv);
  }
});

test('the orders directory is not reachable as a job', async () => {
  const srv = await startServer();
  try {
    await pay(srv);
    for (const p of ['/api/jobs/.sessions', '/api/jobs/.sessions/cs_test_1.json']) {
      const res = await request(srv.port, 'GET', p);
      assert.ok(res.status === 404 || res.status === 400, `${p} answered ${res.status}`);
      assert.ok(!res.body.includes(EMAIL), `${p} leaks the customer email`);
    }
  } finally {
    stop(srv);
  }
});

test('the orders directory is not served as a static file', async () => {
  // The static handler serves from web/dist, but a path-traversal regression
  // would reach the renders volume. Cheap to pin.
  const srv = await startServer();
  try {
    await pay(srv);
    for (const p of ['/.sessions/cs_test_1.json', '/../renders/.sessions/cs_test_1.json']) {
      const res = await request(srv.port, 'GET', p);
      assert.ok(!res.body.includes(EMAIL), `${p} leaks the customer email`);
    }
  } finally {
    stop(srv);
  }
});
