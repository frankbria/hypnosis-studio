// Quota release on failure (issue #10).
//
// bumpQuota() fired before the worker started and nothing ever decremented it,
// so a failed render permanently ate one of MAX_JOBS_PER_DAY. The pathological
// case is a config error: a missing ELEVENLABS_API_KEY fails every job a few
// seconds in, silently burning the whole day's capacity while producing nothing.
//
// The interesting requirement is idempotency. Both the worker-exit handler and
// the stale sweep can declare the same job failed, and they genuinely race — a
// worker can exit at the moment the sweep decides it is stale. Neither may
// refund twice.
//
// Each case gets its own renders root via RENDERS_DIR and its own server, so a
// test can never touch a developer's real renders/ directory.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

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
 * A server with its own renders dir and a worker that is guaranteed to fail.
 *
 * ENGINE_PY points at a shell that exits non-zero without writing a status, so
 * every job takes the "worker crashed" path — the same shape as a missing API
 * key, which is the case the issue is about.
 */
async function startServer({ enginePy = '/bin/false', maxJobsPerDay = '6', env = {} } = {}) {
  const rendersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-'));
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RENDERS_DIR: rendersDir,
      ACCESS_CODE: 'testcode',
      MAX_JOBS_PER_DAY: maxJobsPerDay,
      ENGINE_PY: enginePy,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 8000);
    const onData = (b) => {
      if (String(b).includes('listening') || String(b).includes(String(port))) {
        clearTimeout(timer); resolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    setTimeout(() => { clearTimeout(timer); resolve(); }, 1200);
  });
  return { proc, port, rendersDir };
}

function stop({ proc, rendersDir }) {
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  try { fs.rmSync(rendersDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function readQuotaFile(rendersDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(rendersDir, '.quota.json'), 'utf8'));
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForQuota(rendersDir, predicate, ms = 4000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = readQuotaFile(rendersDir);
    if (predicate(last)) return last;
    await sleep(50);
  }
  return last;
}

const START = { accessCode: 'testcode', goal: 'river', voiceSet: 'male' };

// --------------------------------------------------------------------------
// The bug
// --------------------------------------------------------------------------

test('a failed render gives its quota slot back', async () => {
  const srv = await startServer();
  try {
    const res = await request(srv.port, 'POST', '/api/programs', START);
    assert.strictEqual(res.status, 202);

    const q = await waitForQuota(srv.rendersDir, (v) => v && v.count === 0);
    assert.strictEqual(q.count, 0, 'a job that never produced anything must not cost a slot');
  } finally {
    stop(srv);
  }
});

test('a broken engine cannot burn the whole day', async () => {
  // The pathological case from the issue: a config error fails every job in
  // seconds. Before the fix this consumed all six slots and then refused to
  // start anything for the rest of the day.
  const srv = await startServer({ maxJobsPerDay: '3' });
  try {
    for (let i = 0; i < 5; i += 1) {
      const res = await request(srv.port, 'POST', '/api/programs', START);
      assert.strictEqual(res.status, 202, `request ${i + 1} was refused: ${res.body}`);
      await waitForQuota(srv.rendersDir, (v) => v && v.count === 0);
    }
    const q = readQuotaFile(srv.rendersDir);
    assert.strictEqual(q.count, 0);
  } finally {
    stop(srv);
  }
});

// --------------------------------------------------------------------------
// Idempotency — the exit handler and the stale sweep both declare jobs failed
// --------------------------------------------------------------------------

test('a slot is never refunded twice', async () => {
  const srv = await startServer({ maxJobsPerDay: '6' });
  try {
    // Two jobs fail. If either refund double-counted, the total would go
    // negative — which would silently hand out extra capacity every day.
    await request(srv.port, 'POST', '/api/programs', START);
    await waitForQuota(srv.rendersDir, (v) => v && v.count === 0);
    await request(srv.port, 'POST', '/api/programs', START);
    await waitForQuota(srv.rendersDir, (v) => v && v.count === 0);

    const q = readQuotaFile(srv.rendersDir);
    assert.strictEqual(q.count, 0, 'count went wrong after two failures');
    assert.ok(q.count >= 0, 'the counter must never go negative');
    assert.deepStrictEqual(q.jobs, [], 'the ledger should be empty once both refunds land');
  } finally {
    stop(srv);
  }
});

test('the stale sweep refunding a job the exit handler already refunded is a no-op', async () => {
  const srv = await startServer();
  try {
    await request(srv.port, 'POST', '/api/programs', START);
    const q = await waitForQuota(srv.rendersDir, (v) => v && v.count === 0);
    assert.strictEqual(q.count, 0);

    // Put the job back into `rendering` with a stale timestamp so the sweep
    // picks it up and declares it failed a second time.
    const [id] = fs.readdirSync(srv.rendersDir).filter((n) => n.startsWith('job_'));
    const p = path.join(srv.rendersDir, id, 'status.json');
    const st = JSON.parse(fs.readFileSync(p, 'utf8'));
    fs.writeFileSync(p, JSON.stringify({
      ...st, state: 'rendering',
      updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    }));

    await sleep(1500);
    const after = readQuotaFile(srv.rendersDir);
    assert.strictEqual(after.count, 0, 'the sweep refunded a slot that was already returned');
  } finally {
    stop(srv);
  }
});

// --------------------------------------------------------------------------
// A successful job still costs exactly one slot
// --------------------------------------------------------------------------

test('a successful render consumes exactly one slot', async () => {
  // An engine that writes a `ready` status and exits 0.
  const fake = path.join(os.tmpdir(), `fake-engine-${Date.now()}.sh`);
  fs.writeFileSync(fake, `#!/bin/sh
outdir=""
while [ $# -gt 0 ]; do
  case "$1" in --outdir) outdir="$2"; shift 2;; *) shift;; esac
done
printf '{"jobId":"x","state":"ready","stage":"mastering-qa","progress":1,"detail":"done","updatedAt":"%s"}' \\
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$outdir/status.json"
exit 0
`, { mode: 0o755 });

  const srv = await startServer({ enginePy: fake });
  try {
    await request(srv.port, 'POST', '/api/programs', START);
    await sleep(1500);
    const q = readQuotaFile(srv.rendersDir);
    assert.strictEqual(q.count, 1, 'a completed render must still cost its slot');
    assert.strictEqual(q.jobs.length, 1, 'the slot should still be held');
  } finally {
    stop(srv);
    try { fs.unlinkSync(fake); } catch { /* best effort */ }
  }
});

// --------------------------------------------------------------------------
// The cap still works
// --------------------------------------------------------------------------

test('the daily cap still refuses once the slots are genuinely held', async () => {
  const fake = path.join(os.tmpdir(), `fake-ok-${Date.now()}.sh`);
  fs.writeFileSync(fake, `#!/bin/sh
outdir=""
while [ $# -gt 0 ]; do
  case "$1" in --outdir) outdir="$2"; shift 2;; *) shift;; esac
done
printf '{"jobId":"x","state":"ready","stage":"mastering-qa","progress":1,"detail":"done","updatedAt":"%s"}' \\
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$outdir/status.json"
exit 0
`, { mode: 0o755 });

  const srv = await startServer({ enginePy: fake, maxJobsPerDay: '2' });
  try {
    for (let i = 0; i < 2; i += 1) {
      const res = await request(srv.port, 'POST', '/api/programs', START);
      assert.strictEqual(res.status, 202);
      await sleep(700);
    }
    const res = await request(srv.port, 'POST', '/api/programs', START);
    assert.strictEqual(res.status, 429, 'the cap should still bind on successful renders');
    assert.match(res.body, /daily_cap/);
  } finally {
    stop(srv);
    try { fs.unlinkSync(fake); } catch { /* best effort */ }
  }
});

// --------------------------------------------------------------------------
// A quota file written before this change must not break
// --------------------------------------------------------------------------

test('a legacy quota file with no ledger still enforces the cap', async () => {
  const rendersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-legacy-'));
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(rendersDir, '.quota.json'),
    JSON.stringify({ day: today, count: 4 }));

  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), RENDERS_DIR: rendersDir,
      ACCESS_CODE: 'testcode', MAX_JOBS_PER_DAY: '4', ENGINE_PY: '/bin/false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await sleep(1200);
    const res = await request(port, 'POST', '/api/programs', START);
    assert.strictEqual(res.status, 429,
      'a pre-existing quota file must still be honoured, not silently reset');
  } finally {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    try { fs.rmSync(rendersDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// --------------------------------------------------------------------------
// The guards, pinned individually
//
// These three protect each other in the happy path, which makes it easy to
// write tests that pass with any one of them removed. Each case below is built
// so exactly one guard is load-bearing.
// --------------------------------------------------------------------------

test('a double refund cannot hand back a slot another job is holding', async () => {
  // The exact race the issue names: a worker exits at the moment the sweep
  // decides it is stale, so both paths try to return the same slot.
  //
  // Staged rather than raced, because it has to be deterministic: job_ghost has
  // already been refunded (it is absent from the ledger) but is still sitting in
  // `rendering`, so the boot sweep will declare it failed and try to refund it a
  // second time. job_holder's slot is what makes that visible — the earlier
  // idempotency test could not see it, because with every job failed the count
  // was already 0 and a stray decrement was clamped away.
  const rendersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-double-'));
  const today = new Date().toISOString().slice(0, 10);

  fs.mkdirSync(path.join(rendersDir, 'job_holder'), { recursive: true });
  fs.writeFileSync(path.join(rendersDir, 'job_holder', 'status.json'), JSON.stringify({
    jobId: 'job_holder', state: 'ready', stage: 'mastering-qa', progress: 1,
    updatedAt: new Date().toISOString(),
  }));

  fs.mkdirSync(path.join(rendersDir, 'job_ghost'), { recursive: true });
  fs.writeFileSync(path.join(rendersDir, 'job_ghost', 'status.json'), JSON.stringify({
    jobId: 'job_ghost', state: 'rendering', stage: 'voicing', progress: 0.3,
    updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  }));

  // Only job_holder holds a slot. job_ghost's was already returned.
  fs.writeFileSync(path.join(rendersDir, '.quota.json'),
    JSON.stringify({ day: today, count: 1, jobs: ['job_holder'] }));

  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), RENDERS_DIR: rendersDir,
      ACCESS_CODE: 'testcode', MAX_JOBS_PER_DAY: '6', ENGINE_PY: '/bin/false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await sleep(1500);
    const ghost = JSON.parse(
      fs.readFileSync(path.join(rendersDir, 'job_ghost', 'status.json'), 'utf8'));
    assert.strictEqual(ghost.state, 'failed', 'the sweep did not run; the test proves nothing');

    const q = JSON.parse(fs.readFileSync(path.join(rendersDir, '.quota.json'), 'utf8'));
    assert.strictEqual(q.count, 1,
      'a slot that had already been returned was returned again, taking one that ' +
      'another job is still holding');
    assert.deepStrictEqual(q.jobs, ['job_holder']);
  } finally {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    try { fs.rmSync(rendersDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('the stale sweep alone releases a job no exit handler ever saw', async () => {
  // A job left `rendering` by a restart: the process that spawned it is gone,
  // so nothing will ever fire an exit handler for it. Only the sweep can
  // return this slot.
  const rendersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-sweep-'));
  const id = 'job_orphaned';
  fs.mkdirSync(path.join(rendersDir, id), { recursive: true });
  fs.writeFileSync(path.join(rendersDir, id, 'status.json'), JSON.stringify({
    jobId: id, state: 'rendering', stage: 'voicing', progress: 0.4,
    updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  }));
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(rendersDir, '.quota.json'),
    JSON.stringify({ day: today, count: 1, jobs: [id] }));

  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), RENDERS_DIR: rendersDir,
      ACCESS_CODE: 'testcode', MAX_JOBS_PER_DAY: '6', ENGINE_PY: '/bin/false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const deadline = Date.now() + 4000;
    let q = null;
    while (Date.now() < deadline) {
      q = JSON.parse(fs.readFileSync(path.join(rendersDir, '.quota.json'), 'utf8'));
      if (q.count === 0) break;
      await sleep(50);
    }
    assert.strictEqual(q.count, 0,
      'a job orphaned by a restart never gets its slot back');
    assert.deepStrictEqual(q.jobs, []);
  } finally {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    try { fs.rmSync(rendersDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('a quota file whose count and ledger disagree cannot go negative', async () => {
  // Reachable from a torn write, or a file edited by hand on the server. A
  // negative count silently grants extra capacity for the rest of the day.
  const rendersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-neg-'));
  const id = 'job_mismatch';
  fs.mkdirSync(path.join(rendersDir, id), { recursive: true });
  fs.writeFileSync(path.join(rendersDir, id, 'status.json'), JSON.stringify({
    jobId: id, state: 'rendering', stage: 'voicing', progress: 0.4,
    updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  }));
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(rendersDir, '.quota.json'),
    JSON.stringify({ day: today, count: 0, jobs: [id] }));

  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), RENDERS_DIR: rendersDir,
      ACCESS_CODE: 'testcode', MAX_JOBS_PER_DAY: '6', ENGINE_PY: '/bin/false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await sleep(1500);
    const q = JSON.parse(fs.readFileSync(path.join(rendersDir, '.quota.json'), 'utf8'));
    assert.ok(q.count >= 0, `count went negative: ${q.count}`);
  } finally {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    try { fs.rmSync(rendersDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
