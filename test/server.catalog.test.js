// Serving a pre-rendered catalog purchase (issue #59).
//
// With the catalog pre-rendered (#58), a $39 purchase should never spawn a
// worker — it should grant access to files that already exist. The two things
// worth proving are therefore behavioural, not cosmetic:
//
//   1. No job is started. The fake engine here writes a marker file if it is
//      ever executed, so "no render happened" is asserted against the engine
//      actually not running rather than against a status code.
//   2. No guessable path exposes a master. One leaked URL makes the entire
//      product free, so most of this file is about links that must NOT work.
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
const SIGNING = 'delivery_signing_secret_for_tests';
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
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: buf, json, headers: res.headers });
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

function paidEvent({ sessionId = 'cs_test_1', email = EMAIL,
  goal = 'polymath', voiceSet = 'male' } = {}) {
  return JSON.stringify({
    id: `evt_${sessionId}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId, payment_status: 'paid', payment_intent: 'pi_1',
        amount_total: 3900, currency: 'usd',
        customer_details: { email },
        metadata: { goal, voiceSet },
      },
    },
  });
}

/** The four masters of one program, on disk, with recognisable contents. */
const TRACKS = [
  { n: 1, id: 'polymath_track1', title: 'I', phase: 'Foundation', durationSec: 812.4 },
  { n: 2, id: 'polymath_track2', title: 'II', phase: 'Deepening', durationSec: 830.0 },
  { n: 3, id: 'polymath_track3', title: 'III', phase: 'Mastery', durationSec: 805.5 },
  { n: 4, id: 'polymath_track4', title: 'IV', phase: 'Integration', durationSec: 441.1 },
];

function makeCatalog(dir, { key = 'polymath__male', goal = 'polymath',
  voiceSet = 'male', publishable = true, writeFiles = true, escapeTo = null,
  damage = null } = {}) {
  const catalogDir = path.join(dir, 'catalog');
  fs.mkdirSync(path.join(catalogDir, key), { recursive: true });
  const tracks = TRACKS.map((t) => ({
    ...t,
    // `escapeTo` makes the MANIFEST itself point outside the catalog root —
    // the case the allow-list cannot catch, because the path it hands back is
    // one it built itself.
    wav: escapeTo ? `${escapeTo}.wav` : `${key}/${t.id}.wav`,
    mp3: escapeTo ? `${escapeTo}.mp3` : `${key}/${t.id}.mp3`,
  }));
  if (writeFiles) {
    for (const t of tracks) {
      for (const [rel, tag] of [[t.wav, 'WAV'], [t.mp3, 'MP3']]) {
        // resolve, not join: with `escapeTo` the path deliberately leaves the
        // catalog root, and the file has to really be there — a test where the
        // target does not exist would pass on a 404 and prove nothing.
        const abs = path.resolve(catalogDir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, `${tag}:${t.id}`);
      }
    }
  }
  // Lets a test break the masters the way a real box breaks them — a deleted
  // file, a truncated copy — after they are written and before the server boots.
  if (damage) damage(catalogDir);
  const manifestPath = path.join(dir, 'catalog.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    programs: [{
      key, goal, voiceSet, goalTitle: 'The Polymath Mind',
      publishable, tracks, qa: { passed: true, problems: [] },
      approval: { listen: 'full', at: '2026-09-05T10:00:00Z', by: 'frankbria' },
    }],
    durationsByGoal: { [goal]: TRACKS.map((t) => t.durationSec) },
  }));
  return { catalogDir, manifestPath };
}

/**
 * An engine that records the fact it ran.
 *
 * The central claim of #59 is that a catalog purchase starts no job. Asserting
 * that from a status code would pass just as happily if a worker had been
 * spawned and ignored, so the marker is the evidence.
 */
function makeEngine(markerPath) {
  const p = path.join(os.tmpdir(),
    `cat-engine-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sh`);
  fs.writeFileSync(p, `#!/bin/sh
echo ran >> "${markerPath}"
outdir=""
while [ $# -gt 0 ]; do case "$1" in --outdir) outdir="$2"; shift 2;; *) shift;; esac; done
: > "$outdir/t1.mp3"; : > "$outdir/t1.wav"
printf '{"tracks":[{"n":1,"id":"t1","title":"I","phase":"Foundation","durationSec":700,"mp3":"t1.mp3","wav":"t1.wav"}]}' > "$outdir/manifest.json"
printf '{"jobId":"x","state":"ready","stage":"mastering-qa","progress":1,"detail":"done","updatedAt":"%s"}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$outdir/status.json"
exit 0
`, { mode: 0o755 });
  return p;
}

async function fakeStripe() {
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      }));
    });
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

async function fakeMail() {
  const sent = [];
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { sent.push(JSON.parse(body)); } catch { sent.push({ raw: body }); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `msg_${sent.length}` }));
    });
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { sent, base: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

async function startServer({ env = {}, catalog = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-'));
  const marker = path.join(dir, 'engine-ran');
  const { catalogDir, manifestPath } = makeCatalog(dir, catalog);
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      HYPNO_NO_DOTENV: '1',
      PORT: String(port),
      RENDERS_DIR: path.join(dir, 'renders'),
      CATALOG_DIR: catalogDir,
      CATALOG_MANIFEST: manifestPath,
      DELIVERY_SIGNING_SECRET: SIGNING,
      ENGINE_PY: makeEngine(marker),
      MAX_JOBS_PER_DAY: '100',
      SWEEP_INTERVAL_MS: '600000',
      STRIPE_WEBHOOK_SECRET: SECRET,
      STRIPE_SECRET_KEY: 'sk_test_fake',
      PUBLIC_BASE_URL: 'https://studio.example',
      RETENTION_DAYS: '30',
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
    if (Date.now() > deadline) {
      throw new Error(`server never became ready: ${logs.join('')}`);
    }
    await sleep(50);
  }
  return {
    proc, port, dir, catalogDir, logs,
    engineRan: () => fs.existsSync(marker),
    sessionsDir: () => path.join(dir, 'renders', '.sessions'),
    readOrder: (id = 'cs_test_1') =>
      JSON.parse(fs.readFileSync(path.join(dir, 'renders', '.sessions', `${id}.json`), 'utf8')),
  };
}

const stop = (srv) => { try { srv.proc.kill('SIGKILL'); } catch { /* gone */ } };

async function pay(srv, opts = {}) {
  const raw = paidEvent(opts);
  const res = await request(srv.port, 'POST', '/api/stripe/webhook', raw,
    { 'Stripe-Signature': sign(raw) });
  return res;
}

// ---------------------------------------------------------------------------
// A catalog purchase starts no job
// ---------------------------------------------------------------------------

test('a paid catalog purchase never spawns a worker', async () => {
  const srv = await startServer();
  try {
    const res = await pay(srv);
    assert.strictEqual(res.status, 200, res.body.toString());
    assert.strictEqual(res.json.catalog, 'polymath__male');
    assert.ok(!res.json.jobId, 'a catalog purchase reported a jobId');
    await sleep(300);
    assert.ok(!srv.engineRan(), 'the render engine was executed for a catalog sale');
    assert.deepStrictEqual(fs.readdirSync(path.join(srv.dir, 'renders'))
      .filter((n) => n.startsWith('job_')), [], 'a job directory was created');
  } finally { stop(srv); }
});

test('the order records the catalog program and no job', async () => {
  const srv = await startServer();
  try {
    await pay(srv);
    const order = srv.readOrder();
    assert.strictEqual(order.catalog, 'polymath__male');
    assert.strictEqual(order.jobId, undefined);
    assert.strictEqual(order.amountTotal, 3900);   // still a real paid order
  } finally { stop(srv); }
});

test('a program that is not publishable still renders', async () => {
  // The fallback the owner chose: until #58's pre-render has been run, nothing
  // is publishable and every purchase must behave exactly as it does today.
  const srv = await startServer({ catalog: { publishable: false } });
  try {
    const res = await pay(srv);
    assert.strictEqual(res.status, 200);
    assert.ok(res.json.jobId, 'an unpublishable program did not fall back to rendering');
    await sleep(400);
    assert.ok(srv.engineRan(), 'the render engine never ran for the fallback path');
  } finally { stop(srv); }
});

test('a goal with no catalog entry still renders', async () => {
  const srv = await startServer();
  try {
    const res = await pay(srv, { goal: 'river', sessionId: 'cs_test_river' });
    assert.ok(res.json.jobId, 'an uncatalogued goal did not fall back to rendering');
  } finally { stop(srv); }
});

test('the other voice set of a catalogued goal still renders', async () => {
  // The catalog is keyed on (goal, voiceSet), not goal. Keying on the goal
  // alone would hand a female-voice buyer the male masters.
  const srv = await startServer();
  try {
    const res = await pay(srv, { voiceSet: 'female', sessionId: 'cs_test_f' });
    assert.ok(res.json.jobId, 'the wrong voice set was served from the catalog');
    assert.ok(!res.json.catalog);
  } finally { stop(srv); }
});

// ---------------------------------------------------------------------------
// The order hands back working, signed links
// ---------------------------------------------------------------------------

async function orderTracks(srv, sessionId = 'cs_test_1') {
  const res = await request(srv.port, 'GET', `/api/orders/${sessionId}`);
  assert.strictEqual(res.status, 200, res.body.toString());
  return res.json;
}

test('the order returns all four tracks with real durations', async () => {
  const srv = await startServer();
  try {
    await pay(srv);
    const order = await orderTracks(srv);
    assert.strictEqual(order.catalog, 'polymath__male');
    assert.strictEqual(order.tracks.length, 4);
    assert.deepStrictEqual(order.tracks.map((t) => t.durationSec),
      TRACKS.map((t) => t.durationSec));
    assert.deepStrictEqual(order.tracks.map((t) => t.phase),
      ['Foundation', 'Deepening', 'Mastery', 'Integration']);
  } finally { stop(srv); }
});

test('a signed link actually downloads the right master', async () => {
  const srv = await startServer();
  try {
    await pay(srv);
    const order = await orderTracks(srv);
    for (const track of order.tracks) {
      const mp3 = await request(srv.port, 'GET', track.mp3);
      assert.strictEqual(mp3.status, 200, `${track.mp3} -> ${mp3.status}`);
      assert.match(mp3.body.toString(), /^MP3:/);
      assert.match(mp3.headers['content-disposition'], /attachment; filename="/);
      assert.strictEqual(mp3.headers['content-type'], 'audio/mpeg');
      const wav = await request(srv.port, 'GET', track.wav);
      assert.strictEqual(wav.status, 200);
      assert.match(wav.body.toString(), /^WAV:/);
      assert.strictEqual(wav.headers['content-type'], 'audio/wav');
    }
  } finally { stop(srv); }
});

test('each link serves the file it names, not just any file', async () => {
  // Four tracks all signed at once is exactly the shape where an off-by-one in
  // the mapping goes unnoticed — every link works, each returns the wrong audio.
  const srv = await startServer();
  try {
    await pay(srv);
    const order = await orderTracks(srv);
    for (let i = 0; i < order.tracks.length; i += 1) {
      const res = await request(srv.port, 'GET', order.tracks[i].mp3);
      assert.strictEqual(res.body.toString(), `MP3:${TRACKS[i].id}`,
        `track ${i + 1}'s link served the wrong master`);
    }
  } finally { stop(srv); }
});

test('signed links are not cached by anything in between', async () => {
  const srv = await startServer();
  try {
    await pay(srv);
    const order = await orderTracks(srv);
    const res = await request(srv.port, 'GET', order.tracks[0].mp3);
    assert.match(res.headers['cache-control'], /no-store/);
    assert.match(res.headers['cache-control'], /private/);
  } finally { stop(srv); }
});

// ---------------------------------------------------------------------------
// No guessable path exposes a master
// ---------------------------------------------------------------------------

test('an unsigned catalog path is refused', async () => {
  // The whole product is ten files. One working guessable URL makes it free.
  const srv = await startServer();
  try {
    for (const p of [
      '/api/catalog/polymath__male/files/polymath_track1.mp3',
      '/api/catalog/polymath__male/files/polymath_track1.mp3?exp=99999999999999',
      '/api/catalog/polymath__male/files/polymath_track1.mp3?sig=deadbeef',
    ]) {
      const res = await request(srv.port, 'GET', p);
      assert.strictEqual(res.status, 403, `${p} was served without a valid signature`);
    }
  } finally { stop(srv); }
});

test('the masters are not reachable through the static file server', async () => {
  const srv = await startServer();
  try {
    for (const p of [
      '/catalog/polymath__male/polymath_track1.mp3',
      '/renders/catalog/polymath__male/polymath_track1.mp3',
      '/api/jobs/polymath__male/files/polymath_track1.mp3',
    ]) {
      const res = await request(srv.port, 'GET', p);
      assert.ok(res.status !== 200 || !res.body.toString().startsWith('MP3:'),
        `${p} served a master`);
    }
  } finally { stop(srv); }
});

test('an expired link is refused even though it is correctly signed', async () => {
  const srv = await startServer({ env: { CATALOG_LINK_TTL_MS: '1000' } });
  try {
    await pay(srv);
    const order = await orderTracks(srv);
    const ok = await request(srv.port, 'GET', order.tracks[0].mp3);
    assert.strictEqual(ok.status, 200, 'the link did not work while it was valid');
    await sleep(1200);
    const expired = await request(srv.port, 'GET', order.tracks[0].mp3);
    assert.strictEqual(expired.status, 403, 'an expired link still served a master');
  } finally { stop(srv); }
});

test('the expiry cannot be extended without breaking the signature', async () => {
  // The signature covers the expiry, so pushing `exp` out is not a shortcut
  // around the TTL — it invalidates the very signature it travels with.
  const srv = await startServer();
  try {
    await pay(srv);
    const order = await orderTracks(srv);
    const stretched = order.tracks[0].mp3.replace(/exp=\d+/, `exp=${Date.now() + 9e9}`);
    const res = await request(srv.port, 'GET', stretched);
    assert.strictEqual(res.status, 403, 'the expiry was editable');
  } finally { stop(srv); }
});

test('a signature cannot be moved to another program or another file', async () => {
  const srv = await startServer();
  try {
    await pay(srv);
    const order = await orderTracks(srv);
    const [first, second] = order.tracks;
    // Same signature and expiry, different filename.
    const swappedName = first.mp3.replace('polymath_track1.mp3', 'polymath_track2.mp3');
    assert.strictEqual((await request(srv.port, 'GET', swappedName)).status, 403,
      'a signature for one track served another');
    // Same signature, different program key.
    const swappedKey = first.mp3.replace('polymath__male', 'polymath__female');
    assert.strictEqual((await request(srv.port, 'GET', swappedKey)).status, 403,
      'a signature for one program served another');
    // And the real second-track link still works, so the above are not
    // failing for some unrelated reason.
    assert.strictEqual((await request(srv.port, 'GET', second.mp3)).status, 200);
  } finally { stop(srv); }
});

test('a traversal in the filename is refused', async () => {
  const srv = await startServer();
  try {
    await pay(srv);
    const order = await orderTracks(srv);
    for (const evil of ['../catalog.json', '..%2Fcatalog.json', '/etc/passwd']) {
      const p = order.tracks[0].mp3.replace('polymath_track1.mp3', encodeURIComponent(evil));
      const res = await request(srv.port, 'GET', p);
      assert.ok(res.status === 403 || res.status === 404,
        `${evil} returned ${res.status}`);
      assert.ok(!res.body.toString().includes('schemaVersion'),
        `${evil} leaked the manifest`);
    }
  } finally { stop(srv); }
});

test('a manifest pointing outside the catalog root serves nothing', async () => {
  // The allow-list cannot catch this: the path is one the manifest itself
  // supplied, so `catalogFiles` hands it back happily. CATALOG_DIR is operator
  // configuration and the manifest is committed separately, so the two CAN
  // disagree. Containment is checked with path.relative, not startsWith —
  // `/srv/catalog-backup` starts with `/srv/catalog` while being an entirely
  // different directory, which is open bug #36 against serveStatic.
  const srv = await startServer({ catalog: { escapeTo: '../outside/secret' } });
  try {
    await pay(srv);
    const order = await orderTracks(srv);
    const res = await request(srv.port, 'GET', order.tracks[0].mp3);
    assert.strictEqual(res.status, 403, 'a master outside the catalog root was served');
    assert.ok(!res.body.toString().startsWith('MP3:'), 'it leaked the file anyway');
  } finally { stop(srv); }
});

test('a sibling directory of the catalog root is not inside it', async () => {
  // The specific shape startsWith gets wrong: catalogDir is <dir>/catalog, and
  // <dir>/catalog-backup shares that prefix character for character.
  const srv = await startServer({ catalog: { escapeTo: '../catalog-backup/stolen' } });
  try {
    await pay(srv);
    const order = await orderTracks(srv);
    const res = await request(srv.port, 'GET', order.tracks[0].mp3);
    assert.strictEqual(res.status, 403, 'a sibling directory passed the containment check');
    assert.ok(!res.body.toString().startsWith('MP3:'), 'it leaked the file anyway');
  } finally { stop(srv); }
});

test('every rejection looks the same from outside', async () => {
  // Distinguishing "no such program" from "bad signature" from "expired" tells
  // someone probing which part of a forged link to fix next.
  const srv = await startServer();
  try {
    await pay(srv);
    const order = await orderTracks(srv);
    const bodies = new Set();
    for (const p of [
      order.tracks[0].mp3.replace(/sig=\w+/, 'sig=' + 'a'.repeat(64)),
      order.tracks[0].mp3.replace('polymath__male', 'no_such__program'),
      order.tracks[0].mp3.replace(/exp=\d+/, 'exp=1'),
    ]) {
      const res = await request(srv.port, 'GET', p);
      assert.strictEqual(res.status, 403);
      bodies.add(res.body.toString());
    }
    assert.strictEqual(bodies.size, 1, `rejections differ: ${[...bodies].join(' | ')}`);
  } finally { stop(srv); }
});

// ---------------------------------------------------------------------------
// The 30-day window
// ---------------------------------------------------------------------------

test('the order reports an expiry 30 days from the purchase', async () => {
  const srv = await startServer();
  try {
    await pay(srv);
    const order = await orderTracks(srv);
    const claimedAt = Date.parse(srv.readOrder().claimedAt);
    assert.strictEqual(Date.parse(order.expiresAt), claimedAt + 30 * 86400000);
  } finally { stop(srv); }
});

test('a file link never outlives the access window', async () => {
  // The link TTL is an hour by default and the window is 30 days, so the TTL
  // normally wins — but on day 30 the window has to.
  const srv = await startServer();
  try {
    await pay(srv);
    const order = await orderTracks(srv);
    const windowEnd = Date.parse(order.expiresAt);
    for (const track of order.tracks) {
      const exp = Number(new URL(track.mp3, 'http://x').searchParams.get('exp'));
      assert.ok(exp <= windowEnd, 'a link outlives the 30-day window');
    }
  } finally { stop(srv); }
});

test('past the window the order still resolves but carries no links', async () => {
  const srv = await startServer();
  try {
    await pay(srv);
    // Backdate the purchase past the window. The order is the customer's
    // receipt and must not 404 — it simply stops handing out files.
    const order = srv.readOrder();
    order.claimedAt = new Date(Date.now() - 31 * 86400000).toISOString();
    fs.writeFileSync(path.join(srv.sessionsDir(), 'cs_test_1.json'), JSON.stringify(order));

    const res = await orderTracks(srv);
    assert.strictEqual(res.catalog, 'polymath__male');
    assert.deepStrictEqual(res.tracks, [], 'an expired order still handed out links');
    assert.ok(Date.parse(res.expiresAt) < Date.now());
  } finally { stop(srv); }
});

test('the retention sweep does not delete the catalog', async () => {
  // The masters are shared across every customer and are not per-job output.
  // The sweep selects on a `job_` prefix, and this is what says so out loud.
  const srv = await startServer({ env: { SWEEP_INTERVAL_MS: '200' } });
  try {
    await pay(srv);
    await sleep(700);
    assert.ok(fs.existsSync(path.join(srv.catalogDir, 'polymath__male', 'polymath_track1.mp3')),
      'the retention sweep deleted a catalog master');
  } finally { stop(srv); }
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

test('a catalog buyer is emailed their order link', async () => {
  // deliverProgram is keyed on the session, but resend and the undelivered
  // sweep both used to require a jobId — so a catalog order was never
  // deliverable at all, and the customer heard nothing.
  const mail = await fakeMail();
  const srv = await startServer({
    env: { EMAIL_API_KEY: 'k', EMAIL_FROM: 'studio@studio.example', EMAIL_API_BASE: mail.base },
  });
  try {
    await pay(srv);
    const deadline = Date.now() + 5000;
    while (mail.sent.length === 0 && Date.now() < deadline) await sleep(50);
    assert.strictEqual(mail.sent.length, 1, 'the catalog buyer was never emailed');
    assert.ok(JSON.stringify(mail.sent[0]).includes('/order/cs_test_1'),
      'the email did not carry the order link');
  } finally { stop(srv); mail.close(); }
});

test('a master lost after boot reads as an operator fault, not a bad link', async () => {
  // Boot-time indexing catches a manifest deployed ahead of its audio, so the
  // only way to reach this now is to lose a master while the process is up.
  // The signature is still good, so answering 403 would send an operator
  // hunting for a signing problem that does not exist.
  const srv = await startServer();
  try {
    await pay(srv);
    const order = await orderTracks(srv);
    fs.rmSync(path.join(srv.catalogDir, 'polymath__male'), { recursive: true });
    const res = await request(srv.port, 'GET', order.tracks[0].mp3);
    assert.strictEqual(res.status, 404);
    assert.ok(srv.logs.join('').includes('signed link to a missing master'),
      'a missing master was not logged for the operator');
  } finally { stop(srv); }
});

// ---------------------------------------------------------------------------
// A manifest that outruns its audio must not sell
//
// `catalog.json` is committed and rides every deploy; the masters are
// gitignored and exist only on the box that rendered them. A rebuilt box or a
// fresh environment separates the two, and every mechanism that used to catch a
// broken sale is skipped on the catalog path — no capacity gate, no render, no
// job to fail. Without a boot check the customer is the one who finds out.
// ---------------------------------------------------------------------------

test('a program whose masters are absent renders instead of selling a 404', async () => {
  const srv = await startServer({ catalog: { writeFiles: false } });
  try {
    const res = await pay(srv);
    assert.strictEqual(res.status, 200, res.body.toString());
    assert.ok(!res.json.catalog,
      'a program with no masters on this box was still sold as a catalog sale');
    assert.ok(res.json.jobId, 'no render was started to stand in for it');
    await sleep(300);
    assert.ok(srv.engineRan(), 'the fallback did not actually reach the engine');
    assert.ok(srv.logs.join('').includes('masters are not on this box'),
      'the demotion was not logged for the operator');
    assert.ok(srv.logs.join('').includes('polymath__male'),
      'the log did not name which program was demoted');
  } finally { stop(srv); }
});

test('one missing file of eight demotes the whole program', async () => {
  // Three quarters of a program is not a deliverable, and selling it would be
  // the same broken promise as selling none of it.
  const srv = await startServer({
    catalog: {
      damage: (d) => fs.unlinkSync(path.join(d, 'polymath__male', 'polymath_track3.mp3')),
    },
  });
  try {
    const res = await pay(srv);
    assert.ok(!res.json.catalog, 'a program missing one master was still sold');
    assert.ok(res.json.jobId, 'the incomplete program did not fall back to rendering');
  } finally { stop(srv); }
});

test('a zero-byte master counts as missing', async () => {
  // Survives a half-finished copy and would otherwise index as sound.
  const srv = await startServer({
    catalog: {
      damage: (d) => fs.truncateSync(path.join(d, 'polymath__male', 'polymath_track1.wav'), 0),
    },
  });
  try {
    const res = await pay(srv);
    assert.ok(!res.json.catalog, 'a truncated master was still sold');
    assert.ok(res.json.jobId, 'the truncated program did not fall back to rendering');
  } finally { stop(srv); }
});

test('demoting every program lifts the signing-secret requirement', async () => {
  // The refusal is scoped to "there is something publishable". If it read the
  // manifest rather than the real index, a box that had lost its masters would
  // refuse to boot over links it can no longer be asked to sign — turning a
  // recoverable degradation into an outage.
  const srv = await startServer({
    catalog: { writeFiles: false },
    env: { DELIVERY_SIGNING_SECRET: '' },
  });
  try {
    const res = await request(srv.port, 'GET', '/api/health');
    assert.strictEqual(res.status, 200, 'the server refused to boot with no masters');
  } finally { stop(srv); }
});

// ---------------------------------------------------------------------------
// A redelivered webhook must not revive a fulfilled order
// ---------------------------------------------------------------------------

test('replaying the paid event does not extend the access window', async () => {
  // A catalog order has no job and no recorded refusal, so it used to fall
  // through to claimIsRecoverable's 60-second age check and read as recoverable
  // forever. Any redelivery — a Stripe dashboard "resend", or at-least-once
  // delivery doing its job — then re-claimed it with a fresh claimedAt, sliding
  // the 30-day window forward. Replayed monthly, that is lifetime access for
  // one $39 payment.
  const srv = await startServer();
  try {
    await pay(srv);
    const first = await orderTracks(srv);

    // Age the claim well past RECLAIM_AFTER_MS, which is what a real redelivery
    // minutes or days later would look like.
    const order = srv.readOrder();
    const backdated = new Date(Date.now() - 31 * 86400000).toISOString();
    fs.writeFileSync(path.join(srv.sessionsDir(), 'cs_test_1.json'),
      JSON.stringify({ ...order, claimedAt: backdated }));

    const replay = await pay(srv);
    assert.strictEqual(replay.json.duplicate, true,
      'a replayed catalog event was not recognised as a duplicate');

    assert.strictEqual(srv.readOrder().claimedAt, backdated,
      'the replay reset claimedAt and revived a lapsed order');
    const after = await orderTracks(srv);
    assert.deepStrictEqual(after.tracks, [],
      'a lapsed order handed out links again after a replay');
    assert.ok(Date.parse(after.expiresAt) < Date.parse(first.expiresAt) + 1000,
      'the replay pushed the access window out');
  } finally { stop(srv); }
});

test('replaying the paid event does not email the buyer twice', async () => {
  // The replay also wiped `delivery`, and with it `deliveryGeneration` — so the
  // re-send reused the original idempotency key, which both masks the duplicate
  // and poisons the key a genuine later resend would need.
  const mail = await fakeMail();
  const srv = await startServer({
    env: { EMAIL_API_KEY: 'k', EMAIL_FROM: 'studio@studio.example', EMAIL_API_BASE: mail.base },
  });
  try {
    await pay(srv);
    const deadline = Date.now() + 5000;
    while (mail.sent.length === 0 && Date.now() < deadline) await sleep(50);
    assert.strictEqual(mail.sent.length, 1);

    const order = srv.readOrder();
    fs.writeFileSync(path.join(srv.sessionsDir(), 'cs_test_1.json'), JSON.stringify({
      ...order, claimedAt: new Date(Date.now() - 600000).toISOString(),
    }));
    await pay(srv);
    await sleep(600);

    assert.strictEqual(mail.sent.length, 1, 'the buyer was emailed twice for one purchase');
    assert.strictEqual(srv.readOrder().delivery.state, 'sent',
      'the replay wiped the delivery record');
  } finally { stop(srv); mail.close(); }
});

test('a catalog order marked with lastError is retried, not dropped', async () => {
  // The recovery half of the failed-catalog-record fix.
  //
  // If the writeClaim recording `catalog` fails, the claim already on disk has
  // no jobId and no catalog. Without a recorded refusal, a Stripe retry inside
  // RECLAIM_AFTER_MS reads as "someone is mid-spawn" and is answered
  // `duplicate: true` — Stripe stops, the delivery sweep skips it (no jobId, no
  // catalog) and the refund sweep needs a refund or a lastError. A paid
  // customer with no files, no refund and no retry. So the webhook now writes
  // `lastError` on that path, which is what makes the claim recoverable.
  //
  // This pins the RECOVERY: given such a claim, the retry fulfils it. It does
  // NOT cover the write itself — reaching that branch needs writeClaim to fail
  // while claimSession succeeds, on the same file moments apart, and there is
  // no seam in the server to induce that. The write is one line next to the
  // render path's identical one; the behaviour it depends on is here.
  const srv = await startServer();
  try {
    await pay(srv);
    // Simulate the half-written state that failure leaves behind.
    const { sessionId, goal, voiceSet, claimedAt, amountTotal, currency,
      paymentIntent, email } = srv.readOrder();
    fs.writeFileSync(path.join(srv.sessionsDir(), 'cs_test_1.json'), JSON.stringify({
      sessionId, goal, voiceSet, claimedAt, amountTotal, currency, paymentIntent, email,
      lastError: 'catalog_record_failed',
      lastErrorAt: new Date().toISOString(),
    }));

    const retry = await pay(srv);
    assert.ok(!retry.json.duplicate, 'the retry of a failed catalog record was dropped');
    assert.strictEqual(retry.json.catalog, 'polymath__male',
      'the retry did not fulfil the order');
    assert.strictEqual(srv.readOrder().catalog, 'polymath__male');
  } finally { stop(srv); }
});

test('a catalog sale is not refused when the render budget is spent', async () => {
  // Every check in capacityProblem bounds spending, and this sale spends
  // nothing. Refusing it because renders are unaffordable is the opposite of
  // what pre-rendering is for.
  //
  // MONTHLY_CHAR_BUDGET=1, not MAX_JOBS_PER_DAY and not 0. capacityProblem
  // prices the program against the budget and the provider's credits and never
  // looks at the daily cap — and `0` is not a smaller budget, it is no budget:
  // the parser reads it as nonsense and falls back to the 500000 default, so a
  // test using it exercises nothing. And a real Stripe stub, or checkout
  // answers 502 for want of a session and the assertion passes without the gate
  // being reached at all.
  const stripe = await fakeStripe();
  const srv = await startServer({
    env: { MONTHLY_CHAR_BUDGET: '1', STRIPE_API_BASE: stripe.base },
  });
  try {
    const body = JSON.stringify({ goal: 'polymath', voiceSet: 'male' });
    const res = await request(srv.port, 'POST', '/api/checkout', body);
    assert.strictEqual(res.status, 200,
      `a catalog sale was refused for lack of render capacity: ${res.body}`);
    assert.ok(res.json.url, 'no checkout session was created');
  } finally { stop(srv); stripe.close(); }
});

test('a render-only program is still refused when capacity is gone', async () => {
  // The gate has to keep working for everything the catalog cannot serve, or
  // #25 is undone: a refusal after payment costs a refund and a support contact.
  const stripe = await fakeStripe();
  const srv = await startServer({
    env: { MONTHLY_CHAR_BUDGET: '1', STRIPE_API_BASE: stripe.base },
  });
  try {
    const body = JSON.stringify({ goal: 'river', voiceSet: 'male' });
    const res = await request(srv.port, 'POST', '/api/checkout', body);
    assert.strictEqual(res.status, 503, 'the capacity gate stopped working');
    assert.strictEqual(res.json.error, 'temporarily_unavailable');
  } finally { stop(srv); stripe.close(); }
});
