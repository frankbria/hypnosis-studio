// Serving the two-minute program samples (issue #60).
//
// A sample is the opposite of a master in every way that matters here. The
// masters are the product: one guessable URL makes them free, so they are
// signed, expiring and `no-store` (#59). A sample is an advertisement: it has
// to be playable by a stranger who has bought nothing, from a URL a CDN is
// welcome to keep.
//
// So the two things worth proving are that the sample really is public and
// cacheable, and that making it public did not open a second door onto the
// masters sitting in the same directory.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SIGNING = 'delivery_signing_secret_for_tests';
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

function request(port, method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 8000 },
      (res) => {
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
    r.end();
  });
}

const TRACKS = [
  { n: 1, id: 'polymath_track1', title: 'I', phase: 'Foundation', durationSec: 812.4 },
  { n: 2, id: 'polymath_track2', title: 'II', phase: 'Deepening', durationSec: 830.0 },
  { n: 3, id: 'polymath_track3', title: 'III', phase: 'Mastery', durationSec: 805.5 },
  { n: 4, id: 'polymath_track4', title: 'IV', phase: 'Integration', durationSec: 441.1 },
];

const SAMPLE_BYTES = Buffer.from('not-really-an-mp3, but distinguishable');

/**
 * A catalog on disk. `programs` is a list of
 * `{ key, goal, voiceSet, publishable, sample }`, where `sample` is what (if
 * anything) to write as that program's sample.mp3.
 */
function makeCatalog(dir, programs) {
  const catalogDir = path.join(dir, 'catalog');
  const entries = [];
  for (const p of programs) {
    const key = p.key;
    fs.mkdirSync(path.join(catalogDir, key), { recursive: true });
    const tracks = TRACKS.map((t) => ({
      ...t,
      id: `${p.goal}_track${t.n}`,
      wav: `${key}/${p.goal}_track${t.n}.wav`,
      mp3: `${key}/${p.goal}_track${t.n}.mp3`,
    }));
    for (const t of tracks) {
      fs.writeFileSync(path.join(catalogDir, t.wav), `WAV:${t.id}`);
      fs.writeFileSync(path.join(catalogDir, t.mp3), `MP3:${t.id}`);
    }
    if (p.sample !== undefined) {
      fs.writeFileSync(path.join(catalogDir, key, 'sample.mp3'), p.sample);
    }
    entries.push({
      key, goal: p.goal, voiceSet: p.voiceSet, goalTitle: p.goalTitle || 'The Polymath Mind',
      publishable: p.publishable !== false, tracks,
      qa: { passed: true, problems: [] },
      approval: { listen: 'full', at: '2026-09-05T10:00:00Z', by: 'frankbria' },
    });
  }
  const manifestPath = path.join(dir, 'catalog.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1, programs: entries, durationsByGoal: {},
  }));
  return { catalogDir, manifestPath };
}

const ONE = {
  key: 'polymath__male', goal: 'polymath', voiceSet: 'male', sample: SAMPLE_BYTES,
};

async function startServer(programs = [ONE], env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'samp-'));
  const { catalogDir, manifestPath } = makeCatalog(dir, programs);
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
      SWEEP_INTERVAL_MS: '600000',
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
    if (Date.now() > deadline) throw new Error(`never ready: ${logs.join('')}`);
    await sleep(50);
  }
  return { proc, port, dir, catalogDir, logs };
}

const stop = (srv) => { try { srv.proc.kill('SIGKILL'); } catch { /* gone */ } };

/** Start a sample download and hang up as soon as the first bytes arrive. */
function abandonMidStream(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/catalog/polymath__male/sample.mp3' },
      (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
        res.once('end', resolve);
      });
    req.on('error', () => resolve());
    req.setTimeout(5000, () => { req.destroy(); resolve(); });
  });
}

// ---------------------------------------------------------------------------
// What /api/samples advertises
// ---------------------------------------------------------------------------

test('a program with a sample on this box is advertised', async () => {
  const srv = await startServer();
  try {
    const res = await request(srv.port, 'GET', '/api/samples');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.samples.map((s) => s.key), ['polymath__male']);
    assert.equal(res.json.samples[0].goal, 'polymath');
    assert.equal(res.json.samples[0].voiceSet, 'male');
    assert.equal(res.json.samples[0].bytes, SAMPLE_BYTES.length);
  } finally { stop(srv); }
});

test('the advertised url is the one that actually serves the sample', async () => {
  // The frontend uses this string verbatim. A url the server itself will not
  // answer is a dead play button on the page whose job is to be pressed.
  const srv = await startServer();
  try {
    const { samples } = (await request(srv.port, 'GET', '/api/samples')).json;
    const res = await request(srv.port, 'GET', samples[0].url);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, SAMPLE_BYTES);
  } finally { stop(srv); }
});

test('a catalogued program with no sample file is not advertised', async () => {
  // catalog.json is committed and rides every deploy; the audio is gitignored
  // and does not. #139 exists because that gap already bit once for the
  // masters — the samples must not repeat it.
  const srv = await startServer([{ ...ONE, sample: undefined }]);
  try {
    const res = await request(srv.port, 'GET', '/api/samples');
    assert.deepEqual(res.json.samples, []);
  } finally { stop(srv); }
});

test('an empty sample file is not advertised', async () => {
  // A half-finished copy leaves a zero-byte file behind, and a play button that
  // loads nothing reads as a broken site rather than a missing sample.
  const srv = await startServer([{ ...ONE, sample: Buffer.alloc(0) }]);
  try {
    assert.deepEqual((await request(srv.port, 'GET', '/api/samples')).json.samples, []);
  } finally { stop(srv); }
});

test('an unpublishable program is not advertised even with a sample on disk', async () => {
  // A sample is an advertisement. `publishable` is the flag that says the studio
  // has confirmed it can deliver this audio; advertising anything else promises
  // a program that checkout will not sell.
  const srv = await startServer([{ ...ONE, publishable: false }]);
  try {
    assert.deepEqual((await request(srv.port, 'GET', '/api/samples')).json.samples, []);
  } finally { stop(srv); }
});

test('the listing never says where a sample lives on disk', async () => {
  // The absolute path of a master's directory is not a secret worth much on its
  // own, but it is free to withhold and it is what an attacker would want next
  // after learning the masters sit beside the sample.
  const srv = await startServer();
  try {
    const res = await request(srv.port, 'GET', '/api/samples');
    assert.equal(res.json.samples[0].file, undefined);
    assert.ok(!res.body.toString('utf8').includes(srv.catalogDir),
      'the listing exposes the catalog root on disk');
  } finally { stop(srv); }
});

test('a cache-busting query does not turn a sample into a 404', async () => {
  const srv = await startServer();
  try {
    const res = await request(srv.port, 'GET',
      '/api/catalog/polymath__male/sample.mp3?v=2');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, SAMPLE_BYTES);
  } finally { stop(srv); }
});

test('a query string does not turn the listing into a 404', async () => {
  // The sample route below tolerates one precisely so a cache-buster cannot
  // break it. The listing is `Cache-Control: public` too, so it is subject to
  // the same intermediaries — and if it 404s, `useProgramSamples` fails
  // silently by design and the storefront falls back to the solo voices with
  // no signal that the feature just turned itself off.
  const srv = await startServer();
  try {
    const res = await request(srv.port, 'GET', '/api/samples?v=2');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.samples.map((s) => s.key), ['polymath__male']);
  } finally { stop(srv); }
});

test('the listing is cacheable, but not for long', async () => {
  const srv = await startServer();
  try {
    const res = await request(srv.port, 'GET', '/api/samples');
    assert.match(res.headers['cache-control'], /public/);
    assert.doesNotMatch(res.headers['cache-control'], /no-store/);
  } finally { stop(srv); }
});

test('an empty catalog advertises nothing rather than failing', async () => {
  const srv = await startServer([]);
  try {
    const res = await request(srv.port, 'GET', '/api/samples');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.samples, []);
  } finally { stop(srv); }
});

// ---------------------------------------------------------------------------
// Serving one sample
// ---------------------------------------------------------------------------

test('a sample plays for a stranger who has bought nothing', async () => {
  const srv = await startServer();
  try {
    const res = await request(srv.port, 'GET', '/api/catalog/polymath__male/sample.mp3');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'audio/mpeg');
    assert.deepEqual(res.body, SAMPLE_BYTES);
  } finally { stop(srv); }
});

test('a sample is cacheable for a long time and never a download', async () => {
  // The masters are `private, no-store` and Content-Disposition: attachment,
  // because they are a purchase. A sample is the opposite on both counts: it
  // should play inline, and a CDN should be welcome to keep it.
  const srv = await startServer();
  try {
    const res = await request(srv.port, 'GET', '/api/catalog/polymath__male/sample.mp3');
    assert.match(res.headers['cache-control'], /public/);
    assert.match(res.headers['cache-control'], /max-age=\d{4,}/);
    assert.equal(res.headers['content-disposition'], undefined);
  } finally { stop(srv); }
});

test('HEAD reports the length without the body', async () => {
  const srv = await startServer();
  try {
    const res = await request(srv.port, 'HEAD', '/api/catalog/polymath__male/sample.mp3');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-length'], String(SAMPLE_BYTES.length));
    assert.equal(res.body.length, 0);
  } finally { stop(srv); }
});

test('a sample nobody cut is a 404, not a crash', async () => {
  const srv = await startServer([{ ...ONE, sample: undefined }]);
  try {
    const res = await request(srv.port, 'GET', '/api/catalog/polymath__male/sample.mp3');
    assert.equal(res.status, 404);
  } finally { stop(srv); }
});

test('an unknown program is a 404', async () => {
  const srv = await startServer();
  try {
    assert.equal(
      (await request(srv.port, 'GET', '/api/catalog/river__female/sample.mp3')).status,
      404);
  } finally { stop(srv); }
});

// ---------------------------------------------------------------------------
// The samples route must not become a door onto the masters
// ---------------------------------------------------------------------------

test('a client that goes away mid-stream does not leak a file descriptor', async () => {
  // `res` emits `close` on a client disconnect, never `error`, and `pipe()`
  // unpipes the source without destroying it — so listening only for `error`
  // holds the fd for the life of the process. Enough abandoned plays is EMFILE,
  // and in this server that means every synchronous fs call starts failing at
  // once: this route 404s, `readJsonSafe` returns null so job routes 404, and
  // the retention sweep's readdirSync goes silently blind.
  //
  // Measured against the process's real open descriptors rather than a stub,
  // because the leak is in Node's stream plumbing, not in our code's shape.
  const srv = await startServer([{ ...ONE, sample: Buffer.alloc(4 * 1024 * 1024, 7) }]);
  try {
    const openFds = () => {
      try { return fs.readdirSync(`/proc/${srv.proc.pid}/fd`).length; }
      catch { return null; }
    };
    if (openFds() === null) return;   // not Linux; nothing to measure

    // Warm up, so one-off allocations are not counted as a leak.
    for (let i = 0; i < 3; i++) await abandonMidStream(srv.port);
    await sleep(150);
    const before = openFds();

    for (let i = 0; i < 25; i++) await abandonMidStream(srv.port);
    await sleep(300);

    const after = openFds();
    assert.ok(after - before < 10,
      `25 abandoned plays left ${after - before} descriptors open `
      + `(${before} -> ${after}) — the read stream is not destroyed on close`);
  } finally { stop(srv); }
});

test('a master cannot be fetched through the sample route', async () => {
  // The masters sit in the same directory as the sample. This is the whole risk
  // of making that directory publicly addressable at all.
  const srv = await startServer();
  try {
    for (const p of [
      '/api/catalog/polymath__male/polymath_track1.mp3',
      '/api/catalog/polymath__male/sample.mp3/../polymath_track1.mp3',
      '/api/catalog/polymath__male%2Fpolymath_track1.mp3/sample.mp3',
    ]) {
      const res = await request(srv.port, 'GET', p);
      assert.notEqual(res.status, 200, `${p} served something`);
      assert.doesNotMatch(res.body.toString('utf8'), /MP3:polymath_track1/, p);
    }
  } finally { stop(srv); }
});

test('a traversal in the program key is refused', async () => {
  const srv = await startServer();
  try {
    for (const key of ['..', '..%2F..', 'polymath__male%2F..%2F..']) {
      const res = await request(srv.port, 'GET', `/api/catalog/${key}/sample.mp3`);
      assert.equal(res.status, 404, key);
    }
  } finally { stop(srv); }
});

test('the sample is not reachable through the static file server either', async () => {
  const srv = await startServer();
  try {
    for (const p of ['/catalog/polymath__male/sample.mp3',
      '/renders/catalog/polymath__male/sample.mp3']) {
      assert.notEqual((await request(srv.port, 'GET', p)).status, 200, p);
    }
  } finally { stop(srv); }
});

test('a signed master link still works alongside the public sample route', async () => {
  // Regression fence: the sample route is matched before the files route, and a
  // regex that swallowed `/files/` would silently break every delivery.
  const crypto = require('node:crypto');
  const srv = await startServer();
  try {
    const exp = Date.now() + 60_000;
    const name = 'polymath_track1.mp3';
    const sig = crypto.createHmac('sha256', SIGNING)
      .update(`polymath__male\n${name}\n${exp}`).digest('hex');
    const res = await request(srv.port, 'GET',
      `/api/catalog/polymath__male/files/${name}?exp=${exp}&sig=${sig}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.toString('utf8'), 'MP3:polymath_track1');
  } finally { stop(srv); }
});
