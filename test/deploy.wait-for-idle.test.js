// Tests for deploy/wait-for-idle.sh — the gate that decides whether a deploy may
// restart the service (issue #4).
//
// This logic lives in a script rather than inline in deploy.yml precisely so it
// can be tested: it has five branches, and inline workflow shell is the least
// testable place in the repo. Each case runs the real script against a stub
// health endpoint.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'deploy', 'wait-for-idle.sh');

/** A stub /api/health whose body is decided per-request by `bodyFor`. */
function stubHealth(bodyFor) {
  return new Promise((resolve) => {
    let n = 0;
    const at = [];
    const srv = http.createServer((req, res) => {
      at.push(Date.now());
      const body = bodyFor(n++);
      if (body === null) {
        res.writeHead(503);
        return res.end('down');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    });
    srv.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${srv.address().port}/api/health`,
        calls: () => n,
        /** Gaps between consecutive polls, in ms. */
        gaps: () => at.slice(1).map((t, i) => t - at[i]),
        close: () => srv.close(),
      }),
    );
  });
}

function run(url, timeout = 5, poll = 1) {
  return new Promise((resolve) => {
    execFile('bash', [SCRIPT, url, String(timeout), String(poll)], { timeout: 60000 },
      (err, stdout, stderr) =>
        resolve({ code: err ? err.code ?? 1 : 0, out: `${stdout}${stderr}` }),
    );
  });
}

test('proceeds immediately when the server reports it is idle', async () => {
  const s = await stubHealth(() => '{"ok":true,"rendering":false}');
  try {
    const r = await run(s.url);
    assert.strictEqual(r.code, 0, `should allow the restart:\n${r.out}`);
    assert.strictEqual(s.calls(), 1, 'should not poll again once it knows it is idle');
  } finally {
    s.close();
  }
});

test('proceeds when the field is absent — the bootstrap case', async () => {
  // The server running in production when this merges predates the `rendering`
  // field. Waiting for it to appear would hang this change's own first deploy
  // for the whole timeout and then fail it.
  const s = await stubHealth(() => '{"ok":true,"service":"hypnosis-studio"}');
  try {
    const r = await run(s.url);
    assert.strictEqual(r.code, 0, `an old server must not block the deploy:\n${r.out}`);
  } finally {
    s.close();
  }
});

test('proceeds when health is unreachable', async () => {
  // The service is already down; refusing to restart would strand it.
  const r = await run('http://127.0.0.1:1/api/health');
  assert.strictEqual(r.code, 0, `an unreachable endpoint must not block the deploy:\n${r.out}`);
});

test('proceeds when health returns a non-200', async () => {
  const s = await stubHealth(() => null); // 503
  try {
    const r = await run(s.url);
    assert.strictEqual(r.code, 0, `a 503 must not block the deploy:\n${r.out}`);
  } finally {
    s.close();
  }
});

test('waits while a render is in flight, then proceeds once it finishes', async () => {
  const s = await stubHealth((n) => (n < 2 ? '{"rendering":true}' : '{"rendering":false}'));
  try {
    const r = await run(s.url, 30, 1);
    assert.strictEqual(r.code, 0, `should proceed once the render completes:\n${r.out}`);
    assert.ok(s.calls() >= 3, `should have polled repeatedly, got ${s.calls()}`);

    // Measured from the stub's own request timestamps, not from total process
    // wall time. Wall time also covers execFile scheduling, bash startup and
    // curl, none of which are under test — and this file runs alongside others
    // under `node --test`, which schedules test files in parallel.
    //
    // This is the stricter assertion, not a relaxed one: it fails a script that
    // polls three times without sleeping, which a total-elapsed check would
    // wave through as long as something else was slow. Contention can only push
    // these gaps up.
    const gaps = s.gaps();
    assert.ok(gaps.length >= 2, `expected at least two intervals, got ${gaps.length}`);
    for (const gap of gaps) {
      assert.ok(gap >= 900,
        `polled again after only ${gap}ms — the script is spinning, not waiting on a ${1}s interval`);
    }
    assert.match(r.out, /render/i, 'should say why it is waiting');
  } finally {
    s.close();
  }
});

test('refuses to restart if a render is still running at the timeout', async () => {
  const s = await stubHealth(() => '{"rendering":true}');
  try {
    const r = await run(s.url, 3, 1);
    assert.notStrictEqual(r.code, 0, 'must fail the deploy rather than kill a paid render');
    assert.match(r.out, /still|timeout|refus/i, 'should report clearly why it stopped');
  } finally {
    s.close();
  }
});
