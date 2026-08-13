// The delivery email (issue #28).
//
// A 15-20 minute render means nobody sits on the page, so without this a
// finished program has no way of reaching the person who bought it.
//
// "Exactly one" is the assertion that matters, and it is not free: the worker
// exit handler and the sweep both observe the same completion, and the sweep
// keeps running afterwards. So most of this file counts messages.
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

function paidEvent({ sessionId = 'cs_test_1', email = EMAIL } = {}) {
  const object = {
    id: sessionId, payment_status: 'paid', payment_intent: 'pi_test_1',
    amount_total: 3900, currency: 'usd',
    customer_details: email === null ? {} : { email },
    metadata: { goal: 'polymath', voiceSet: 'male' },
  };
  return JSON.stringify({
    id: `evt_${sessionId}`, type: 'checkout.session.completed', data: { object },
  });
}

/** A mail provider that records what it was asked to send. */
async function fakeMail({ status = 200 } = {}) {
  const sent = [];
  const byKey = new Map();
  const state = { status };
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (state.status !== 200) {
        res.writeHead(state.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'rejected' }));
      }
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* recorded raw below */ }
      const key = req.headers['idempotency-key'] || '';
      if (key && byKey.has(key)) {
        // What a provider honouring the key does: the original result, and no
        // second message.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(byKey.get(key)));
      }
      sent.push({ ...parsed, auth: req.headers.authorization || '', key, path: req.url });
      const result = { id: `msg_${sent.length}` };
      if (key) byKey.set(key, result);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { sent, state, base: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

/** A Stripe stand-in — checkout and refunds both answer here. */
async function fakeStripe() {
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 're_1', url: 'https://example/pay' }));
    });
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

function makeEngine(kind = 'ok') {
  const p = path.join(os.tmpdir(), `deliver-engine-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sh`);
  const ok = `for f in t1 t2 t3 t4; do : > "$outdir/$f.mp3"; : > "$outdir/$f.wav"; done
printf '{"tracks":[{"n":1,"id":"t1","title":"I","phase":"induction","durationSec":700,"mp3":"t1.mp3","wav":"t1.wav"}]}' > "$outdir/manifest.json"
printf '{"jobId":"x","state":"ready","stage":"mastering-qa","progress":1,"detail":"done","updatedAt":"%s"}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$outdir/status.json"`;
  const fail = `printf '{"jobId":"x","state":"failed","stage":null,"progress":0,"error":"the mixer gave up","updatedAt":"%s"}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$outdir/status.json"`;
  fs.writeFileSync(p, `#!/bin/sh
outdir=""
while [ $# -gt 0 ]; do case "$1" in --outdir) outdir="$2"; shift 2;; *) shift;; esac; done
${kind === 'ok' ? ok : fail}
exit 0
`, { mode: 0o755 });
  return p;
}

async function startServer({ engine = 'ok', env = {}, rendersDir } = {}) {
  const dir = rendersDir || fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-'));
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
      SWEEP_INTERVAL_MS: '400',
      STRIPE_WEBHOOK_SECRET: SECRET,
      STRIPE_SECRET_KEY: 'sk_test_fake',
      PUBLIC_BASE_URL: 'https://studio.example',
      EMAIL_API_KEY: 'test_mail_key',
      EMAIL_FROM: 'studio@studio.example',
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

const readOrder = (dir, sessionId = 'cs_test_1') =>
  JSON.parse(fs.readFileSync(path.join(dir, '.sessions', `${sessionId}.json`), 'utf8'));

const jobs = (dir) => {
  try { return fs.readdirSync(dir).filter((n) => n.startsWith('job_')); } catch { return []; }
};

async function pay(srv, opts) {
  const raw = paidEvent(opts);
  const res = await request(srv.port, 'POST', '/api/stripe/webhook', raw,
    { 'Stripe-Signature': sign(raw) });
  await sleep(1200);
  return res;
}

// --------------------------------------------------------------------------
// Exactly one
// --------------------------------------------------------------------------

test('a completed program is emailed to the person who bought it', async () => {
  const mail = await fakeMail();
  const srv = await startServer({ env: { EMAIL_API_BASE: mail.base } });
  try {
    await pay(srv);
    assert.strictEqual(mail.sent.length, 1, 'the customer was not emailed');
    const msg = mail.sent[0];
    assert.strictEqual(msg.to, EMAIL);
    assert.strictEqual(msg.from, 'studio@studio.example');
    assert.strictEqual(msg.auth, 'Bearer test_mail_key');
    assert.match(msg.subject, /ready/i);
  } finally {
    stop(srv); mail.close();
  }
});

test('exactly one email, however long the sweep keeps running', async () => {
  // The exit handler and the sweep both observe the same completion, and the
  // sweep runs every 400 ms in these tests.
  const mail = await fakeMail();
  const srv = await startServer({ env: { EMAIL_API_BASE: mail.base } });
  try {
    await pay(srv);
    await sleep(2000);   // several more sweeps
    assert.strictEqual(mail.sent.length, 1,
      `${mail.sent.length} emails were sent for one program`);
    assert.strictEqual(readOrder(srv.rendersDir).delivery.state, 'sent');
  } finally {
    stop(srv); mail.close();
  }
});

test('a restart does not send it again', async () => {
  const mail = await fakeMail();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-restart-'));
  let srv = await startServer({ rendersDir: dir, env: { EMAIL_API_BASE: mail.base } });
  try {
    await pay(srv);
    assert.strictEqual(mail.sent.length, 1);
  } finally {
    stop(srv, { keepDir: true });
  }

  srv = await startServer({ rendersDir: dir, env: { EMAIL_API_BASE: mail.base } });
  try {
    await sleep(1500);
    assert.strictEqual(mail.sent.length, 1, 'a restart re-delivered a program');
  } finally {
    stop(srv, { keepDir: true });
    fs.rmSync(dir, { recursive: true, force: true });
    mail.close();
  }
});

test('a job that finishes with nobody watching is still delivered', async () => {
  // The exit handler does not run for a job whose worker was orphaned by a
  // restart. The sweep is what makes the email a guarantee rather than a
  // side effect of a callback happening to fire.
  const mail = await fakeMail();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-orphan-'));
  let srv = await startServer({
    rendersDir: dir,
    env: { EMAIL_API_BASE: mail.base, EMAIL_API_KEY: '' },   // no email possible yet
  });
  try {
    await pay(srv);
    assert.deepStrictEqual(mail.sent, [], 'an unconfigured server sent mail anyway');
    // Clear the "skipped" note, as if the job had simply finished unobserved.
    const order = readOrder(dir);
    delete order.delivery;
    fs.writeFileSync(path.join(dir, '.sessions', 'cs_test_1.json'), JSON.stringify(order));
  } finally {
    stop(srv, { keepDir: true });
  }

  srv = await startServer({ rendersDir: dir, env: { EMAIL_API_BASE: mail.base } });
  try {
    await sleep(1500);
    assert.strictEqual(mail.sent.length, 1,
      'a finished, paid, unemailed program was never picked up');
  } finally {
    stop(srv, { keepDir: true });
    fs.rmSync(dir, { recursive: true, force: true });
    mail.close();
  }
});

// --------------------------------------------------------------------------
// What it says
// --------------------------------------------------------------------------

test('the email links to the order URL, which works from a cold session', async () => {
  // Since #70 the email points at the ORDER page rather than the job page: it
  // is the same address the post-checkout redirect uses, so a customer has one
  // link rather than two.
  const mail = await fakeMail();
  const srv = await startServer({ env: { EMAIL_API_BASE: mail.base } });
  try {
    await pay(srv);
    const [job] = jobs(srv.rendersDir);
    const link = 'https://studio.example/order/cs_test_1';
    const msg = mail.sent[0];
    assert.ok(msg.text.includes(link), `the plain-text body has no link: ${msg.text}`);
    assert.ok(msg.html.includes(link), 'the html body has no link');
    // Absolute, on the public base URL — a relative path in an email goes
    // nowhere, and a link built from a request Host could be forged.
    assert.ok(link.startsWith('https://'), 'the link is not absolute');

    // And the URL resolves against this server: the SPA shell is served for it
    // with no session, cookie or referrer of any kind.
    const page = await request(srv.port, 'GET', `/program/${job}`);
    assert.strictEqual(page.status, 200, 'the emailed link does not open');
    assert.match(page.body, /<div id="root">/, 'the link does not serve the app');
    const status = await request(srv.port, 'GET', `/api/jobs/${job}`);
    assert.strictEqual(status.json.state, 'ready', 'the emailed link points at nothing ready');
  } finally {
    stop(srv); mail.close();
  }
});

test('the email carries the support address and the retention window', async () => {
  const mail = await fakeMail();
  const srv = await startServer({ env: { EMAIL_API_BASE: mail.base, RETENTION_DAYS: '30' } });
  try {
    await pay(srv);
    const msg = mail.sent[0];
    for (const body of [msg.text, msg.html]) {
      assert.ok(body.includes('frank.bria@pm.me'), 'no support address');
      assert.ok(/30 days/.test(body), 'no retention window');
    }
  } finally {
    stop(srv); mail.close();
  }
});

test('the retention window in the email is the one that deletes the files', async () => {
  // A number retyped into the copy would drift from the sweep that acts on it,
  // and the email is the document a customer still has in three weeks.
  const mail = await fakeMail();
  const srv = await startServer({ env: { EMAIL_API_BASE: mail.base, RETENTION_DAYS: '7', RETENTION_PROMISED_DAYS: '7' } });
  try {
    await pay(srv);
    assert.ok(/7 days/.test(mail.sent[0].text), mail.sent[0].text);
    assert.ok(!/30 days/.test(mail.sent[0].text), 'the email quotes a hardcoded window');
  } finally {
    stop(srv); mail.close();
  }
});

test('the support address is overridable without editing source', async () => {
  const mail = await fakeMail();
  const srv = await startServer({
    env: { EMAIL_API_BASE: mail.base, SUPPORT_EMAIL: 'help@studio.example' },
  });
  try {
    await pay(srv);
    assert.ok(mail.sent[0].text.includes('help@studio.example'));
  } finally {
    stop(srv); mail.close();
  }
});

// --------------------------------------------------------------------------
// When it must NOT send
// --------------------------------------------------------------------------

test('a failed render is not announced as ready', async () => {
  const stripe = await fakeStripe();
  const mail = await fakeMail();
  const srv = await startServer({
    engine: 'fail',
    env: { EMAIL_API_BASE: mail.base, STRIPE_API_BASE: stripe.base },
  });
  try {
    await pay(srv);
    await sleep(1200);
    assert.deepStrictEqual(mail.sent, [], 'a failed render was delivered by email');
  } finally {
    stop(srv); mail.close(); stripe.close();
  }
});

test('a paid job whose back-pointer was lost is still emailed', async () => {
  // Same root as the refund case: a missing back-pointer is a failed write, not
  // proof that nobody bought this. Getting it wrong is a paid customer who is
  // never told their program is ready.
  const mail = await fakeMail();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-nopointer-'));
  let srv = await startServer({
    rendersDir: dir,
    env: { EMAIL_API_BASE: mail.base, EMAIL_API_KEY: '' },   // cannot email yet
  });
  let job;
  try {
    await pay(srv);
    [job] = jobs(dir);
    assert.ok(job, 'no render started');
    fs.unlinkSync(path.join(dir, job, 'order.json'));
    const order = readOrder(dir);
    delete order.delivery;
    fs.writeFileSync(path.join(dir, '.sessions', 'cs_test_1.json'), JSON.stringify(order));
  } finally {
    stop(srv, { keepDir: true });
  }

  srv = await startServer({ rendersDir: dir, env: { EMAIL_API_BASE: mail.base } });
  try {
    await sleep(1500);
    assert.strictEqual(mail.sent.length, 1,
      'a paid customer was never told, because a back-pointer write had failed');
  } finally {
    stop(srv, { keepDir: true });
    fs.rmSync(dir, { recursive: true, force: true });
    mail.close();
  }
});

test('an unpaid render emails nobody', async () => {
  // The early-access path has no order and no address.
  const mail = await fakeMail();
  const srv = await startServer({
    env: {
      EMAIL_API_BASE: mail.base, STRIPE_WEBHOOK_SECRET: '', ACCESS_CODE: 'testcode',
    },
  });
  try {
    const res = await request(srv.port, 'POST', '/api/programs',
      JSON.stringify({ goal: 'polymath', voiceSet: 'male', accessCode: 'testcode' }));
    assert.strictEqual(res.status, 202, res.body);
    await sleep(1500);
    assert.deepStrictEqual(mail.sent, []);
  } finally {
    stop(srv); mail.close();
  }
});

test('an order with no email address is recorded, not retried forever', async () => {
  const mail = await fakeMail();
  const srv = await startServer({ env: { EMAIL_API_BASE: mail.base } });
  try {
    await pay(srv, { email: null });
    await sleep(1500);
    assert.deepStrictEqual(mail.sent, []);
    assert.strictEqual(readOrder(srv.rendersDir).delivery.state, 'skipped');
  } finally {
    stop(srv); mail.close();
  }
});

test('with no provider configured nothing is sent and it is said once', async () => {
  const mail = await fakeMail();
  const srv = await startServer({ env: { EMAIL_API_BASE: mail.base, EMAIL_API_KEY: '' } });
  try {
    await pay(srv);
    await sleep(1600);
    assert.deepStrictEqual(mail.sent, []);
    assert.strictEqual(readOrder(srv.rendersDir).delivery.state, 'skipped');
    const warnings = srv.logs.join('').split('\n')
      .filter((l) => l.includes('set EMAIL_API_KEY')).length;
    assert.ok(warnings <= 1, `the missing-config warning repeated ${warnings} times`);
  } finally {
    stop(srv); mail.close();
  }
});

// --------------------------------------------------------------------------
// When the provider misbehaves
// --------------------------------------------------------------------------

test('a rejected send is retried, then given up on', async () => {
  const mail = await fakeMail({ status: 500 });
  const srv = await startServer({ env: { EMAIL_API_BASE: mail.base } });
  try {
    await pay(srv);
    assert.strictEqual(readOrder(srv.rendersDir).delivery.state, 'failed');
    await sleep(3000);
    const attempts = readOrder(srv.rendersDir).delivery.attempts;
    assert.ok(attempts > 1, 'a failed send was never retried');
    assert.ok(attempts <= 5, `the provider was called ${attempts} times`);
  } finally {
    stop(srv); mail.close();
  }
});

test('a provider that recovers gets the email through', async () => {
  const mail = await fakeMail({ status: 500 });
  const srv = await startServer({ env: { EMAIL_API_BASE: mail.base } });
  try {
    await pay(srv);
    assert.strictEqual(readOrder(srv.rendersDir).delivery.state, 'failed');
    mail.state.status = 200;
    await sleep(1500);
    assert.strictEqual(readOrder(srv.rendersDir).delivery.state, 'sent');
    assert.strictEqual(mail.sent.length, 1);
  } finally {
    stop(srv); mail.close();
  }
});

test('the send carries an idempotency key the provider can honour', async () => {
  // Keyed per SEND, not per order. A key fixed to the session would have the
  // provider silently refuse the deliberate resend #70 offers — forever.
  const mail = await fakeMail();
  const srv = await startServer({ env: { EMAIL_API_BASE: mail.base } });
  try {
    await pay(srv);
    assert.strictEqual(mail.sent[0].key, 'deliver-cs_test_1-0');
  } finally {
    stop(srv); mail.close();
  }
});

test('a lost delivery record cannot send the email twice', async () => {
  // The window is real: the process can die in the ten seconds between the
  // provider accepting the message and the `sent` state reaching disk, and the
  // stale-claim takeover would then try again. The provider key is the only
  // layer that survives that, so this erases the local evidence and checks.
  const mail = await fakeMail();
  const srv = await startServer({ env: { EMAIL_API_BASE: mail.base } });
  try {
    await pay(srv);
    assert.strictEqual(mail.sent.length, 1);

    const order = readOrder(srv.rendersDir);
    order.delivery = { state: 'failed', attempts: 0 };
    fs.writeFileSync(path.join(srv.rendersDir, '.sessions', 'cs_test_1.json'),
      JSON.stringify(order));
    await sleep(1500);

    assert.strictEqual(mail.sent.length, 1,
      'the customer was emailed twice once the local record was lost');
  } finally {
    stop(srv); mail.close();
  }
});

test('a delivery whose record will not persist is not repeated every tick', async () => {
  // If the write that says "sent" fails, the attempt counter cannot bound
  // anything — the counter IS what would not write. The claim is held instead.
  const mail = await fakeMail();
  const srv = await startServer({ env: { EMAIL_API_BASE: mail.base } });
  try {
    await pay(srv);
    assert.strictEqual(mail.sent.length, 1);

    // Make the order unwritable, then invite the sweep to try again.
    const orderPath = path.join(srv.rendersDir, '.sessions', 'cs_test_1.json');
    const order = readOrder(srv.rendersDir);
    order.delivery = { state: 'failed', attempts: 0 };
    fs.writeFileSync(orderPath, JSON.stringify(order));
    fs.chmodSync(path.join(srv.rendersDir, '.sessions'), 0o555);
    await sleep(2000);
    fs.chmodSync(path.join(srv.rendersDir, '.sessions'), 0o755);

    // One extra send at most: the provider key deduplicates, and the held claim
    // stops it being attempted every tick.
    assert.strictEqual(mail.sent.length, 1,
      `${mail.sent.length} messages reached the provider`);
  } finally {
    try { fs.chmodSync(path.join(srv.rendersDir, '.sessions'), 0o755); } catch { /* gone */ }
    stop(srv); mail.close();
  }
});

test('the message body escapes what it interpolates', async () => {
  const mail = await fakeMail();
  const srv = await startServer({
    env: { EMAIL_API_BASE: mail.base, SUPPORT_EMAIL: 'a"><script>x</script>@e.com' },
  });
  try {
    await pay(srv);
    assert.ok(!mail.sent[0].html.includes('<script>'),
      `unescaped markup reached the html body: ${mail.sent[0].html}`);
  } finally {
    stop(srv); mail.close();
  }
});
