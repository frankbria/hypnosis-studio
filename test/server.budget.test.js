// Monthly character budget (issue #56).
//
// The throttle protecting spend was daily; the constraint it protects is
// monthly. MAX_JOBS_PER_DAY=6 permits ~180 programs a month, far beyond any
// plan allocation below Business — so the cap did not bound spend, it spread it
// out, and a busy first week exhausted the month with every later render failing
// *after* payment.
//
// The assertions that matter are about refusing before spend, and about the
// budget metering what is actually billed rather than an assumed average.
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

/** An engine that reports success without spending anything. */
function makeEngine() {
  const p = path.join(os.tmpdir(), `budget-engine-${process.pid}-${Date.now()}.sh`);
  fs.writeFileSync(p, `#!/bin/sh
outdir=""
while [ $# -gt 0 ]; do
  case "$1" in --outdir) outdir="$2"; shift 2;; *) shift;; esac
done
printf '{"jobId":"x","state":"ready","stage":"mastering-qa","progress":1,"detail":"done","updatedAt":"%s"}' \\
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$outdir/status.json"
exit 0
`, { mode: 0o755 });
  return p;
}

async function startServer({ budget = '500000', enginePy, rendersDir, env = {} } = {}) {
  const dir = rendersDir || fs.mkdtempSync(path.join(os.tmpdir(), 'budget-'));
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), RENDERS_DIR: dir,
      ACCESS_CODE: 'testcode', MAX_JOBS_PER_DAY: '100',
      MONTHLY_CHAR_BUDGET: budget,
      ENGINE_PY: enginePy || '/bin/false',
      SWEEP_INTERVAL_MS: '60000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await sleep(1300);
  return { proc, port, rendersDir: dir };
}

function stop({ proc, rendersDir }) {
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  try { fs.rmSync(rendersDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function readBudgetFile(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '.budget.json'), 'utf8')); }
  catch { return null; }
}

async function health(port) {
  const r = await request(port, 'GET', '/api/health');
  return JSON.parse(r.body);
}

const START = (goal = 'river') => ({ accessCode: 'testcode', goal, voiceSet: 'male' });

/** The real cost of a goal, computed the way the server does. */
function goalChars(goal) {
  let total = 0;
  for (const suffix of ['', '_track2', '_track3', '_track4']) {
    const p = path.join(ROOT, 'engine', 'scripts', `${goal}${suffix}_tts_segments.json`);
    for (const seg of JSON.parse(fs.readFileSync(p, 'utf8')).segments) {
      total += (seg.phase === 'suggestion' ? '[whispering] ' : '[soft] ').length
        + String(seg.text || '').length;
    }
  }
  return total;
}

// --------------------------------------------------------------------------
// The budget is measured in what is actually billed
// --------------------------------------------------------------------------

test('a render is charged its goal real character count', async () => {
  const engine = makeEngine();
  const srv = await startServer({ enginePy: engine });
  try {
    await request(srv.port, 'POST', '/api/programs', START('river'));
    await sleep(900);
    const b = readBudgetFile(srv.rendersDir);
    assert.strictEqual(b.chars, goalChars('river'),
      'the budget must meter what ElevenLabs will bill, not an average');
  } finally {
    stop(srv);
    try { fs.unlinkSync(engine); } catch { /* best effort */ }
  }
});

test('goals cost different amounts', async () => {
  // The point of using real script lengths: river is ~31% dearer than open_gate,
  // so a per-job average would badly misprice a month of either.
  assert.ok(goalChars('river') > goalChars('open_gate') * 1.25,
    'the goals are close enough in size that an average would have been fine — '
    + 'if that becomes true, this issue premise needs revisiting');
});

// --------------------------------------------------------------------------
// Refused before spend
// --------------------------------------------------------------------------

test('a render that would exceed the month is refused before anything is spent', async () => {
  // A budget big enough for one river but not two.
  const srv = await startServer({ budget: String(Math.floor(goalChars('river') * 1.5)),
    enginePy: makeEngine() });
  try {
    const first = await request(srv.port, 'POST', '/api/programs', START('river'));
    assert.strictEqual(first.status, 202);
    await sleep(900);

    const second = await request(srv.port, 'POST', '/api/programs', START('river'));
    assert.strictEqual(second.status, 503, 'the second render should be refused');
    assert.match(second.body, /budget_exhausted/);
    assert.match(second.body, /temporarily unavailable/i);

    // And nothing was created for it.
    const dirs = fs.readdirSync(srv.rendersDir).filter((n) => n.startsWith('job_'));
    assert.strictEqual(dirs.length, 1, 'a job directory was created for a refused render');
  } finally {
    stop(srv);
  }
});

test('a cheaper goal is still allowed when a dearer one is not', async () => {
  // The budget is checked against the specific goal, not a worst case — so a
  // near-empty month still sells what it can afford.
  const remaining = goalChars('open_gate') + 100;
  const srv = await startServer({ budget: String(remaining), enginePy: makeEngine() });
  try {
    const dear = await request(srv.port, 'POST', '/api/programs', START('river'));
    assert.strictEqual(dear.status, 503, 'river costs more than the budget allows');

    const cheap = await request(srv.port, 'POST', '/api/programs', START('open_gate'));
    assert.strictEqual(cheap.status, 202, 'open_gate fits and should have been accepted');
  } finally {
    stop(srv);
  }
});

test('the refusal is a 503, distinct from the daily cap 429', async () => {
  // They mean different things to a caller: 429 is "come back tomorrow", 503 is
  // "unavailable until the plan resets or is raised".
  const srv = await startServer({ budget: '1', enginePy: makeEngine() });
  try {
    const res = await request(srv.port, 'POST', '/api/programs', START('river'));
    assert.strictEqual(res.status, 503);
    assert.doesNotMatch(res.body, /daily_cap/);
  } finally {
    stop(srv);
  }
});

// --------------------------------------------------------------------------
// A failed render gives its characters back
// --------------------------------------------------------------------------

test('a failed render refunds its characters', async () => {
  const srv = await startServer({ enginePy: '/bin/false' });
  try {
    await request(srv.port, 'POST', '/api/programs', START('river'));
    const deadline = Date.now() + 5000;
    let b = null;
    while (Date.now() < deadline) {
      b = readBudgetFile(srv.rendersDir);
      if (b && b.chars === 0) break;
      await sleep(50);
    }
    assert.strictEqual(b.chars, 0, 'a render that produced nothing must not cost the month');
    assert.deepStrictEqual(b.jobs, {});
  } finally {
    stop(srv);
  }
});

test('a broken engine cannot drain the month', async () => {
  // The same shape as the daily-cap case in #10: a config error fails every job
  // in seconds. Without the refund it would spend the whole allowance producing
  // nothing.
  const srv = await startServer({ budget: String(goalChars('river') * 2), enginePy: '/bin/false' });
  try {
    for (let i = 0; i < 5; i += 1) {
      const res = await request(srv.port, 'POST', '/api/programs', START('river'));
      assert.strictEqual(res.status, 202, `request ${i + 1} refused: ${res.body}`);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const b = readBudgetFile(srv.rendersDir);
        if (b && b.chars === 0) break;
        await sleep(50);
      }
    }
    assert.strictEqual(readBudgetFile(srv.rendersDir).chars, 0);
  } finally {
    stop(srv);
  }
});

test('a successful render keeps its charge', async () => {
  const engine = makeEngine();
  const srv = await startServer({ enginePy: engine });
  try {
    await request(srv.port, 'POST', '/api/programs', START('river'));
    await sleep(1200);
    assert.strictEqual(readBudgetFile(srv.rendersDir).chars, goalChars('river'),
      'a completed render must still cost the month');
  } finally {
    stop(srv);
    try { fs.unlinkSync(engine); } catch { /* best effort */ }
  }
});

// --------------------------------------------------------------------------
// Visibility
// --------------------------------------------------------------------------

test('the remaining budget is visible on /api/health', async () => {
  const srv = await startServer({ budget: '500000', enginePy: makeEngine() });
  try {
    const before = await health(srv.port);
    assert.strictEqual(before.budget.charsBudget, 500000);
    assert.strictEqual(before.budget.charsRemaining, 500000);
    assert.ok(before.budget.programsLeft > 0);
    assert.match(before.budget.month, /^\d{4}-\d{2}$/);

    await request(srv.port, 'POST', '/api/programs', START('river'));
    await sleep(900);

    const after = await health(srv.port);
    assert.strictEqual(after.budget.charsUsed, goalChars('river'));
    assert.strictEqual(after.budget.charsRemaining, 500000 - goalChars('river'));
  } finally {
    stop(srv);
  }
});

test('programsLeft is measured against the dearest goal', async () => {
  // The number that cannot disappoint: reporting an optimistic count would tell
  // an operator they have renders left that the next request refuses.
  const srv = await startServer({ budget: String(goalChars('river') * 3), enginePy: makeEngine() });
  try {
    const h = await health(srv.port);
    assert.strictEqual(h.budget.programsLeft, 3);
  } finally {
    stop(srv);
  }
});

// --------------------------------------------------------------------------
// Month rollover and legacy files
// --------------------------------------------------------------------------

test('a budget file from another month is discarded', async () => {
  const rendersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-old-'));
  fs.writeFileSync(path.join(rendersDir, '.budget.json'), JSON.stringify({
    month: '2020-01', chars: 499999, jobs: { job_ancient: 499999 },
  }));
  const srv = await startServer({ budget: '500000', rendersDir, enginePy: makeEngine() });
  try {
    const h = await health(srv.port);
    assert.strictEqual(h.budget.charsRemaining, 500000,
      "last month's spend is still counted against this month");
  } finally {
    stop(srv);
  }
});

test('the daily cap still applies alongside the budget', async () => {
  // The issue allows the daily cap to remain as a burst control, and it should:
  // without it one day could drain the month.
  const srv = await startServer({
    budget: '500000', enginePy: makeEngine(), env: { MAX_JOBS_PER_DAY: '1' },
  });
  try {
    assert.strictEqual((await request(srv.port, 'POST', '/api/programs', START('river'))).status, 202);
    await sleep(900);
    const second = await request(srv.port, 'POST', '/api/programs', START('river'));
    assert.strictEqual(second.status, 429, 'the daily cap should still bind');
    assert.match(second.body, /daily_cap/);
  } finally {
    stop(srv);
  }
});

test('a double refund cannot take back characters another job is holding', async () => {
  // Same shape as the quota case in #10, and it needs staging for the same
  // reason: with every job refunded the total is already 0, so a stray second
  // refund is invisible. Here a completed job holds a charge.
  //
  // job_ghost is absent from the ledger (already refunded) but still sitting in
  // `rendering`, so the boot sweep will declare it failed and try to refund it
  // a second time.
  const rendersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-double-'));
  const month = new Date().toISOString().slice(0, 7);
  const held = goalChars('river');

  for (const [id, state] of [['job_holder', 'ready'], ['job_ghost', 'rendering']]) {
    fs.mkdirSync(path.join(rendersDir, id), { recursive: true });
    fs.writeFileSync(path.join(rendersDir, id, 'status.json'), JSON.stringify({
      jobId: id, state, stage: 'voicing', progress: state === 'ready' ? 1 : 0.3,
      updatedAt: state === 'ready'
        ? new Date().toISOString()
        : new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }));
  }
  fs.writeFileSync(path.join(rendersDir, '.budget.json'), JSON.stringify({
    month, chars: held, jobs: { job_holder: held },
  }));

  const srv = await startServer({ budget: '500000', rendersDir });
  try {
    await sleep(1500);
    const ghost = JSON.parse(fs.readFileSync(
      path.join(rendersDir, 'job_ghost', 'status.json'), 'utf8'));
    assert.strictEqual(ghost.state, 'failed',
      'the sweep never ran, so this proves nothing');

    const b = readBudgetFile(rendersDir);
    assert.strictEqual(b.chars, held,
      'characters already refunded were refunded again, taking back a charge '
      + 'another job is still holding');
    assert.deepStrictEqual(b.jobs, { job_holder: held });
  } finally {
    stop(srv);
  }
});
