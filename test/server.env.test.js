// The server must actually read a .env file (#18 follow-up).
//
// Nothing did this before. An operator putting ELEVENLABS_API_KEY in .env would
// see the server start cleanly and the first render fail at the TTS step, with
// the key sitting unread on disk. The failure is far from the cause.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

/**
 * Source with comments removed.
 *
 * Without this, every assertion below matches the comment block ABOVE the call
 * rather than the call: `indexOf('process.loadEnvFile')` finds the line
 * explaining it, and "Load .env before anything reads process.env" makes the
 * ordering check compare a comment against a comment.
 *
 * Sixth time this repo has been bitten by a check matching prose instead of
 * code. The Python suite has a `code_only` fixture and the web claims tests have
 * `codeOnly` for exactly this; this file needed its own and did not have one.
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

test('server.js loads .env before reading any variable from it', () => {
  const src = codeOnly(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'));
  const load = src.indexOf('process.loadEnvFile');
  assert.ok(load > 0, 'server.js never loads a .env file');

  // Order matters: a load that happens after the constants are computed reads
  // the file and changes nothing.
  const firstEnvRead = src.indexOf('process.env.');
  assert.ok(load < firstEnvRead,
    'the .env is loaded after process.env is first read — the values arrive too late');

  // Resolved against the script, not the working directory: systemd sets
  // WorkingDirectory and a relative lookup would silently find nothing.
  const call = src.slice(load, src.indexOf(')', load) + 1);
  assert.match(call, /__dirname/,
    '.env is resolved against the cwd rather than the server directory');
});

test('a missing .env is not an error', () => {
  // Production has no .env — systemd supplies the environment. Crashing there
  // would be a self-inflicted outage.
  const src = codeOnly(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'));
  const at = src.indexOf('process.loadEnvFile');
  const region = src.slice(Math.max(0, at - 200), at + 400);
  assert.match(region, /try\s*\{/, 'loadEnvFile is not guarded');
  assert.match(region, /ENOENT/,
    'a missing .env is not distinguished from a real read failure');
});

test('.env supplies values, and the real environment beats it', () => {
  // Behavioural, not structural: run node the way the server does and check
  // both directions. The precedence matters — a stale .env in a deploy
  // directory must not override what systemd sets.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envtest-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'FROM_FILE=file\nBOTH=file\n');
    const probe = path.join(dir, 'probe.js');
    fs.writeFileSync(probe,
      'try { process.loadEnvFile(require("path").join(__dirname, ".env")) } catch {}\n' +
      'console.log(JSON.stringify({ f: process.env.FROM_FILE, b: process.env.BOTH }))\n');

    const plain = JSON.parse(execFileSync('node', [probe], { encoding: 'utf8' }));
    assert.strictEqual(plain.f, 'file', '.env value did not reach the process');
    assert.strictEqual(plain.b, 'file', '.env value did not reach the process');

    const overridden = JSON.parse(execFileSync('node', [probe],
      { encoding: 'utf8', env: { ...process.env, BOTH: 'real' } }));
    assert.strictEqual(overridden.b, 'real',
      'a stale .env overrode the real environment — systemd must win');
    assert.strictEqual(overridden.f, 'file',
      'the .env stopped supplying values it alone defines');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
