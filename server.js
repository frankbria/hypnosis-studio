// Hypnosis Studio — static host + job API (zero-dependency Node).
// Serves the built frontend from web/dist and a JSON API under /api.
// The render pipeline lives in engine/ (Python); POST /api/programs spawns
// engine/render_program.py via the engine venv python and tracks progress
// through renders/<jobId>/status.json, written atomically by the worker.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 4100;
const DIST = path.join(__dirname, 'web', 'dist');
// Overridable so the renders root can be a mounted volume (see the container
// work) and so tests never point a retention window at a real renders/ dir.
//
// Resolved to absolute deliberately: jobDir() is handed to the worker as
// --outdir, and the worker runs abspath() against its OWN cwd (__dirname). A
// relative value would resolve differently on each side, so the worker would
// write where the server never looks — the render would appear to hang, then be
// swept as stale, discarding work the customer paid for.
const RENDERS = path.resolve(process.env.RENDERS_DIR || path.join(__dirname, 'renders'));
const ENGINE_PY = path.join(__dirname, 'engine', 'venv', 'bin', 'python');
const WORKER = path.join(__dirname, 'engine', 'render_program.py');

const ACCESS_CODE = process.env.ACCESS_CODE || '';
// Any value that is not a positive integer falls back to the documented default.
// A negative is the dangerous case: it is truthy, so `|| 30` never fires, and it
// puts the cutoff in the FUTURE — making every terminal job "expired", including
// one created seconds ago. Someone typing -1 to disable retention would delete
// every customer purchase on the next sweep.
//
// Falling back to 30 rather than clamping to 1: for a feature that destroys
// customer deliverables, nonsense configuration should land on the documented
// default, never on the most aggressive window the code can express.
const RETENTION_DAYS = (() => {
  const n = parseInt(process.env.RETENTION_DAYS || '30', 10);
  return Number.isInteger(n) && n > 0 ? n : 30;
})();
const RETENTION_DRY_RUN = process.env.RETENTION_DRY_RUN === '1';
const MAX_JOBS_PER_DAY = parseInt(process.env.MAX_JOBS_PER_DAY || '6', 10) || 6;

const VALID_GOALS = new Set(['polymath', 'golden_thread', 'inner_studio', 'open_gate', 'river']);
const VALID_VOICE_SETS = new Set(['male', 'female']);
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
// Stricter than SAFE_ID, and only used by the retention sweep. Every job id is
// minted as 'job_' + ... , so requiring the prefix means the sweep can never
// select a directory the job store did not create — SAFE_ID alone would happily
// match something like "backups".
const JOB_DIR_RE = /^job_[A-Za-z0-9_-]+$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, headers);
  res.end(body);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 64 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

// ---- job store (filesystem-backed; survives restarts) ----
fs.mkdirSync(RENDERS, { recursive: true });

function jobDir(id) {
  return path.join(RENDERS, id);
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Most callers run in async callbacks (worker error/exit handlers, the sweep
// timer) where a throw is an uncaughtException, not a rejection the request
// backstop can catch. A failed status write must never take the process down —
// the job is already in trouble; losing the server as well helps nobody.
function writeStatus(id, obj) {
  obj.updatedAt = new Date().toISOString();
  const p = path.join(jobDir(id), 'status.json');
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, p);
  } catch (e) {
    console.error('status write failed for', id, e && e.message);
  }
}

// Also read by /api/health, which the deploy gate polls — so it must not throw.
// "Cannot tell" reports false, matching the gate's fail-open stance: a deploy
// that hangs on every push forever is worse than the unlikely case of an
// unreadable renders dir during a live render.
function anyJobRendering() {
  let entries;
  try { entries = fs.readdirSync(RENDERS, { withFileTypes: true }); } catch { return false; }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const st = readJsonSafe(path.join(RENDERS, d.name, 'status.json'));
    if (st && st.state === 'rendering') return true;
  }
  return false;
}

function quotaPath() {
  return path.join(RENDERS, '.quota.json');
}

function readQuota() {
  const today = new Date().toISOString().slice(0, 10);
  const q = readJsonSafe(quotaPath());
  if (q && q.day === today && typeof q.count === 'number') return q;
  return { day: today, count: 0 };
}

function bumpQuota() {
  const q = readQuota();
  q.count += 1;
  fs.writeFileSync(quotaPath(), JSON.stringify(q));
}

function startWorker(id, goal, voiceSet) {
  const logFd = fs.openSync(path.join(jobDir(id), 'worker.log'), 'a');
  let child;
  try {
    child = spawn(ENGINE_PY, [
      WORKER,
      '--goal', goal,
      '--voice-set', voiceSet,
      '--job-id', id,
      '--outdir', jobDir(id),
    ], {
      cwd: __dirname,
      env: process.env,
      detached: false,
      stdio: ['ignore', logFd, logFd],
    });
  } catch (e) {
    fs.closeSync(logFd);
    writeStatus(id, {
      jobId: id, state: 'failed', stage: null, progress: 0,
      detail: 'worker spawn failed', error: String(e),
    });
    return;
  }
  fs.closeSync(logFd); // child holds its own copy of the fd
  child.on('error', (e) => {
    writeStatus(id, {
      jobId: id, state: 'failed', stage: null, progress: 0,
      detail: 'worker spawn failed', error: String(e),
    });
  });
  child.on('exit', () => {
    const st = readJsonSafe(path.join(jobDir(id), 'status.json'));
    if (!st || (st.state !== 'ready' && st.state !== 'failed')) {
      writeStatus(id, {
        jobId: id, state: 'failed', stage: st ? st.stage : null,
        progress: st ? st.progress : 0,
        detail: 'worker crashed', error: 'worker crashed',
      });
    }
  });
}

// ---- static serving ----
function serveStatic(req, res, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    // Syntactically valid but undecodable escapes (e.g. /%80) throw URIError.
    // nginx forwards these untouched, so they reach us verbatim.
    return send(res, 400, 'bad request');
  }
  if (rel === '/') rel = '/index.html';
  // A NUL survives decoding and makes fs.readFile throw synchronously.
  if (rel.includes('\0')) return send(res, 400, 'bad request');
  const filePath = path.normalize(path.join(DIST, rel));
  if (!filePath.startsWith(DIST)) return send(res, 403, 'forbidden');

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA fallback: unknown non-file paths get the app shell
      if (!path.extname(rel)) {
        return fs.readFile(path.join(DIST, 'index.html'), (e2, html) => {
          if (e2) return send(res, 404, 'not found');
          send(res, 200, html, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        });
      }
      return send(res, 404, 'not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (rel.startsWith('/assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    else if (rel.startsWith('/voices/')) headers['Cache-Control'] = 'public, max-age=3600';
    else headers['Cache-Control'] = 'no-cache';
    send(res, 200, buf, headers);
  });
}

async function handleRequest(req, res) {
  const url = req.url || '/';

  if (url === '/api/health') {
    // `rendering` is what the deploy gate waits on (deploy/wait-for-idle.sh) —
    // the same predicate the render endpoint uses to return 409 busy, so there
    // is one source of truth rather than a second implementation in shell.
    return sendJson(res, 200, {
      ok: true,
      service: 'hypnosis-studio',
      rendering: anyJobRendering(),
      time: new Date().toISOString(),
    });
  }

  if (url === '/api/programs' && req.method === 'POST') {
    if (!ACCESS_CODE) return sendJson(res, 503, { error: 'rendering_disabled' });
    const body = await readBody(req);
    if (body.accessCode !== ACCESS_CODE) return sendJson(res, 403, { error: 'bad_access_code' });
    if (!VALID_GOALS.has(body.goal)) return sendJson(res, 422, { error: 'goal_in_production' });
    if (!VALID_VOICE_SETS.has(body.voiceSet)) return sendJson(res, 422, { error: 'bad_voice_set' });
    if (anyJobRendering()) return sendJson(res, 409, { error: 'busy' });
    if (readQuota().count >= MAX_JOBS_PER_DAY) return sendJson(res, 429, { error: 'daily_cap' });

    const jobId = 'job_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
    fs.mkdirSync(jobDir(jobId), { recursive: true });
    writeStatus(jobId, {
      jobId, state: 'rendering', stage: 'scripting', progress: 0,
      detail: 'Queued',
    });
    bumpQuota();
    startWorker(jobId, body.goal, body.voiceSet);
    return sendJson(res, 202, { jobId, state: 'rendering' });
  }

  const filesMatch = url.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)\/files\/([^/?]+)$/);
  if (filesMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    const [, id, rawName] = filesMatch;
    let name;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      return sendJson(res, 400, { error: 'bad request' });
    }
    if (!SAFE_ID.test(id)) return sendJson(res, 400, { error: 'bad request' });
    if (path.basename(name) !== name) return sendJson(res, 400, { error: 'bad request' });
    const st = readJsonSafe(path.join(jobDir(id), 'status.json'));
    if (!st) return sendJson(res, 404, { error: 'unknown job' });
    if (st.state !== 'ready') return sendJson(res, 409, { error: 'not ready' });
    const manifest = readJsonSafe(path.join(jobDir(id), 'manifest.json'));
    // Multi-track manifests list every mastered file under tracks[]; tolerate
    // the legacy single-track {track:{mp3,wav}} shape without crashing.
    const allowed = manifest
      ? (Array.isArray(manifest.tracks) ? manifest.tracks : [manifest.track])
          .filter(Boolean)
          .flatMap((t) => [t.mp3, t.wav])
          .filter(Boolean)
      : [];
    if (!allowed.includes(name)) return sendJson(res, 404, { error: 'unknown file' });
    const filePath = path.join(jobDir(id), name);
    const ext = path.extname(name).toLowerCase();
    // The manifest can outlive the files it lists — retention sweeps delete job
    // dirs, so a listed master may simply be gone.
    let size;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return sendJson(res, 404, { error: 'unknown file' });
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Content-Length': size,
    });
    if (req.method === 'HEAD') return res.end();
    // Headers are already sent, so a mid-stream failure can only be abandoned.
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    res.on('error', () => stream.destroy()); // client aborted mid-download
    return stream.pipe(res);
  }

  const jobMatch = url.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)$/);
  if (jobMatch) {
    const id = jobMatch[1];
    const st = readJsonSafe(path.join(jobDir(id), 'status.json'));
    if (!st) return sendJson(res, 404, { error: 'unknown job' });
    const out = { ...st };
    if (st.state === 'ready') {
      const manifest = readJsonSafe(path.join(jobDir(id), 'manifest.json'));
      if (manifest) Object.assign(out, manifest);
    }
    return sendJson(res, 200, out);
  }

  if (url.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  serveStatic(req, res, url);
}

// An async handler's unhandled rejection exits the process, so every route needs
// a backstop. handleRequest is async, so synchronous throws surface here too.
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    console.error('request failed:', req.method, req.url, e && e.message);
    if (res.headersSent) return res.destroy();
    sendJson(res, 500, { error: 'internal error' });
  });
});

// On boot (and then every 60 s), fail any job whose status is stuck at
// "rendering" — e.g. the service was restarted mid-render (OOM kill on prod
// proved this path). updatedAt is refreshed by the worker at every stage, so
// a stale timestamp means the worker is gone.
function sweepStaleJobs() {
  const STALE_MS = 2 * 60 * 1000;
  let dirs;
  try { dirs = fs.readdirSync(RENDERS, { withFileTypes: true }); } catch { return; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const p = path.join(RENDERS, d.name, 'status.json');
    const st = readJsonSafe(p);
    if (!st || st.state !== 'rendering') continue;
    const age = Date.now() - new Date(st.updatedAt || 0).getTime();
    if (age > STALE_MS) {
      writeStatus(d.name, { ...st, state: 'failed', error: 'service restarted during render — please start a new one' });
      console.log('swept stale job', d.name);
    }
  }
}
// Reclaim finished jobs once they pass the retention window. This DELETES
// CUSTOMER PURCHASES, so it only removes what it can positively identify as an
// expired job and skips anything ambiguous — an orphaned directory costing a few
// KB forever is a far better outcome than one wrongly-reaped order.
function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSize(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch { /* raced; the byte count is only a log line */ }
  }
  return total;
}

function sweepExpiredJobs() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let entries;
  try { entries = fs.readdirSync(RENDERS, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    // Only real directories named like a job. Dirent.isDirectory() uses lstat
    // semantics, so it is already false for a symlink. (fs.rmSync on a symlink
    // removes the link and leaves the target intact — verified — so the risk
    // here is deleting a link we did not create, not destroying its target.)
    // JOB_DIR_RE then requires the 'job_' prefix the job store mints, so
    // nothing the server did not create can ever be selected.
    if (!e.isDirectory() || !JOB_DIR_RE.test(e.name)) continue;
    const dir = path.join(RENDERS, e.name);

    const st = readJsonSafe(path.join(dir, 'status.json'));
    if (!st) continue;                                        // orphan or corrupt — leave it
    if (st.state !== 'ready' && st.state !== 'failed') continue; // never touch an active job
    const updated = Date.parse(st.updatedAt);
    if (!Number.isFinite(updated) || updated >= cutoff) continue;

    const ageDays = ((Date.now() - updated) / (24 * 60 * 60 * 1000)).toFixed(1);
    const bytes = dirSize(dir);
    if (RETENTION_DRY_RUN) {
      console.log(`retention: would reap ${e.name} (${st.state}, ${ageDays}d, ${(bytes / 1e6).toFixed(0)} MB)`);
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`retention: reaped ${e.name} (${st.state}, ${ageDays}d, ${(bytes / 1e6).toFixed(0)} MB freed)`);
    } catch (err) {
      console.error(`retention: could not reap ${e.name}:`, err && err.message);
    }
  }
}

// Order matters: failing a stale job refreshes its updatedAt, so its retention
// clock starts from the terminal state rather than from when it hung.
function sweepJobs() {
  sweepStaleJobs();
  sweepExpiredJobs();
}
sweepJobs();
setInterval(sweepJobs, 60 * 1000).unref();

server.listen(PORT, '127.0.0.1', () => console.log('hypnosis-studio on 127.0.0.1:' + PORT));
