// Regression tests for issue #1 — unauthenticated request paths that killed the process.
//
// These spawn a REAL server as a child process rather than importing server.js, for two reasons:
// the defect under test IS process death, which an in-process test cannot observe; and server.js
// calls listen() at module load and exports nothing, so it has no importable surface.
//
// No mocking: real HTTP over a real socket, real files on disk.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const RENDERS = path.join(ROOT, 'renders');
const JOB_ID = 'job_test_issue1';

let child;
let PORT;

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

// Raw http.request so the literal path reaches the server unnormalized —
// fetch()/URL would re-encode or reject some of these before they hit the wire.
function req(rawPath, method = 'GET', port = PORT) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path: rawPath, method, timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('request timed out')));
    r.end();
  });
}

/** The server must still be answering. This is the real assertion in every test below. */
async function assertAlive() {
  assert.strictEqual(child.exitCode, null, `server process exited (code ${child.exitCode})`);
  const health = await req('/api/health');
  assert.strictEqual(health.status, 200, 'server stopped answering /api/health');
}

before(async () => {
  PORT = await freePort();

  // A "ready" job whose manifest lists a file that is not on disk — the statSync /
  // stream-error case. This state is inevitable once retention deletion exists (#3).
  const dir = path.join(RENDERS, JOB_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'status.json'),
    JSON.stringify({ jobId: JOB_ID, state: 'ready', updatedAt: new Date().toISOString() }),
  );
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ tracks: [{ n: 1, mp3: 'gone.mp3', wav: 'gone.wav' }] }),
  );

  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for the listener rather than sleeping a fixed amount.
  const deadline = Date.now() + 10000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
    try {
      const r = await req('/api/health');
      if (r.status === 200) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error('server did not start within 10s');
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(() => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  fs.rmSync(path.join(RENDERS, JOB_ID), { recursive: true, force: true });
});

// ── Malformed percent-encoding ───────────────────────────────────────────────
// %80 is SYNTACTICALLY valid percent-encoding (just not valid UTF-8), so nginx
// forwards it untouched — unlike a bare '%'. decodeURIComponent throws URIError.
for (const bad of ['/%80', '/%e0%80', '/%f0%9f', '/%c3%28']) {
  test(`malformed escape ${bad} returns 400 and the server survives`, async () => {
    const res = await req(bad);
    assert.strictEqual(res.status, 400, `${bad} should be a 400`);
    await assertAlive();
  });
}

// ── Null byte reaching fs.readFile ───────────────────────────────────────────
// decodeURIComponent('/%00') does NOT throw — it yields '/\0', which passes the
// DIST prefix check and then makes fs.readFile throw ERR_INVALID_ARG_VALUE
// *synchronously*, before any callback runs.
test('null byte in path is rejected and the server survives', async () => {
  const res = await req('/%00');
  assert.ok(
    res.status === 400 || res.status === 404,
    `expected 400 or 404 for a null byte, got ${res.status}`,
  );
  await assertAlive();
});

// ── Manifest-listed file missing from disk ───────────────────────────────────
test('missing manifest-listed file returns 404 and the server survives', async () => {
  const res = await req(`/api/jobs/${JOB_ID}/files/gone.mp3`);
  assert.strictEqual(res.status, 404, 'a deleted master should 404, not crash the process');
  await assertAlive();
});

test('HEAD for a missing manifest-listed file also survives', async () => {
  const res = await req(`/api/jobs/${JOB_ID}/files/gone.wav`, 'HEAD');
  assert.strictEqual(res.status, 404);
  await assertAlive();
});

// ── The generic backstop: an unexpected throw must become a 500, not an exit ──
// Reached with a corrupt manifest whose filename contains a newline. The file
// exists (so statSync passes) and the name clears basename + allow-list, but the
// newline makes res.writeHead throw ERR_INVALID_CHAR while building
// Content-Disposition. That is an unforeseen synchronous throw — exactly what the
// handler-level backstop is for. It doubles as a header-injection check.
test('an unexpected throw yields 500 and the server survives', async () => {
  const dir = path.join(RENDERS, JOB_ID);
  const evil = 'a\nb.mp3';
  fs.writeFileSync(path.join(dir, evil), 'x');
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ tracks: [{ n: 1, mp3: evil, wav: 'gone.wav' }] }),
  );

  const res = await req(`/api/jobs/${JOB_ID}/files/a%0Ab.mp3`);
  assert.strictEqual(res.status, 500, 'an unexpected throw should surface as 500');
  await assertAlive();

  // Restore the manifest the other tests rely on.
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ tracks: [{ n: 1, mp3: 'gone.mp3', wav: 'gone.wav' }] }),
  );
});

// ── A failing status write must not exit the process ─────────────────────────
// writeStatus() is called from the worker's error/exit handlers and from the
// boot/interval sweep — all async callbacks OUTSIDE the request promise chain,
// where a throw is an uncaughtException the request backstop never sees. A
// read-only job directory reproduces that deterministically: the boot sweep
// finds a stale "rendering" job and cannot write the failed status.
test('a failing status write does not kill the process', { skip: process.getuid && process.getuid() === 0 ? 'root ignores chmod' : false }, async () => {
  const id = 'job_test_readonly';
  const dir = path.join(RENDERS, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'status.json'),
    JSON.stringify({
      jobId: id,
      state: 'rendering',
      updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // stale
    }),
  );
  fs.chmodSync(dir, 0o500); // readable, not writable

  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const deadline = Date.now() + 10000;
    for (;;) {
      if (proc.exitCode !== null) {
        assert.fail(`server exited (${proc.exitCode}) because a status write failed`);
      }
      try {
        const r = await req('/api/health', 'GET', port);
        if (r.status === 200) break;
      } catch {
        /* not listening yet */
      }
      if (Date.now() > deadline) assert.fail('server did not start within 10s');
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.strictEqual(proc.exitCode, null, 'server must survive an unwritable job dir');
  } finally {
    if (proc.exitCode === null) proc.kill('SIGKILL');
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Paths that were already handled correctly — guard against regressions ────
test('traversal is still rejected and unknown paths still 404', async () => {
  const traversal = await req('/../../etc/passwd');
  assert.ok(traversal.status === 403 || traversal.status === 404, 'traversal must not be served');

  const unknownJob = await req('/api/jobs/job_does_not_exist');
  assert.strictEqual(unknownJob.status, 404);

  const unknownApi = await req('/api/nope');
  assert.strictEqual(unknownApi.status, 404);

  await assertAlive();
});
