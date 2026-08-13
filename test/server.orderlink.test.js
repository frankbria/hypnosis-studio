// The order link and the resend form (issue #70).
//
// With 30-day retention and no accounts, the email a customer typed at checkout
// is the only identifier this product has — so this is the whole of account
// recovery, and the interesting assertions are about what it refuses to reveal.
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
        resolve({ status: res.statusCode, body: out, json, headers: res.headers });
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
  return JSON.stringify({
    id: `evt_${sessionId}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId, payment_status: 'paid', payment_intent: 'pi_1',
        amount_total: 3900, currency: 'usd',
        customer_details: { email },
        metadata: { goal: 'polymath', voiceSet: 'male' },
      },
    },
  });
}

async function fakeMail() {
  const sent = [];
  const byKey = new Map();
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const key = req.headers['idempotency-key'] || '';
      if (key && byKey.has(key)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(byKey.get(key)));
      }
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* raw */ }
      sent.push(parsed);
      const result = { id: `msg_${sent.length}` };
      if (key) byKey.set(key, result);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { sent, base: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

function makeEngine() {
  const p = path.join(os.tmpdir(), `link-engine-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sh`);
  fs.writeFileSync(p, `#!/bin/sh
outdir=""
while [ $# -gt 0 ]; do case "$1" in --outdir) outdir="$2"; shift 2;; *) shift;; esac; done
for f in t1 t2; do : > "$outdir/$f.mp3"; : > "$outdir/$f.wav"; done
printf '{"tracks":[{"n":1,"id":"t1","title":"I","phase":"induction","durationSec":700,"mp3":"t1.mp3","wav":"t1.wav"}]}' > "$outdir/manifest.json"
printf '{"jobId":"x","state":"ready","stage":"mastering-qa","progress":1,"detail":"done","updatedAt":"%s"}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$outdir/status.json"
exit 0
`, { mode: 0o755 });
  return p;
}

async function startServer(env = {}) {
  const dir = env.RENDERS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'link-'));
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
      STRIPE_SECRET_KEY: 'sk_test_fake',
      PUBLIC_BASE_URL: 'https://studio.example',
      EMAIL_API_KEY: 'test_mail_key',
      EMAIL_FROM: 'studio@studio.example',
      RETENTION_DAYS: '30',
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

async function pay(srv, opts) {
  const raw = paidEvent(opts);
  const res = await request(srv.port, 'POST', '/api/stripe/webhook', raw,
    { 'Stripe-Signature': sign(raw) });
  await sleep(1200);
  return res;
}

const jobs = (dir) => {
  try { return fs.readdirSync(dir).filter((n) => n.startsWith('job_')); } catch { return []; }
};

// --------------------------------------------------------------------------
// The link
// --------------------------------------------------------------------------

test('the order token addresses the files that were bought', async () => {
  const mail = await fakeMail();
  const srv = await startServer({ EMAIL_API_BASE: mail.base });
  try {
    await pay(srv);
    const res = await request(srv.port, 'GET', '/api/orders/cs_test_1');
    assert.strictEqual(res.status, 200, res.body);
    const [job] = jobs(srv.rendersDir);
    assert.strictEqual(res.json.jobId, job);

    // And that job id really does download the audio.
    const file = await request(srv.port, 'GET', `/api/jobs/${res.json.jobId}/files/t1.mp3`);
    assert.strictEqual(file.status, 200, 'the order does not reach the files');
  } finally {
    stop(srv); mail.close();
  }
});

test('the order says when the files expire', async () => {
  const mail = await fakeMail();
  const srv = await startServer({ EMAIL_API_BASE: mail.base, RETENTION_DAYS: '30' });
  try {
    await pay(srv);
    const res = await request(srv.port, 'GET', '/api/orders/cs_test_1');
    assert.ok(res.json.expiresAt, 'the order states no expiry');
    const days = (Date.parse(res.json.expiresAt) - Date.now()) / 86400000;
    assert.ok(days > 29 && days <= 30.1, `expiry is ${days.toFixed(1)} days away`);
  } finally {
    stop(srv); mail.close();
  }
});

test('the expiry follows the retention window that actually deletes the files', async () => {
  const mail = await fakeMail();
  const srv = await startServer({ EMAIL_API_BASE: mail.base, RETENTION_DAYS: '7', RETENTION_PROMISED_DAYS: '7' });
  try {
    await pay(srv);
    const res = await request(srv.port, 'GET', '/api/orders/cs_test_1');
    const days = (Date.parse(res.json.expiresAt) - Date.now()) / 86400000;
    assert.ok(days > 6 && days <= 7.1,
      `expiry is ${days.toFixed(1)} days away but retention is 7 days`);
  } finally {
    stop(srv); mail.close();
  }
});

test('the order endpoint reveals nothing about the buyer', async () => {
  // It is public and addressed by a token. The order behind it holds an email
  // address, a payment reference and an amount.
  const mail = await fakeMail();
  const srv = await startServer({ EMAIL_API_BASE: mail.base });
  try {
    await pay(srv);
    const res = await request(srv.port, 'GET', '/api/orders/cs_test_1');
    for (const secret of [EMAIL, 'pi_1', '3900', 'example.com']) {
      assert.ok(!res.body.includes(secret), `the order endpoint leaks ${secret}: ${res.body}`);
    }
    assert.deepStrictEqual(Object.keys(res.json).sort(), ['expiresAt', 'jobId']);
  } finally {
    stop(srv); mail.close();
  }
});

test('an unknown token is a 404, not a hint', async () => {
  const mail = await fakeMail();
  const srv = await startServer({ EMAIL_API_BASE: mail.base });
  try {
    const res = await request(srv.port, 'GET', '/api/orders/cs_not_a_real_session');
    assert.strictEqual(res.status, 404);
  } finally {
    stop(srv); mail.close();
  }
});

test('the post-checkout redirect and the email point at the same page', async () => {
  const mail = await fakeMail();
  const stripeCalls = [];
  const port = await freePort();
  const stripe = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      stripeCalls.push(new URLSearchParams(b));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/x' }));
    });
  });
  await new Promise((r) => stripe.listen(port, '127.0.0.1', r));
  const srv = await startServer({
    EMAIL_API_BASE: mail.base, STRIPE_API_BASE: `http://127.0.0.1:${port}`,
  });
  try {
    await request(srv.port, 'POST', '/api/checkout',
      JSON.stringify({ goal: 'polymath', voiceSet: 'male' }));
    const successUrl = stripeCalls[0].get('success_url');
    assert.match(successUrl, /\/order\/\{CHECKOUT_SESSION_ID\}$/,
      `the redirect does not land on the order page: ${successUrl}`);

    await pay(srv);
    const link = mail.sent[0].text.split('\n').find((l) => l.startsWith('http'));
    assert.strictEqual(link, 'https://studio.example/order/cs_test_1',
      'the email points somewhere other than the order page');
    // The same address, so a customer has one link rather than two.
    assert.strictEqual(link, successUrl.replace('{CHECKOUT_SESSION_ID}', 'cs_test_1'));
  } finally {
    stop(srv); mail.close(); stripe.close();
  }
});

// --------------------------------------------------------------------------
// Resend — and what it must not reveal
// --------------------------------------------------------------------------

test('resend sends the link again to an address that bought something', async () => {
  const mail = await fakeMail();
  const srv = await startServer({ EMAIL_API_BASE: mail.base });
  try {
    await pay(srv);
    assert.strictEqual(mail.sent.length, 1, 'the delivery email did not go');

    const res = await request(srv.port, 'POST', '/api/orders/resend',
      JSON.stringify({ email: EMAIL }));
    assert.strictEqual(res.status, 202);
    await sleep(900);
    assert.strictEqual(mail.sent.length, 2, 'the link was not sent again');
    assert.ok(mail.sent[1].text.includes('/order/cs_test_1'));
  } finally {
    stop(srv); mail.close();
  }
});

test('resend answers identically whether or not an order exists', async () => {
  // Account enumeration. There are no accounts here to hide behind — the email
  // IS the account — so this endpoint is the only thing standing between a
  // stranger and "does this person use a hypnosis site".
  const mail = await fakeMail();
  const srv = await startServer({ EMAIL_API_BASE: mail.base });
  try {
    await pay(srv);
    const known = await request(srv.port, 'POST', '/api/orders/resend',
      JSON.stringify({ email: EMAIL }));
    const unknown = await request(srv.port, 'POST', '/api/orders/resend',
      JSON.stringify({ email: 'nobody@example.com' }));
    const empty = await request(srv.port, 'POST', '/api/orders/resend', JSON.stringify({}));

    assert.strictEqual(known.status, unknown.status);
    assert.strictEqual(known.status, empty.status);
    assert.strictEqual(known.body, unknown.body);
    assert.strictEqual(known.body, empty.body);
    assert.strictEqual(known.headers['content-length'], unknown.headers['content-length']);
  } finally {
    stop(srv); mail.close();
  }
});

test('resend does not answer more slowly for an address it knows', async () => {
  // The other half of not leaking: a response that takes longer when it finds
  // something is the same disclosure, measured with a stopwatch. The search
  // runs AFTER the response, so it cannot be timed.
  //
  // Seeded with many orders, because the leak is proportional to how much
  // scanning happens before the answer goes out. Even so this is a SMOKE check,
  // not the real guard: a few hundred small files scan in single-digit
  // milliseconds, so it cannot resolve the difference on a fast disk. The
  // assertion with teeth is the structural one below.
  const mail = await fakeMail();
  const srv = await startServer({ EMAIL_API_BASE: mail.base });
  try {
    await pay(srv);
    const sessions = path.join(srv.rendersDir, '.sessions');
    for (let i = 0; i < 200; i += 1) {
      fs.writeFileSync(path.join(sessions, `cs_filler_${i}.json`), JSON.stringify({
        sessionId: `cs_filler_${i}`, email: `filler${i}@example.com`,
        jobId: 'job_nonexistent', paymentIntent: 'pi_x',
      }));
    }
    const time = async (email) => {
      const t = Date.now();
      await request(srv.port, 'POST', '/api/orders/resend', JSON.stringify({ email }));
      return Date.now() - t;
    };
    // Warm, then measure — the first request of a process is always slowest.
    await time('warm@example.com');
    const unknown = await time('nobody@example.com');
    const known = await time(EMAIL);
    assert.ok(Math.abs(known - unknown) < 100,
      `known address answered in ${known}ms, unknown in ${unknown}ms`);
  } finally {
    stop(srv); mail.close();
  }
});

test('the resend search runs off the request path, not before the answer', () => {
  // The structural guard, and the one with teeth. An async function runs
  // SYNCHRONOUSLY up to its first await, and resendOrderLinks only reaches one
  // when it finds a match — so calling it directly made an unknown address pay
  // for the whole scan before the response went out, while a known address
  // yielded early. That is the enumeration leak, measured with a stopwatch
  // instead of read off a status code.
  //
  // A timing test cannot pin this: the difference is milliseconds on a fast
  // disk and grows only with the order count. What pins it is that the scan is
  // deferred, so the answer cannot depend on it at all.
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const at = src.indexOf("url === '/api/orders/resend'");
  assert.ok(at > 0, 'the resend route is gone');
  const route = src.slice(at, src.indexOf('\n  }', at));
  assert.match(route, /setImmediate\(/,
    'the resend scan runs on the request path, so an unknown address is measurably slower');
  const call = route.indexOf('resendOrderLinks(');
  const defer = route.indexOf('setImmediate(');
  assert.ok(defer >= 0 && defer < call,
    'resendOrderLinks is called before it is deferred');
});

test('resend is capped, and the cap does not become a signal either', async () => {
  const mail = await fakeMail();
  const srv = await startServer({ EMAIL_API_BASE: mail.base, RESEND_MAX_PER_MINUTE: '2' });
  try {
    await pay(srv);
    const answers = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await request(srv.port, 'POST', '/api/orders/resend',
        JSON.stringify({ email: EMAIL }));
      answers.push(`${res.status}:${res.body}`);
    }
    assert.strictEqual(new Set(answers).size, 1,
      `the cap changes the answer, which leaks just as much: ${[...new Set(answers)].join(' | ')}`);
    await sleep(900);
    // Two got through; the rest were capped.
    assert.ok(mail.sent.length <= 3,
      `the cap did not bound the mail: ${mail.sent.length} messages`);
  } finally {
    stop(srv); mail.close();
  }
});

test('resend matches the address case-insensitively', async () => {
  const mail = await fakeMail();
  const srv = await startServer({ EMAIL_API_BASE: mail.base });
  try {
    await pay(srv, { email: 'Buyer@Example.COM' });
    await request(srv.port, 'POST', '/api/orders/resend',
      JSON.stringify({ email: ' buyer@example.com ' }));
    await sleep(900);
    assert.strictEqual(mail.sent.length, 2,
      'a customer who typed their address differently got nothing');
  } finally {
    stop(srv); mail.close();
  }
});

test('resend sends nothing for an order whose render is not ready', async () => {
  const mail = await fakeMail();
  const srv = await startServer({ EMAIL_API_BASE: mail.base, MONTHLY_CHAR_BUDGET: '1' });
  try {
    await pay(srv);   // refused: no job
    const before = mail.sent.length;
    await request(srv.port, 'POST', '/api/orders/resend', JSON.stringify({ email: EMAIL }));
    await sleep(900);
    assert.strictEqual(mail.sent.length, before,
      'a link was sent for an order with nothing behind it');
  } finally {
    stop(srv); mail.close();
  }
});

test('GET is not a way to trigger a resend', async () => {
  const mail = await fakeMail();
  const srv = await startServer({ EMAIL_API_BASE: mail.base });
  try {
    await pay(srv);
    const before = mail.sent.length;
    const res = await request(srv.port, 'GET', '/api/orders/resend');
    // It falls through to the order lookup, which finds no order called
    // "resend" — the point is that no mail goes.
    assert.strictEqual(res.status, 404);
    await sleep(600);
    assert.strictEqual(mail.sent.length, before);
  } finally {
    stop(srv); mail.close();
  }
});
