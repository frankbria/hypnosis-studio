// The Stripe webhook that authorises a render (issue #23).
//
// This endpoint is the only thing standing between an anonymous HTTP request
// and ~16k characters of paid TTS. Everything here is therefore an assertion
// about what does NOT happen: a forged signature starts nothing, a replayed
// event starts nothing a second time, a body edited after signing starts
// nothing.
//
// The signature is computed the way Stripe computes it — HMAC-SHA256 over
// `${timestamp}.${rawBody}` — rather than by calling the same helper the server
// uses, so a bug in that helper cannot make both sides agree on the wrong
// answer.
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

/** POST a raw string body with arbitrary headers — the webhook is byte-sensitive. */
function post(port, p, raw, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST', timeout: 5000,
      headers: {
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
    r.write(raw);
    r.end();
  });
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', timeout: 5000 },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: out }));
      });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.end();
  });
}

/** Stripe's scheme, written out rather than imported from the code under test. */
function sign(raw, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

function completedEvent({
  id = 'evt_1',
  sessionId = 'cs_test_1',
  goal = 'polymath',
  voiceSet = 'male',
  type = 'checkout.session.completed',
  paymentStatus = 'paid',
} = {}) {
  return JSON.stringify({
    id,
    type,
    data: { object: { id: sessionId, payment_status: paymentStatus, metadata: { goal, voiceSet } } },
  });
}

/** An engine that reports success without spending anything. */
function makeEngine() {
  const p = path.join(os.tmpdir(), `hook-engine-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sh`);
  fs.writeFileSync(p, `#!/bin/sh
outdir=""
while [ $# -gt 0 ]; do
  case "$1" in --outdir) outdir="$2"; shift 2;; *) shift;; esac
done
printf '{"jobId":"x","state":"ready","stage":"mastering-qa","progress":1,"detail":"done","updatedAt":"%s"}' \\
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$outdir/status.json"
exit 0
`, { mode: 0o755 });
  return p;
}

async function startServer(env = {}) {
  // A caller may supply the directory when a test needs the same renders volume
  // across two server lifetimes (the resend-recovery cases).
  const dir = env.RENDERS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-'));
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
  const srv = { proc, port, rendersDir: dir };
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      if ((await get(port, '/api/health')).status === 200) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server never became ready');
    await sleep(50);
  }
  return srv;
}

function stop({ proc, rendersDir }) {
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  try { fs.rmSync(rendersDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Job directories the server has created. The only evidence that matters. */
function jobs(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.startsWith('job_'));
  } catch {
    return [];
  }
}

/** Give a started worker a moment to be visible on disk. */
async function settle() {
  await sleep(400);
}

// --------------------------------------------------------------------------
// A genuine event starts the render
// --------------------------------------------------------------------------

test('a signed checkout.session.completed starts the render', async () => {
  const srv = await startServer();
  try {
    const raw = completedEvent();
    const res = await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    assert.strictEqual(res.status, 200, res.body);
    await settle();
    assert.strictEqual(jobs(srv.rendersDir).length, 1, 'no render was started');
  } finally {
    stop(srv);
  }
});

test('the render uses the goal and voice set the session was paid for', async () => {
  const srv = await startServer();
  try {
    const raw = completedEvent({ goal: 'river', voiceSet: 'female' });
    await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    await settle();
    const [id] = jobs(srv.rendersDir);
    assert.ok(id, 'no render was started');
    // The claim record is what #24 will grow into an order; it must already say
    // what was bought, or the link between payment and render is guesswork.
    const claim = JSON.parse(
      fs.readFileSync(path.join(srv.rendersDir, '.sessions', 'cs_test_1.json'), 'utf8'));
    assert.strictEqual(claim.jobId, id);
    assert.strictEqual(claim.goal, 'river');
    assert.strictEqual(claim.voiceSet, 'female');
  } finally {
    stop(srv);
  }
});

// --------------------------------------------------------------------------
// Forgery
// --------------------------------------------------------------------------

test('a forged signature starts nothing', async () => {
  const srv = await startServer();
  try {
    const raw = completedEvent();
    const res = await post(srv.port, '/api/stripe/webhook', raw, {
      'Stripe-Signature': sign(raw, 'whsec_the_wrong_secret'),
    });
    assert.strictEqual(res.status, 400);
    await settle();
    assert.deepStrictEqual(jobs(srv.rendersDir), [], 'a forged event spent TTS credits');
  } finally {
    stop(srv);
  }
});

test('an unsigned request starts nothing', async () => {
  const srv = await startServer();
  try {
    const raw = completedEvent();
    const res = await post(srv.port, '/api/stripe/webhook', raw);
    assert.strictEqual(res.status, 400);
    await settle();
    assert.deepStrictEqual(jobs(srv.rendersDir), []);
  } finally {
    stop(srv);
  }
});

test('a body edited after signing starts nothing', async () => {
  // The signature must cover the bytes that were sent, not a re-serialisation
  // of them. If the server parsed first and re-encoded, this would pass.
  const srv = await startServer();
  try {
    const raw = completedEvent({ goal: 'polymath' });
    const header = sign(raw);
    const tampered = raw.replace('"polymath"', '"river"');
    assert.notStrictEqual(tampered, raw, 'the tamper did not change the body');
    const res = await post(srv.port, '/api/stripe/webhook', tampered, {
      'Stripe-Signature': header,
    });
    assert.strictEqual(res.status, 400);
    await settle();
    assert.deepStrictEqual(jobs(srv.rendersDir), []);
  } finally {
    stop(srv);
  }
});

test('a signature over a re-serialised body is not accepted', async () => {
  // JSON.stringify(JSON.parse(x)) is not x. Signing the round-tripped form and
  // sending the original proves the server verifies against the raw bytes.
  const srv = await startServer();
  try {
    const raw = '{ "id":"evt_1",  "type":"checkout.session.completed",\n'
      + '  "data":{"object":{"id":"cs_test_1","payment_status":"paid",'
      + '"metadata":{"goal":"polymath","voiceSet":"male"}}} }';
    const reserialised = JSON.stringify(JSON.parse(raw));
    assert.notStrictEqual(reserialised, raw, 'the two encodings are identical');
    const res = await post(srv.port, '/api/stripe/webhook', raw, {
      'Stripe-Signature': sign(reserialised),
    });
    assert.strictEqual(res.status, 400);
    await settle();
    assert.deepStrictEqual(jobs(srv.rendersDir), []);
  } finally {
    stop(srv);
  }
});

test('a stale timestamp is rejected even with a valid signature', async () => {
  // Replay protection at the transport level: a captured request stays
  // perfectly signed forever, so the timestamp is what expires it.
  const srv = await startServer();
  try {
    const raw = completedEvent();
    const old = Math.floor(Date.now() / 1000) - 3600;
    const res = await post(srv.port, '/api/stripe/webhook', raw, {
      'Stripe-Signature': sign(raw, SECRET, old),
    });
    assert.strictEqual(res.status, 400);
    await settle();
    assert.deepStrictEqual(jobs(srv.rendersDir), []);
  } finally {
    stop(srv);
  }
});

test('a signature header with no v1 scheme is rejected', async () => {
  const srv = await startServer();
  try {
    const raw = completedEvent();
    const t = Math.floor(Date.now() / 1000);
    const res = await post(srv.port, '/api/stripe/webhook', raw, {
      'Stripe-Signature': `t=${t},v0=deadbeef`,
    });
    assert.strictEqual(res.status, 400);
    await settle();
    assert.deepStrictEqual(jobs(srv.rendersDir), []);
  } finally {
    stop(srv);
  }
});

test('a signature of the wrong length does not crash the comparison', async () => {
  // timingSafeEqual throws on a length mismatch, and a throw in a request
  // handler is how this service has taken an outage before.
  const srv = await startServer();
  try {
    const raw = completedEvent();
    const t = Math.floor(Date.now() / 1000);
    for (const v1 of ['', 'ab', 'z'.repeat(64), 'f'.repeat(200)]) {
      const res = await post(srv.port, '/api/stripe/webhook', raw, {
        'Stripe-Signature': `t=${t},v1=${v1}`,
      });
      assert.strictEqual(res.status, 400, `v1=${v1.slice(0, 8)} gave ${res.status}`);
    }
    // Still serving — the process did not exit on any of them.
    assert.strictEqual((await get(srv.port, '/api/health')).status, 200);
    await settle();
    assert.deepStrictEqual(jobs(srv.rendersDir), []);
  } finally {
    stop(srv);
  }
});

// --------------------------------------------------------------------------
// Replay
// --------------------------------------------------------------------------

test('a replayed event does not start a second render', async () => {
  const srv = await startServer();
  try {
    const raw = completedEvent();
    const header = sign(raw);
    const first = await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': header });
    assert.strictEqual(first.status, 200, first.body);
    await settle();
    // Re-signed so the timestamp is fresh: this is the delivery-retry case, not
    // a captured-packet case, and it is the one Stripe actually does.
    const second = await post(srv.port, '/api/stripe/webhook', raw, {
      'Stripe-Signature': sign(raw),
    });
    assert.strictEqual(second.status, 200, 'a retry must be acknowledged, not failed');
    await settle();
    assert.strictEqual(jobs(srv.rendersDir).length, 1, 'the replay started a second render');
  } finally {
    stop(srv);
  }
});

test('two different sessions each get their own render', async () => {
  // The guard must key on the session, not on "have I seen any event".
  const srv = await startServer();
  try {
    for (const sessionId of ['cs_test_a', 'cs_test_b']) {
      const raw = completedEvent({ sessionId, id: `evt_${sessionId}` });
      const res = await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
      assert.strictEqual(res.status, 200, res.body);
      // Serially: the service renders one at a time, so the second only starts
      // once the first has finished. The stub engine finishes immediately.
      await settle();
    }
    assert.strictEqual(jobs(srv.rendersDir).length, 2, 'the second session was treated as a replay');
  } finally {
    stop(srv);
  }
});

// --------------------------------------------------------------------------
// Recovering a paid order that did not render
//
// The replay guard must not become a trap. Every case below is an order the
// customer has already paid for and has nothing to show for.
// --------------------------------------------------------------------------

test('a resend after the render failed starts a new render', async () => {
  // The original delivery answered 200, so Stripe will not retry on its own.
  // Hitting "Resend event" in the dashboard is the recovery path, and it has to
  // actually recover something.
  const srv = await startServer();
  try {
    const raw = completedEvent();
    await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    await settle();
    const [first] = jobs(srv.rendersDir);
    assert.ok(first, 'no first render');

    // The render failed, and the claim is old enough to no longer read as
    // "another delivery is working on it right now".
    fs.writeFileSync(path.join(srv.rendersDir, first, 'status.json'), JSON.stringify({
      jobId: first, state: 'failed', stage: null, progress: 0, error: 'TTS gave up',
      updatedAt: new Date().toISOString(),
    }));
    const claimFile = path.join(srv.rendersDir, '.sessions', 'cs_test_1.json');
    const claim = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
    claim.claimedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    fs.writeFileSync(claimFile, JSON.stringify(claim));

    const res = await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    assert.strictEqual(res.status, 200, res.body);
    await settle();
    assert.strictEqual(jobs(srv.rendersDir).length, 2,
      'the paid order could not be recovered by a resend');
  } finally {
    stop(srv);
  }
});

test('a resend does not re-render an order that succeeded', async () => {
  const srv = await startServer();
  try {
    const raw = completedEvent();
    await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    await settle();
    // The stub engine writes `ready`. Age the claim past the window so only the
    // job's own outcome decides.
    const claimFile = path.join(srv.rendersDir, '.sessions', 'cs_test_1.json');
    const claim = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
    claim.claimedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    fs.writeFileSync(claimFile, JSON.stringify(claim));

    const res = await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.duplicate, true);
    await settle();
    assert.strictEqual(jobs(srv.rendersDir).length, 1, 'a delivered order was rendered twice');
  } finally {
    stop(srv);
  }
});

test('a claim that could not be read is not rendered again', async () => {
  // "Cannot tell whether this already rendered" must not resolve to spending
  // credits. It is visible in the log and a person can clear the file.
  const srv = await startServer();
  try {
    const raw = completedEvent();
    await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    await settle();
    fs.writeFileSync(path.join(srv.rendersDir, '.sessions', 'cs_test_1.json'), '{ truncated');

    const res = await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.duplicate, true);
    await settle();
    assert.strictEqual(jobs(srv.rendersDir).length, 1);
  } finally {
    stop(srv);
  }
});

test('a refused render leaves the order recorded and still owed', async () => {
  // The studio is out of monthly allowance. The claim must survive — it is the
  // evidence the customer paid — and must not read as delivered.
  const srv = await startServer({ MONTHLY_CHAR_BUDGET: '1' });
  try {
    const raw = completedEvent();
    const res = await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    // Not 500: a spent monthly allowance does not come back inside Stripe's
    // ~3-day retry window, so a transient status drops the order silently.
    assert.strictEqual(res.status, 422, res.body);
    await settle();
    assert.deepStrictEqual(jobs(srv.rendersDir), [], 'a render started with no budget');

    const claim = JSON.parse(
      fs.readFileSync(path.join(srv.rendersDir, '.sessions', 'cs_test_1.json'), 'utf8'));
    assert.strictEqual(claim.jobId, undefined, 'the order claims a render that never started');
    assert.strictEqual(claim.lastError, 'budget_exhausted');
    assert.strictEqual(claim.goal, 'polymath', 'the order does not record what was bought');
  } finally {
    stop(srv);
  }
});

test("Stripe's own retry after a transient refusal is not dropped as a duplicate", async () => {
  // The retry arrives within seconds, well inside the mid-spawn window. Waiting
  // out a clock there dropped the paid order: a fresh claim with no jobId read
  // as "someone is working on it" when in fact the previous attempt had already
  // refused and said so.
  const srv = await startServer({ ENGINE_PY: '/bin/false' });
  try {
    const raw = completedEvent();
    // Occupy the studio so the first delivery is refused as busy.
    fs.mkdirSync(path.join(srv.rendersDir, 'job_occupant'), { recursive: true });
    fs.writeFileSync(path.join(srv.rendersDir, 'job_occupant', 'status.json'), JSON.stringify({
      jobId: 'job_occupant', state: 'rendering', updatedAt: new Date().toISOString(),
    }));

    const first = await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    assert.strictEqual(first.status, 500, 'a busy studio should ask Stripe to retry');
    const claim = JSON.parse(
      fs.readFileSync(path.join(srv.rendersDir, '.sessions', 'cs_test_1.json'), 'utf8'));
    assert.strictEqual(claim.lastError, 'busy');

    // The studio frees up, and Stripe retries — immediately, not in ten minutes.
    fs.rmSync(path.join(srv.rendersDir, 'job_occupant'), { recursive: true, force: true });
    const retry = await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    assert.strictEqual(retry.status, 200, retry.body);
    assert.notStrictEqual(retry.json.duplicate, true, 'the retry was dropped as a duplicate');
    await settle();
    assert.strictEqual(jobs(srv.rendersDir).length, 1, 'the paid order never rendered');
  } finally {
    stop(srv);
  }
});

test('a render whose session link was not recorded is not rendered twice', async () => {
  // If the write that records the jobId on the claim fails, the claim is
  // indistinguishable from one whose render never started — and re-rendering
  // spends credits on a program the customer already has. The job records its
  // own session so the answer does not depend on that write.
  const srv = await startServer();
  try {
    const raw = completedEvent();
    await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    await settle();
    const [job] = jobs(srv.rendersDir);
    assert.ok(job, 'no render started');
    assert.strictEqual(
      JSON.parse(fs.readFileSync(path.join(srv.rendersDir, job, 'order.json'), 'utf8')).sessionId,
      'cs_test_1', 'the job does not record which purchase it belongs to');

    // Simulate the failed link write: an aged claim that never got its jobId.
    fs.writeFileSync(path.join(srv.rendersDir, '.sessions', 'cs_test_1.json'), JSON.stringify({
      sessionId: 'cs_test_1', goal: 'polymath', voiceSet: 'male',
      claimedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    }));

    const res = await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.duplicate, true, 'a delivered order was rendered again');
    await settle();
    assert.strictEqual(jobs(srv.rendersDir).length, 1);
  } finally {
    stop(srv);
  }
});

test('a session with both a failed and a delivered render is not rendered again', async () => {
  // Recovering a failed render is what leaves a session with two jobs, and
  // readdir order is not creation order. Answering from whichever came back
  // first lets the failed one speak for the delivered one.
  const srv = await startServer();
  try {
    const raw = completedEvent();
    await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    await settle();
    const [delivered] = jobs(srv.rendersDir);
    assert.ok(delivered, 'no render started');

    // An earlier, failed attempt at the same session. Named to sort BEFORE the
    // delivered one, so a first-match implementation picks it.
    const failed = 'job_aaaaaaaaaaaa';
    assert.ok(failed < delivered, 'the fixture no longer sorts first');
    fs.mkdirSync(path.join(srv.rendersDir, failed), { recursive: true });
    fs.writeFileSync(path.join(srv.rendersDir, failed, 'order.json'),
      JSON.stringify({ sessionId: 'cs_test_1' }));
    fs.writeFileSync(path.join(srv.rendersDir, failed, 'status.json'), JSON.stringify({
      jobId: failed, state: 'failed', error: 'an earlier attempt',
      updatedAt: new Date().toISOString(),
    }));

    // Age the claim and strip its jobId, so the decision rests entirely on the
    // jobs themselves.
    fs.writeFileSync(path.join(srv.rendersDir, '.sessions', 'cs_test_1.json'), JSON.stringify({
      sessionId: 'cs_test_1', goal: 'polymath', voiceSet: 'male',
      claimedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    }));

    const res = await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.duplicate, true, 'a delivered order was rendered again');
    await settle();
    assert.strictEqual(jobs(srv.rendersDir).length, 2, 'a third render was started');
  } finally {
    stop(srv);
  }
});

test('a paid order refused at the time is rendered when the event is resent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-recover-'));
  const raw = completedEvent();
  let srv = await startServer({ RENDERS_DIR: dir, MONTHLY_CHAR_BUDGET: '1' });
  try {
    const res = await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    assert.strictEqual(res.status, 422, res.body);
    await settle();
    assert.deepStrictEqual(jobs(dir), []);
  } finally {
    try { srv.proc.kill('SIGKILL'); } catch { /* gone */ }
  }

  // Age the claim past the "someone is on it" window, then resend.
  const claimFile = path.join(dir, '.sessions', 'cs_test_1.json');
  const claim = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
  claim.claimedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  fs.writeFileSync(claimFile, JSON.stringify(claim));

  srv = await startServer({ RENDERS_DIR: dir });
  try {
    const res = await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    assert.strictEqual(res.status, 200, res.body);
    await settle();
    assert.strictEqual(jobs(dir).length, 1, 'the recovered order still did not render');
  } finally {
    stop({ proc: srv.proc, rendersDir: dir });
  }
});

// --------------------------------------------------------------------------
// Events that are not a completed purchase
// --------------------------------------------------------------------------

test('an event of another type is acknowledged and starts nothing', async () => {
  const srv = await startServer();
  try {
    const raw = completedEvent({ type: 'payment_intent.created' });
    const res = await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    // 200, not an error: Stripe sends whatever the endpoint is subscribed to,
    // and failing on an uninteresting event makes it retry for days.
    assert.strictEqual(res.status, 200);
    await settle();
    assert.deepStrictEqual(jobs(srv.rendersDir), []);
  } finally {
    stop(srv);
  }
});

test('a completed session that was not paid starts nothing', async () => {
  // checkout.session.completed fires for asynchronous payment methods before
  // the money has actually arrived.
  const srv = await startServer();
  try {
    const raw = completedEvent({ paymentStatus: 'unpaid' });
    const res = await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    assert.strictEqual(res.status, 200);
    await settle();
    assert.deepStrictEqual(jobs(srv.rendersDir), [], 'an unpaid session spent TTS credits');
  } finally {
    stop(srv);
  }
});

test('a session whose metadata names no valid program starts nothing', async () => {
  const srv = await startServer();
  try {
    const raw = completedEvent({ goal: 'not_a_goal' });
    const res = await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    // Deliberately not 2xx: this is a paid order the studio cannot fulfil, and
    // it must show up as a failed delivery in the Stripe dashboard rather than
    // disappear silently.
    assert.strictEqual(res.status, 422);
    await settle();
    assert.deepStrictEqual(jobs(srv.rendersDir), []);
  } finally {
    stop(srv);
  }
});

test('a session id that is not a plain identifier starts nothing', async () => {
  // The id becomes a filename. It arrives inside a verified payload, but a
  // path separator reaching writeFileSync is not something to leave to trust.
  const srv = await startServer();
  try {
    const raw = completedEvent({ sessionId: '../../etc/passwd' });
    const res = await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    assert.strictEqual(res.status, 422);
    await settle();
    assert.deepStrictEqual(jobs(srv.rendersDir), []);
  } finally {
    stop(srv);
  }
});

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

test('with no webhook secret the endpoint refuses instead of trusting the body', async () => {
  const srv = await startServer({ STRIPE_WEBHOOK_SECRET: '' });
  try {
    const raw = completedEvent();
    const res = await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    assert.strictEqual(res.status, 503);
    await settle();
    assert.deepStrictEqual(jobs(srv.rendersDir), []);
  } finally {
    stop(srv);
  }
});

test('the free render path closes as soon as payment is wired up', async () => {
  // ACCESS_CODE is a shared, unrate-limited string that spends real credits and
  // whose value is in git history (#32). The moment a verified webhook can
  // authorise a render, it is the only thing that should.
  const srv = await startServer({ ACCESS_CODE: 'testcode' });
  try {
    const res = await post(srv.port, '/api/programs',
      JSON.stringify({ goal: 'polymath', voiceSet: 'male', accessCode: 'testcode' }));
    assert.strictEqual(res.status, 503, 'the access-code path still spends credits');
    assert.strictEqual(res.json.error, 'rendering_requires_payment');
    await settle();
    assert.deepStrictEqual(jobs(srv.rendersDir), []);
  } finally {
    stop(srv);
  }
});

test('the access-code path still works while payment is not configured', async () => {
  // The prototype has to keep working until an operator turns payments on.
  const srv = await startServer({ ACCESS_CODE: 'testcode', STRIPE_WEBHOOK_SECRET: '' });
  try {
    const res = await post(srv.port, '/api/programs',
      JSON.stringify({ goal: 'polymath', voiceSet: 'male', accessCode: 'testcode' }));
    assert.strictEqual(res.status, 202, res.body);
    await settle();
    assert.strictEqual(jobs(srv.rendersDir).length, 1);
  } finally {
    stop(srv);
  }
});

test('GET is not a way to reach the webhook', async () => {
  const srv = await startServer();
  try {
    assert.strictEqual((await get(srv.port, '/api/stripe/webhook')).status, 404);
    await settle();
    assert.deepStrictEqual(jobs(srv.rendersDir), []);
  } finally {
    stop(srv);
  }
});

test('an oversized body is refused rather than buffered', async () => {
  const srv = await startServer();
  try {
    const raw = JSON.stringify({ pad: 'x'.repeat(200 * 1024) });
    let res;
    try {
      res = await post(srv.port, '/api/stripe/webhook', raw, { 'Stripe-Signature': sign(raw) });
    } catch {
      res = { status: 'connection destroyed' };   // the cap may cut the socket
    }
    assert.notStrictEqual(res.status, 200);
    assert.strictEqual((await get(srv.port, '/api/health')).status, 200, 'the server died');
    await settle();
    assert.deepStrictEqual(jobs(srv.rendersDir), []);
  } finally {
    stop(srv);
  }
});
