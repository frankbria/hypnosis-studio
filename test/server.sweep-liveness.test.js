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

/**
 * A worker that IGNORES SIGTERM, so the SIGKILL escalation is actually reached.
 *
 * Every other engine here is `sleep`, which honours SIGTERM — which is exactly
 * why a dead-code escalation survived the suite.
 */
function makeStubbornEngine(seconds = 60) {
  const p = path.join(os.tmpdir(), `stubborn-engine-${process.pid}-${Date.now()}.sh`);
  fs.writeFileSync(p, `#!/bin/sh
trap '' TERM
outdir=""
while [ $# -gt 0 ]; do
  case "$1" in --outdir) outdir="$2"; shift 2;; *) shift;; esac
done
old=$(date -u -d '-30 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-30M +%Y-%m-%dT%H:%M:%SZ)
printf '{"jobId":"x","state":"rendering","stage":"entrainment-bed","progress":0.8,"detail":"mixing","updatedAt":"%s"}' "$old" > "$outdir/status.json"
echo $$ > "$outdir/test-worker.pid"
while true; do sleep 1; done
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

/** /proc/<pid>/stat field 22 — the same identity the server records. */
function procStartOf(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19];
}

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
  // A recorded worker that is certainly not running. Distinct from the
  // no-record case below: this exercises the dead-pid branch.
  fs.writeFileSync(path.join(rendersDir, id, 'worker.json'), JSON.stringify({
    pid: 2147483646, procStart: '12345', spawnedAt: Date.now() - 30 * 60 * 1000,
  }));
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

// --------------------------------------------------------------------------
// The pid sidecar's actual purpose: a worker that outlives its server
// --------------------------------------------------------------------------

test('a worker orphaned by a server restart is recognised as alive', async () => {
  // This is the case the sidecar exists for, and every other test in this file
  // short-circuits on the in-process set before ever reading it — so the
  // pid-file branch could be deleted and they would all still pass.
  //
  // Server killed, worker left running, new server started on the same renders
  // dir. The job must survive its boot sweep.
  const engine = makeSilentEngine(30);
  const rendersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-restart-'));
  const first = await startServer({ enginePy: engine, rendersDir });
  let workerPid = null;
  try {
    assert.strictEqual((await request(first.port, 'POST', '/api/programs', START)).status, 202);
    const [id] = jobs(rendersDir);

    // Wait for the worker to record its own pid, so we can check it later.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      try {
        workerPid = parseInt(fs.readFileSync(
          path.join(rendersDir, id, 'test-worker.pid'), 'utf8').trim(), 10);
        break;
      } catch { await sleep(50); }
    }
    assert.ok(workerPid, 'the worker never started');

    // Kill only the server. spawn() uses detached:false, so the child is
    // reparented rather than killed — which is exactly the orphan case.
    first.proc.kill('SIGKILL');
    await sleep(300);
    let stillRunning = true;
    try { process.kill(workerPid, 0); } catch { stillRunning = false; }
    assert.ok(stillRunning, 'the worker died with its server; nothing to test');

    const second = await startServer({ enginePy: engine, rendersDir });
    try {
      await sleep(2000);   // several boot/interval sweeps
      const st = statusOf(rendersDir, id);
      assert.strictEqual(st.state, 'rendering',
        'a worker that outlived its server was declared dead via the pid file');

      const res = await request(second.port, 'POST', '/api/programs', START);
      assert.strictEqual(res.status, 409,
        'the concurrency lock was freed under a still-running orphaned worker');
    } finally {
      second.proc.kill('SIGKILL');
    }
  } finally {
    if (workerPid) { try { process.kill(workerPid, 'SIGKILL'); } catch { /* gone */ } }
    try { fs.rmSync(rendersDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.unlinkSync(engine); } catch { /* best effort */ }
  }
});

test('a recorded pid that now belongs to another process reads as gone', async () => {
  // Pid reuse is not hypothetical: an OOM-kill reboot resets the pid namespace,
  // so a stale low-numbered worker pid names whatever early daemon claimed it on
  // the new boot. Treating that as alive would hold the job `rendering` forever
  // (the service answers 409 until the ceiling) and then send SIGKILL to an
  // innocent process.
  //
  // Simulated by recording a live pid with the WRONG start time — which is
  // precisely what a reused pid looks like.
  const rendersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-reuse-'));
  const id = 'job_reused';
  fs.mkdirSync(path.join(rendersDir, id), { recursive: true });
  fs.writeFileSync(path.join(rendersDir, id, 'status.json'), JSON.stringify({
    jobId: id, state: 'rendering', stage: 'voicing', progress: 0.4,
    updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  }));
  // A pid that certainly exists (this test process) with a start time that
  // certainly is not its own.
  fs.writeFileSync(path.join(rendersDir, id, 'worker.json'), JSON.stringify({
    pid: process.pid, procStart: '1', spawnedAt: Date.now() - 30 * 60 * 1000,
  }));
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
    assert.strictEqual(st.state, 'failed',
      'a job whose pid was reused by another process is unreclaimable');
    // And emphatically: this test process must survive.
    assert.ok(process.pid > 0);
  } finally {
    stop(srv);
  }
});

// --------------------------------------------------------------------------
// Recovery after the hard ceiling
// --------------------------------------------------------------------------

test('a job swept at the hard ceiling frees the slot and the service', async () => {
  const engine = makeSilentEngine(60);
  const srv = await startServer({ enginePy: engine, env: { HARD_TIMEOUT_MS: '1500' } });
  try {
    await request(srv.port, 'POST', '/api/programs', START);
    const [id] = jobs(srv.rendersDir);

    const deadline = Date.now() + 9000;
    let st = null;
    while (Date.now() < deadline) {
      st = statusOf(srv.rendersDir, id);
      if (st && st.state === 'failed') break;
      await sleep(100);
    }
    assert.strictEqual(st.state, 'failed');

    const q = JSON.parse(fs.readFileSync(path.join(srv.rendersDir, '.quota.json'), 'utf8'));
    assert.strictEqual(q.count, 0, 'the slot was not returned after the ceiling swept it');

    const res = await request(srv.port, 'POST', '/api/programs', START);
    assert.strictEqual(res.status, 202,
      'the service is still busy after reclaiming a wedged render');
  } finally {
    stop(srv);
    try { fs.unlinkSync(engine); } catch { /* best effort */ }
  }
});

test('an unstoppable worker keeps the lock rather than freeing it', async () => {
  // killWorker refuses to signal a pid it cannot confirm is ours. If the sweep
  // marked the job failed anyway, the lock would be freed under a worker that is
  // still running — #11 exactly. So an unstoppable job stays `rendering`.
  const rendersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-unstoppable-'));
  const id = 'job_unstoppable';
  fs.mkdirSync(path.join(rendersDir, id), { recursive: true });
  fs.writeFileSync(path.join(rendersDir, id, 'status.json'), JSON.stringify({
    jobId: id, state: 'rendering', stage: 'entrainment-bed', progress: 0.8,
    updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  }));
  // Alive, but unverifiable: no procStart recorded, so identity cannot be
  // confirmed and the pid must not be signalled.
  fs.writeFileSync(path.join(rendersDir, id, 'worker.json'), JSON.stringify({
    pid: process.pid, procStart: null, spawnedAt: Date.now() - 60 * 60 * 1000,
  }));

  const srv = await startServer({ rendersDir, env: { HARD_TIMEOUT_MS: '1000' } });
  try {
    await sleep(2500);
    const st = statusOf(rendersDir, id);
    assert.strictEqual(st.state, 'rendering',
      'the lock was freed for a worker that could not be stopped');
    const res = await request(srv.port, 'POST', '/api/programs', START);
    assert.strictEqual(res.status, 409);
  } finally {
    stop(srv);
  }
});

test('an unreadable timestamp never reaches the kill path', async () => {
  // Killing is the one irreversible action here. A missing or unparseable
  // timestamp used to mean "mark stale"; it must not now mean "destroy a
  // healthy paid render".
  const rendersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-badtime-'));
  const id = 'job_badtime';
  fs.mkdirSync(path.join(rendersDir, id), { recursive: true });
  fs.writeFileSync(path.join(rendersDir, id, 'status.json'), JSON.stringify({
    jobId: id, state: 'rendering', stage: 'voicing', progress: 0.4,
    updatedAt: 'not-a-timestamp',
  }));
  // Alive and ours, but recorded without a spawn time — as a job from before
  // this change would be — so age falls back to the unparseable updatedAt.
  fs.writeFileSync(path.join(rendersDir, id, 'worker.json'), JSON.stringify({
    pid: process.pid, procStart: procStartOf(process.pid),
  }));

  const srv = await startServer({ rendersDir, env: { HARD_TIMEOUT_MS: '500' } });
  try {
    await sleep(2000);
    const st = statusOf(rendersDir, id);
    assert.strictEqual(st.state, 'rendering',
      'a job with an unreadable timestamp was swept, and its worker signalled');
  } finally {
    stop(srv);
  }
});

test('a worker that ignores SIGTERM is still killed', async () => {
  // The escalation exists for exactly this. It was dead code: it gated on
  // `child.killed`, which means "a signal was delivered" and is true the instant
  // kill() returns — so SIGKILL never fired for a job this server started.
  //
  // Invisible to every other test here, because they all use `sleep`, which
  // honours SIGTERM and dies on the first signal.
  const engine = makeStubbornEngine(60);
  const srv = await startServer({ enginePy: engine, env: { HARD_TIMEOUT_MS: '1200' } });
  let workerPid = null;
  try {
    await request(srv.port, 'POST', '/api/programs', START);
    const [id] = jobs(srv.rendersDir);

    const found = Date.now() + 4000;
    while (Date.now() < found) {
      try {
        workerPid = parseInt(fs.readFileSync(
          path.join(srv.rendersDir, id, 'test-worker.pid'), 'utf8').trim(), 10);
        break;
      } catch { await sleep(50); }
    }
    assert.ok(workerPid, 'the stubborn worker never started');

    // Ceiling, then SIGTERM (ignored), then a second later SIGKILL.
    const deadline = Date.now() + 10000;
    let alive = true;
    while (Date.now() < deadline) {
      try { process.kill(workerPid, 0); } catch { alive = false; break; }
      await sleep(100);
    }
    assert.strictEqual(alive, false,
      'a worker that ignores SIGTERM survived the hard ceiling — the lock is ' +
      'freed while it keeps mixing, which is the OOM #11 is about');
  } finally {
    if (workerPid) { try { process.kill(workerPid, 'SIGKILL'); } catch { /* gone */ } }
    stop(srv);
    try { fs.unlinkSync(engine); } catch { /* best effort */ }
  }
});
