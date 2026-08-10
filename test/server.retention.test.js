// Retention sweep (issue #3). This feature DELETES CUSTOMER PURCHASES, so the
// tests below spend most of their effort on what must NOT be deleted.
//
// Each case gets its own renders root via RENDERS_DIR and its own server, so a
// test can never point an aggressive retention window at a developer's real
// renders/ directory.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DAY = 24 * 60 * 60 * 1000;

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

function get(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.end();
  });
}

/** A job directory with a controlled state and age. */
function makeJob(rendersDir, id, { state = 'ready', ageDays = 0, status = true, updatedAt } = {}) {
  const dir = path.join(rendersDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'polymath_track1.mp3'), Buffer.alloc(2048, 1));
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{"tracks":[]}');
  if (status) {
    const body = { jobId: id, state };
    if (updatedAt !== null) {
      body.updatedAt = updatedAt ?? new Date(Date.now() - ageDays * DAY).toISOString();
    }
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(body));
  }
  return dir;
}

/** Boot a server against an isolated renders root and wait for it to listen. */
async function boot(env = {}) {
  const rendersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-renders-'));
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), RENDERS_DIR: rendersDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (c) => (log += c));
  proc.stderr.on('data', (c) => (log += c));
  return {
    rendersDir,
    port,
    proc,
    logs: () => log,
    async ready() {
      const deadline = Date.now() + 10000;
      for (;;) {
        if (proc.exitCode !== null) throw new Error(`server exited (${proc.exitCode}): ${log}`);
        try {
          if ((await get(port, '/api/health')).status === 200) return;
        } catch {
          /* not listening yet */
        }
        if (Date.now() > deadline) throw new Error(`server did not start: ${log}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    stop() {
      if (proc.exitCode === null) proc.kill('SIGKILL');
      fs.rmSync(rendersDir, { recursive: true, force: true });
    },
  };
}

/** The sweep runs at boot, so fixtures must exist before the server starts. */
async function sweepWith(fixtures, env = {}) {
  const rendersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-renders-'));
  fixtures(rendersDir);
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), RENDERS_DIR: rendersDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (c) => (log += c));
  proc.stderr.on('data', (c) => (log += c));
  const deadline = Date.now() + 10000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`server exited (${proc.exitCode}): ${log}`);
    try {
      if ((await get(port, '/api/health')).status === 200) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start: ${log}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const exists = (id) => fs.existsSync(path.join(rendersDir, id));
  return {
    rendersDir,
    port,
    exists,
    log: () => log,
    cleanup() {
      if (proc.exitCode === null) proc.kill('SIGKILL');
      fs.rmSync(rendersDir, { recursive: true, force: true });
    },
  };
}

// ── The thing the issue asks for ─────────────────────────────────────────────

test('reaps terminal jobs older than the window, keeps recent ones', async () => {
  const s = await sweepWith((d) => {
    makeJob(d, 'job_old_ready', { state: 'ready', ageDays: 40 });
    makeJob(d, 'job_old_failed', { state: 'failed', ageDays: 40 });
    makeJob(d, 'job_new_ready', { state: 'ready', ageDays: 3 });
    makeJob(d, 'job_edge_recent', { state: 'ready', ageDays: 29 });
  });
  try {
    assert.strictEqual(s.exists('job_old_ready'), false, '40-day ready job should be reaped');
    assert.strictEqual(s.exists('job_old_failed'), false, '40-day failed job should be reaped');
    assert.strictEqual(s.exists('job_new_ready'), true, '3-day job must survive');
    assert.strictEqual(s.exists('job_edge_recent'), true, '29-day job is inside a 30-day window');
  } finally {
    s.cleanup();
  }
});

test('the window is configurable', async () => {
  const s = await sweepWith(
    (d) => {
      makeJob(d, 'job_two_days', { state: 'ready', ageDays: 2 });
      makeJob(d, 'job_hours', { state: 'ready', ageDays: 0 });
    },
    { RETENTION_DAYS: '1' },
  );
  try {
    assert.strictEqual(s.exists('job_two_days'), false, 'older than RETENTION_DAYS=1');
    assert.strictEqual(s.exists('job_hours'), true, 'inside RETENTION_DAYS=1');
  } finally {
    s.cleanup();
  }
});

test('logs an auditable line for every reap', async () => {
  const s = await sweepWith((d) => makeJob(d, 'job_audit_me', { state: 'ready', ageDays: 60 }));
  try {
    const log = s.log();
    assert.match(log, /job_audit_me/, 'the reaped job id must appear in the log');
    assert.match(log, /ready/, 'the state should be recorded');
    assert.match(log, /\d/, 'age/size should be recorded');
  } finally {
    s.cleanup();
  }
});

test('dry-run deletes nothing but still reports', async () => {
  const s = await sweepWith(
    (d) => makeJob(d, 'job_dry', { state: 'ready', ageDays: 90 }),
    { RETENTION_DRY_RUN: '1' },
  );
  try {
    assert.strictEqual(s.exists('job_dry'), true, 'dry-run must not delete');
    assert.match(s.log(), /job_dry/, 'dry-run must still report what it would reap');
  } finally {
    s.cleanup();
  }
});

// ── What must NEVER be deleted ───────────────────────────────────────────────

test('never reaps a job that is still rendering', async () => {
  const s = await sweepWith((d) =>
    makeJob(d, 'job_rendering_old', { state: 'rendering', ageDays: 40 }),
  );
  try {
    // sweepStaleJobs marks it failed (refreshing updatedAt), so it survives this
    // pass and its retention clock restarts from the terminal state. Asserting
    // this so nobody "optimises" the two sweeps into deleting it in one go.
    assert.strictEqual(s.exists('job_rendering_old'), true, 'an active job must never be deleted');
    const st = JSON.parse(
      fs.readFileSync(path.join(s.rendersDir, 'job_rendering_old', 'status.json'), 'utf8'),
    );
    assert.strictEqual(st.state, 'failed', 'the stale sweep should have failed it');
    assert.ok(Date.now() - new Date(st.updatedAt).getTime() < 60000, 'updatedAt should be refreshed');
  } finally {
    s.cleanup();
  }
});

test('never reaps a job in a state it does not recognise', async () => {
  // This is what actually exercises the terminal-state guard. The `rendering`
  // case above cannot: sweepStaleJobs fails it first and refreshes updatedAt,
  // so it is never expired regardless of the guard. An unrecognised state is
  // ignored by the stale sweep, so its old timestamp survives to the retention
  // pass — where only the state check stops it being deleted.
  const s = await sweepWith((d) => {
    makeJob(d, 'job_queued', { state: 'queued', ageDays: 90 });
    makeJob(d, 'job_paused', { state: 'paused', ageDays: 90 });
    makeJob(d, 'job_ready_ctl', { state: 'ready', ageDays: 90 });
  });
  try {
    assert.strictEqual(s.exists('job_queued'), true, 'an unknown state must not be reaped');
    assert.strictEqual(s.exists('job_paused'), true, 'an unknown state must not be reaped');
    assert.strictEqual(s.exists('job_ready_ctl'), false, 'control: a ready job of the same age is');
  } finally {
    s.cleanup();
  }
});

test('never reaps a non-job directory even if it holds a valid expired status', async () => {
  // Exercises the SAFE_ID guard. Files are skipped anyway (reading
  // status.json under a file path just fails), so only a *directory* with a
  // non-job name and a valid expired status.json can tell the guard apart.
  const s = await sweepWith((d) => {
    for (const name of ['.trash', 'backups', 'renders.bak']) {
      const dir = path.join(d, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dir + '/keep.wav', 'precious');
      fs.writeFileSync(
        path.join(dir, 'status.json'),
        JSON.stringify({
          state: 'ready',
          updatedAt: new Date(Date.now() - 90 * DAY).toISOString(),
        }),
      );
    }
    makeJob(d, 'job_ctl_old', { state: 'ready', ageDays: 90 });
  });
  try {
    for (const name of ['.trash', 'backups', 'renders.bak']) {
      assert.ok(
        fs.existsSync(path.join(s.rendersDir, name, 'keep.wav')),
        `${name} is not a job id and must never be reaped`,
      );
    }
    assert.strictEqual(s.exists('job_ctl_old'), false, 'control: a real expired job is reaped');
  } finally {
    s.cleanup();
  }
});

test('skips anything it cannot positively identify as an expired job', async () => {
  const s = await sweepWith((d) => {
    makeJob(d, 'job_no_status', { ageDays: 99, status: false });
    makeJob(d, 'job_no_updatedat', { state: 'ready', ageDays: 99, updatedAt: null });
    const bad = path.join(d, 'job_bad_status');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'status.json'), 'not json at all');
    makeJob(d, 'job_bad_time', { state: 'ready', updatedAt: 'not-a-timestamp' });
  });
  try {
    for (const id of ['job_no_status', 'job_no_updatedat', 'job_bad_status', 'job_bad_time']) {
      assert.strictEqual(s.exists(id), true, `${id} is ambiguous and must be left alone`);
    }
  } finally {
    s.cleanup();
  }
});

test('never touches files or non-job entries in the renders root', async () => {
  const s = await sweepWith((d) => {
    fs.writeFileSync(path.join(d, '.quota.json'), '{"day":"2020-01-01","count":3}');
    fs.writeFileSync(path.join(d, 'stray.txt'), 'not a job');
    makeJob(d, 'job_real_old', { state: 'ready', ageDays: 40 });
  });
  try {
    assert.ok(fs.existsSync(path.join(s.rendersDir, '.quota.json')), 'quota file must survive');
    assert.ok(fs.existsSync(path.join(s.rendersDir, 'stray.txt')), 'stray files must survive');
    assert.strictEqual(s.exists('job_real_old'), false, 'the real expired job is still reaped');
  } finally {
    s.cleanup();
  }
});

test('leaves a symlinked job directory alone entirely', async () => {
  // fs.rmSync on a symlink removes the link and leaves the target intact, so
  // the target surviving is not evidence the guard works. The link itself
  // surviving is — that is what Dirent.isDirectory() being false for symlinks
  // actually buys, and it is the assertion that fails if the check is dropped.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-precious-'));
  fs.writeFileSync(path.join(outside, 'keep.wav'), 'precious');
  fs.writeFileSync(
    path.join(outside, 'status.json'),
    JSON.stringify({ state: 'ready', updatedAt: new Date(Date.now() - 90 * DAY).toISOString() }),
  );
  let linkPath;
  const s = await sweepWith((d) => {
    linkPath = path.join(d, 'job_symlink');
    fs.symlinkSync(outside, linkPath);
  });
  try {
    assert.ok(fs.existsSync(path.join(outside, 'keep.wav')), 'the target must be untouched');
    assert.ok(
      fs.lstatSync(linkPath, { throwIfNoEntry: false }) !== undefined,
      'the symlink itself must not be removed — the sweep only owns real job dirs',
    );
  } finally {
    s.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// ── Behaviour after a reap ───────────────────────────────────────────────────

test('a reaped job 404s instead of crashing the server', async () => {
  const s = await sweepWith((d) => makeJob(d, 'job_gone_now', { state: 'ready', ageDays: 45 }));
  try {
    assert.strictEqual(s.exists('job_gone_now'), false);
    const status = await get(s.port, '/api/jobs/job_gone_now');
    assert.strictEqual(status.status, 404, 'status for a reaped job should be 404');
    const file = await get(s.port, '/api/jobs/job_gone_now/files/polymath_track1.mp3');
    assert.strictEqual(file.status, 404, 'files for a reaped job should be 404');
    assert.strictEqual((await get(s.port, '/api/health')).status, 200, 'server must still serve');
  } finally {
    s.cleanup();
  }
});

test('an unwritable renders root does not kill the process', async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root ignores chmod');
  const s = await boot();
  try {
    await s.ready();
    fs.chmodSync(s.rendersDir, 0o500);
    // Let the 60s timer's guard paths run at least once via a request cycle.
    assert.strictEqual((await get(s.port, '/api/health')).status, 200);
    assert.strictEqual(s.proc.exitCode, null, 'server must survive an unwritable renders root');
  } finally {
    try {
      fs.chmodSync(s.rendersDir, 0o700);
    } catch {
      /* already gone */
    }
    s.stop();
  }
});
