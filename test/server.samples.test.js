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

/** Every (goal, voice set) the server will sell — VALID_GOALS x VALID_VOICE_SETS. */
const SELLABLE_GOALS = ['polymath', 'golden_thread', 'inner_studio', 'open_gate', 'river'];
const ALL = SELLABLE_GOALS.flatMap((goal) => ['male', 'female'].map((voiceSet) => ({
  key: `${goal}__${voiceSet}`, goal, voiceSet, sample: SAMPLE_BYTES,
})));

async function startServer(programs = [ONE], env = {}, beforeStart = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'samp-'));
  const { catalogDir, manifestPath } = makeCatalog(dir, programs);
  // A hook rather than more `programs` options: the cases worth testing are
  // about the state of the *disk* at boot (a master that did not ride the
  // deploy), which makeCatalog cannot express because it always writes them.
  if (beforeStart) beforeStart({ dir, catalogDir, manifestPath });
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

// ---------------------------------------------------------------------------
// Whether this box delivers instantly (#137)
// ---------------------------------------------------------------------------
//
// The storefront is static HTML built from the repo, so it cannot know this on
// its own. `engine/catalog.json` rides every deploy and says what is publishable
// *in the repo*; whether a purchase is actually instant depends on the masters
// being on *this box*, which is the gap #139 was opened about. So the claim on
// the hero has to be answered by the server, and this is the field that answers
// it.
//
// The direction of every one of these tests is the same: it is only ever true
// when a purchase really would download rather than render. Being wrong the
// other way is a promise broken after payment, which is what #61 was opened
// about and what #137 exists to stop recurring.

test('a box that can serve every purchase says delivery is instant', async () => {
  const srv = await startServer(ALL);
  try {
    const res = await request(srv.port, 'GET', '/api/samples');
    assert.equal(res.json.instantDelivery, true);
  } finally { stop(srv); }
});

test('one catalogued program does not make the whole storefront instant', async () => {
  // The claim sits above the entire goal grid, so it is a promise about ANY
  // purchase a visitor could make. A partial catalog is a supported state — the
  // server demotes what it cannot serve and renders those on demand — so a box
  // holding one program of ten must not advertise instant delivery. Buying any
  // of the other nine would be a twenty-minute wait after being promised
  // seconds, which is #61 with extra steps.
  const srv = await startServer([ONE]);
  try {
    const res = await request(srv.port, 'GET', '/api/samples');
    assert.equal(res.json.instantDelivery, false);
    // ...while still advertising the sample it does have.
    assert.deepEqual(res.json.samples.map((x) => x.key), ['polymath__male']);
  } finally { stop(srv); }
});

test('one missing voice set of one goal is enough to stop the claim', async () => {
  // The narrowest possible hole. "Your choice of voice" is on the $39 card, so a
  // goal catalogued in one voice only is still a purchase that renders.
  const srv = await startServer(ALL.filter((p) => p.key !== 'river__female'));
  try {
    assert.equal((await request(srv.port, 'GET', '/api/samples')).json.instantDelivery,
      false);
  } finally { stop(srv); }
});

test('an empty catalog does not claim instant delivery', async () => {
  // The state the manifest ships in, and the state every deploy is in until the
  // pre-render has been run. Every purchase renders on demand.
  const srv = await startServer([]);
  try {
    const res = await request(srv.port, 'GET', '/api/samples');
    assert.equal(res.json.instantDelivery, false);
  } finally { stop(srv); }
});

test('a program that is not publishable does not make delivery instant', async () => {
  const srv = await startServer(ALL.map((p) => (
    p.key === 'river__male' ? { ...p, publishable: false } : p)));
  try {
    assert.equal((await request(srv.port, 'GET', '/api/samples')).json.instantDelivery,
      false);
  } finally { stop(srv); }
});

test('publishable in the repo is not instant when the masters are not on the box', async () => {
  // The whole reason this is a served fact and not a build-time one. catalog.json
  // is committed and rides the deploy; the audio is gitignored and does not. A
  // build-time check would read this box as instant and put "downloads in
  // seconds" on the hero of a box that renders every purchase.
  const srv = await startServer(ALL, {}, ({ catalogDir }) => {
    for (const f of fs.readdirSync(path.join(catalogDir, 'polymath__male'))) {
      if (f !== 'sample.mp3') fs.rmSync(path.join(catalogDir, 'polymath__male', f));
    }
  });
  try {
    assert.equal((await request(srv.port, 'GET', '/api/samples')).json.instantDelivery,
      false);
  } finally { stop(srv); }
});

test('delivery is instant even when nobody has cut a sample yet', async () => {
  // Guards the lazy version of this field, `samples.length > 0`. Samples are an
  // advertisement and masters are the product; a box that can deliver but has
  // not been sampled still delivers, and the two facts must not be conflated.
  const srv = await startServer(ALL.map((p) => ({ ...p, sample: undefined })));
  try {
    const res = await request(srv.port, 'GET', '/api/samples');
    assert.deepEqual(res.json.samples, []);
    assert.equal(res.json.instantDelivery, true);
  } finally { stop(srv); }
});


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
    // The listing now carries a delivery claim (#137), and the response is
    // `public` — so this max-age is also how long a shared proxy may keep
    // serving "instant" after this box stopped being able to deliver.
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers['cache-control'])[1]);
    assert.ok(maxAge > 0 && maxAge <= 60,
      `a stale instant-delivery claim could be served for ${maxAge}s`);
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
