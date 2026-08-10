// Liveness-based stale sweep (issue #11).
//
// STALE_MS was 2 minutes and staleness was judged purely by how long ago
// status.json was touched. A single segment can legitimately stall far longer
// than that without a status write — the current retry budget is 4 attempts x a
// 120 s timeout plus 5+15+30 s of backoff, ~8.8 minutes, and up to ~17.7 if a
// 422 sends it through the fallback settings. Assembly is the other long stage:
// it writes status once per track.
//
// The sweep then marked the job `failed` WITHOUT killing the child.
// anyJobRendering() reported no render in flight, a second POST was accepted,
// and two NumPy mixers ran concurrently on a 4 GB box — exactly the OOM the
// chunked assembler exists to avoid.
//
// The assertions here are mostly about what must NOT happen to a healthy render.
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
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

/**
 * An engine that goes quiet for a long time, exactly like a stalled TTS retry
 * or a single track's assembly: it writes one already-old status and then sits
 * there alive.
 */
function makeSilentEngine(seconds = 30) {
  const p = path.join(os.tmpdir(), `silent-engine-${process.pid}-${Date.now()}.sh`);
  fs.writeFileSync(p, `#!/bin/sh
outdir=""
while [ $# -gt 0 ]; do
  case "$1" in --outdir) outdir="$2"; shift 2;; *) shift;; esac
done
old=$(date -u -d '-30 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-30M +%Y-%m-%dT%H:%M:%SZ)
printf '{"jobId":"x","state":"rendering","stage":"entrainment-bed","progress":0.8,"detail":"mixing","updatedAt":"%s"}' "$old" > "$outdir/status.json"
echo $$ > "$outdir/test-worker.pid"
sleep ${seconds}
`, { mode: 0o755 });
  return p;
}

async function startServer({ enginePy, rendersDir, sweepMs = '300', env = {} } = {}) {
  const dir = rendersDir || fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), RENDERS_DIR: dir,
      ACCESS_CODE: 'testcode', MAX_JOBS_PER_DAY: '6',
      ENGINE_PY: enginePy || '/bin/false',
      SWEEP_INTERVAL_MS: sweepMs,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await sleep(1200);
  return { proc, port, rendersDir: dir };
}

function stop({ proc, rendersDir }) {
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  try { fs.rmSync(rendersDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function jobs(rendersDir) {
  return fs.readdirSync(rendersDir).filter((n) => n.startsWith('job_'));
}

function statusOf(rendersDir, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(rendersDir, id, 'status.json'), 'utf8'));
  } catch { return null; }
}

const START = { accessCode: 'testcode', goal: 'river', voiceSet: 'male' };

// --------------------------------------------------------------------------
// The bug: a live worker must survive the sweep
// --------------------------------------------------------------------------

test('a live worker in a long silent stage is not declared failed', async () => {
  const engine = makeSilentEngine(30);
  const srv = await startServer({ enginePy: engine });
  try {
    const res = await request(srv.port, 'POST', '/api/programs', START);
    assert.strictEqual(res.status, 202);

    await sleep(2000); // several sweep ticks against an already-stale timestamp

    const [id] = jobs(srv.rendersDir);
    const st = statusOf(srv.rendersDir, id);
    assert.strictEqual(st.state, 'rendering',
      'the sweep declared a job failed whose worker is alive and working');
  } finally {
    stop(srv);
    try { fs.unlinkSync(engine); } catch { /* best effort */ }
  }
});

test('a second render cannot start while the first worker is alive', async () => {
  // The failure this issue is really about: the sweep frees the concurrency
  // lock, a second POST is accepted, and two NumPy mixers run on a 4 GB box.
  const engine = makeSilentEngine(30);
  const srv = await startServer({ enginePy: engine });
  try {
    assert.strictEqual((await request(srv.port, 'POST', '/api/programs', START)).status, 202);
    await sleep(2000);

    const second = await request(srv.port, 'POST', '/api/programs', START);
    assert.strictEqual(second.status, 409,
      'a second render was accepted while the first worker was still running');
    assert.match(second.body, /busy/);
    assert.strictEqual(jobs(srv.rendersDir).length, 1, 'a second job directory was created');
  } finally {
    stop(srv);
    try { fs.unlinkSync(engine); } catch { /* best effort */ }
  }
});

test('a live worker keeps its quota slot', async () => {
  const engine = makeSilentEngine(30);
  const srv = await startServer({ enginePy: engine });
  try {
    await request(srv.port, 'POST', '/api/programs', START);
    await sleep(2000);
    const q = JSON.parse(fs.readFileSync(path.join(srv.rendersDir, '.quota.json'), 'utf8'));
    assert.strictEqual(q.count, 1);
  } finally {
    stop(srv);
    try { fs.unlinkSync(engine); } catch { /* best effort */ }
  }
});

// --------------------------------------------------------------------------
// A genuinely dead worker must still be reclaimed
// --------------------------------------------------------------------------

test('a job orphaned by a restart is still swept', async () => {
  // The case the sweep exists for. No worker was ever started by this process,
  // and the recorded pid is not running.
  const rendersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-orphan-'));
  const id = 'job_orphan';
  fs.mkdirSync(path.join(rendersDir, id), { recursive: true });
  fs.writeFileSync(path.join(rendersDir, id, 'status.json'), JSON.stringify({
    jobId: id, state: 'rendering', stage: 'voicing', progress: 0.4,
    updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  }));
  // A pid that is certainly not running.
  fs.writeFileSync(path.join(rendersDir, id, 'worker.pid'), '2147483646');
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(rendersDir, '.quota.json'),
    JSON.stringify({ day: today, count: 1, jobs: [id] }));

  const srv = await startServer({ rendersDir });
  try {
    const deadline = Date.now() + 4000;
    let st = null;
    while (Date.now() < deadline) {
      st = statusOf(rendersDir, id);
      if (st && st.state === 'failed') break;
      await sleep(50);
    }
    assert.strictEqual(st.state, 'failed', 'a genuinely dead job was never reclaimed');

    const q = JSON.parse(fs.readFileSync(path.join(rendersDir, '.quota.json'), 'utf8'));
    assert.strictEqual(q.count, 0, 'its quota slot was not returned');
  } finally {
    stop(srv);
  }
});

test('a job with no pid file at all is still swept', async () => {
  // Written before this change, or the pid file lost. Nothing claims the worker
  // is alive, so it must be reclaimable — otherwise a stuck job blocks the
  // service forever.
  const rendersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-nopid-'));
  const id = 'job_nopid';
  fs.mkdirSync(path.join(rendersDir, id), { recursive: true });
  fs.writeFileSync(path.join(rendersDir, id, 'status.json'), JSON.stringify({
    jobId: id, state: 'rendering', stage: 'voicing', progress: 0.4,
    updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  }));

  const srv = await startServer({ rendersDir });
  try {
    const deadline = Date.now() + 4000;
    let st = null;
    while (Date.now() < deadline) {
      st = statusOf(rendersDir, id);
      if (st && st.state === 'failed') break;
      await sleep(50);
    }
    assert.strictEqual(st.state, 'failed');
  } finally {
    stop(srv);
  }
});

// --------------------------------------------------------------------------
// The hard ceiling: a wedged but living worker must eventually be reclaimed
// --------------------------------------------------------------------------

test('a worker past the hard ceiling is swept and killed', async () => {
  // Liveness alone never reclaims a process blocked forever on a socket. The
  // ceiling is the backstop, and it is the only path that kills.
  const engine = makeSilentEngine(60);
  const srv = await startServer({
    enginePy: engine,
    env: { HARD_TIMEOUT_MS: '1500' },
  });
  try {
    await request(srv.port, 'POST', '/api/programs', START);
    const [id] = jobs(srv.rendersDir);

    const deadline = Date.now() + 8000;
    let st = null;
    while (Date.now() < deadline) {
      st = statusOf(srv.rendersDir, id);
      if (st && st.state === 'failed') break;
      await sleep(100);
    }
    assert.strictEqual(st.state, 'failed', 'a wedged worker was never reclaimed');
    assert.match(st.error || '', /too long|timed out|exceeded/i,
      'the message should say it ran too long, not that the service restarted');

    // And the process is actually gone, or the OOM this issue is about is still
    // possible.
    const pid = parseInt(
      fs.readFileSync(path.join(srv.rendersDir, id, 'test-worker.pid'), 'utf8').trim(), 10);
    await sleep(1200); // allow SIGTERM then SIGKILL
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    assert.strictEqual(alive, false, 'the swept worker is still running');
  } finally {
    stop(srv);
    try { fs.unlinkSync(engine); } catch { /* best effort */ }
  }
});

test('the hard ceiling is far above a real render', async () => {
  // A full 4-track render is 15-20 minutes and a single stall can be ~17. A
  // ceiling anywhere near those would kill healthy paid work.
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const m = src.match(/HARD_TIMEOUT_MS[^\n]*?'(\d+)'/);
  assert.ok(m, 'HARD_TIMEOUT_MS default not found');
  const minutes = parseInt(m[1], 10) / 60000;
  assert.ok(minutes >= 40, `hard ceiling is only ${minutes} minutes`);
});
