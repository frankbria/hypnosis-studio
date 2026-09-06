// Tests for deploy/cut-samples.sh — cutting the storefront samples on deploy (#60).
//
// One property carries this whole file: **the deploy must survive a failed
// cut.** A sample is a marketing asset with a designed fallback (the solo voice
// clips); the push it rides in with is not. If this script ever starts
// propagating a non-zero exit, `set -e` in deploy.yml turns a missing ffmpeg
// into a failed deploy of everything else — and it would be discovered during
// an incident rather than here.
//
// The cutter is stubbed rather than run for real: what is under test is the
// wrapper's behaviour around it, and the cutter has its own 48 tests.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'deploy', 'cut-samples.sh');

function run(engineDir, catalogDir, env = {}) {
  return new Promise((resolve) => {
    execFile('bash', [SCRIPT, engineDir, catalogDir],
      { env: { ...process.env, ...env }, timeout: 15000 },
      (err, stdout, stderr) => {
        resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}${stderr}` });
      });
  });
}

/**
 * A box: an engine directory with a stub cutter, and a catalog directory.
 *
 * `cutterBody` is the shell the stub runs, so a test can make the cut succeed,
 * fail, or record how it was called.
 */
function makeBox({ cutterBody = 'exit 0', withCatalog = true,
  withCutter = true, withPython = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutdep-'));
  const engineDir = path.join(dir, 'engine');
  const catalogDir = path.join(dir, 'renders', 'catalog');
  fs.mkdirSync(engineDir, { recursive: true });
  if (withCatalog) fs.mkdirSync(catalogDir, { recursive: true });
  if (withCutter) fs.writeFileSync(path.join(engineDir, 'cut_samples.py'), '');

  const python = path.join(dir, 'python');
  const calls = path.join(dir, 'calls.txt');
  if (withPython) {
    fs.writeFileSync(python, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\n${cutterBody}\n`,
      { mode: 0o755 });
  }
  return {
    dir,
    engineDir,
    catalogDir,
    env: { HYPNO_PYTHON: python },
    calls: () => { try { return fs.readFileSync(calls, 'utf8'); } catch { return ''; } },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// The property that matters
// ---------------------------------------------------------------------------

test('a failed cut does not fail the deploy', async () => {
  const box = makeBox({ cutterBody: 'echo "polymath__male: ffmpeg is not installed" >&2\nexit 1' });
  try {
    const r = await run(box.engineDir, box.catalogDir, box.env);
    assert.strictEqual(r.code, 0,
      `a failed cut propagated exit ${r.code}; with set -e in deploy.yml that is `
      + `a failed deploy of everything else in the push:\n${r.out}`);
  } finally { box.cleanup(); }
});

test('a failed cut still says so, and names the likely cause', async () => {
  // Exiting 0 silently would be worse than failing: nobody would ever learn the
  // box is missing ffmpeg, and the storefront would quietly stay on voice clips.
  const box = makeBox({ cutterBody: 'echo "polymath__male: ffmpeg is not installed"\nexit 1' });
  try {
    const r = await run(box.engineDir, box.catalogDir, box.env);
    assert.match(r.out, /ffmpeg is not installed/, 'the cutter output was swallowed');
    assert.match(r.out, /samples: cut incomplete/, 'no summary line for the deploy log');
    assert.match(r.out, /voice clips/, 'does not say what the site falls back to');
  } finally { box.cleanup(); }
});

test('a cut that dies on a signal does not fail the deploy either', async () => {
  // A full disk or an OOM kill is the realistic version of this, and it exits
  // 137 rather than 1.
  const box = makeBox({ cutterBody: 'kill -9 $$' });
  try {
    assert.strictEqual((await run(box.engineDir, box.catalogDir, box.env)).code, 0);
  } finally { box.cleanup(); }
});

// ---------------------------------------------------------------------------
// What it actually asks the cutter to do
// ---------------------------------------------------------------------------

test('the cutter is pointed at the catalog it was given', async () => {
  const box = makeBox();
  try {
    await run(box.engineDir, box.catalogDir, box.env);
    assert.match(box.calls(), new RegExp(`--catalog-dir ${box.catalogDir}(\\s|$)`),
      `the cutter was called as: ${box.calls()}`);
  } finally { box.cleanup(); }
});

test('the cutter runs from the engine directory it was given', async () => {
  // cut_samples.py resolves its own manifest relative to itself, so it must be
  // the copy this deploy just landed — not one from somewhere else on the box.
  const box = makeBox();
  try {
    await run(box.engineDir, box.catalogDir, box.env);
    assert.match(box.calls(), new RegExp(path.join(box.engineDir, 'cut_samples.py')));
  } finally { box.cleanup(); }
});

test('a successful cut exits 0', async () => {
  const box = makeBox({ cutterBody: 'echo "samples: 2 program(s) ready"\nexit 0' });
  try {
    const r = await run(box.engineDir, box.catalogDir, box.env);
    assert.strictEqual(r.code, 0);
    assert.doesNotMatch(r.out, /cut incomplete/, 'a clean run reported a failure');
  } finally { box.cleanup(); }
});

// ---------------------------------------------------------------------------
// Boxes that are not ready yet — normal, not errors
// ---------------------------------------------------------------------------

test('a box with no catalog yet is not an error and runs nothing', async () => {
  // Every box is in this state until the first pre-render. A deploy that
  // shouted about it would shout on every push for weeks.
  const box = makeBox({ withCatalog: false });
  try {
    const r = await run(box.engineDir, box.catalogDir, box.env);
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /nothing to cut/);
    assert.strictEqual(box.calls(), '', 'the cutter ran against a catalog that is not there');
  } finally { box.cleanup(); }
});

test('a missing interpreter is reported, not a stack trace', async () => {
  const box = makeBox({ withPython: false });
  try {
    const r = await run(box.engineDir, box.catalogDir, box.env);
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /no interpreter/);
  } finally { box.cleanup(); }
});

test('a missing cutter is reported, not a stack trace', async () => {
  // An older engine/ on the box, or a partial scp.
  const box = makeBox({ withCutter: false });
  try {
    const r = await run(box.engineDir, box.catalogDir, box.env);
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /is missing/);
    assert.strictEqual(box.calls(), '');
  } finally { box.cleanup(); }
});

// ---------------------------------------------------------------------------
// How deploy.yml wires it — the two orderings that matter
// ---------------------------------------------------------------------------

test('the deploy cuts samples after the idle gate and before the restart', () => {
  // Textual, because the workflow is YAML rather than something runnable here.
  // Both orderings are load-bearing and both fail silently if reversed: cutting
  // before the idle gate puts ffmpeg alongside a live paid render, and cutting
  // after the restart means the samples are not indexed until the NEXT deploy,
  // because server.js scans for them at boot.
  const yml = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'deploy.yml'), 'utf8');
  const idle = yml.indexOf('wait-for-idle.sh');
  const cut = yml.indexOf('cut-samples.sh');
  const restart = yml.indexOf('systemctl restart');
  assert.ok(idle >= 0 && cut >= 0 && restart >= 0,
    'deploy.yml no longer has all three steps');
  assert.ok(idle < cut, 'samples are cut before the idle gate — ffmpeg would race a render');
  assert.ok(cut < restart, 'samples are cut after the restart — they would not be indexed');
});

test('the deploy smoke-tests the samples endpoint', () => {
  const yml = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'deploy.yml'), 'utf8');
  assert.match(yml, /\/api\/samples/,
    'nothing checks that the route the storefront depends on answers after a deploy');
});
