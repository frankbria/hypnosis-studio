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
// Overridable for the same reason RENDERS_DIR is: the tests need a worker they
// control. Defaults to the engine venv the deploy creates.
const ENGINE_PY = process.env.ENGINE_PY || path.join(__dirname, 'engine', 'venv', 'bin', 'python');
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
    return true;
  } catch (e) {
    console.error('status write failed for', id, e && e.message);
    return false;
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

// `jobs` is the ledger of ids that currently hold a slot today. It is what
// makes releasing one idempotent: the worker-exit handler and the stale sweep
// can both declare the same job failed, and they genuinely race — a worker can
// exit at the moment the sweep decides it is stale.
//
// It also gets day-correctness for free. This function discards the file when
// `day` is not today, so yesterday's ids vanish with it and a job that fails
// after midnight cannot refund against today's allowance — which a bare
// `count -= 1` would happily do.
function readQuota() {
  const today = new Date().toISOString().slice(0, 10);
  const q = readJsonSafe(quotaPath());
  if (q && q.day === today && typeof q.count === 'number') {
    return { day: today, count: q.count, jobs: Array.isArray(q.jobs) ? q.jobs : [] };
  }
  return { day: today, count: 0, jobs: [] };
}

// Written the way writeStatus writes status.json. The file is now touched on
// both sides of every job, and a torn write would either reopen the day's
// allowance or close it for good.
function writeQuota(q) {
  const p = quotaPath();
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(q));
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    console.error('quota write failed:', e && e.message);
    return false;
  }
}

// Returns false if the slot could not be recorded. The caller must not start a
// worker then: before writeQuota existed this was a bare writeFileSync that
// threw and aborted the request, and quietly carrying on instead would let the
// day's cap be bypassed entirely — every render unrecorded, every one spending
// credits — on a full or unwritable renders volume.
function bumpQuota(id) {
  const q = readQuota();
  q.count += 1;
  q.jobs.push(id);
  return writeQuota(q);
}

// Give a slot back. Only a job still listed in today's ledger can return one,
// so a second call — from the other of the two failure paths, or from a sweep
// re-running — finds nothing and does nothing.
//
// A quota file written before this ledger existed has no `jobs`, so releases
// against it are no-ops: the cap still binds, and the day rolls over to a file
// that has the ledger.
function releaseQuota(id) {
  const q = readQuota();
  if (!q.jobs.includes(id)) return false;
  q.jobs = q.jobs.filter((j) => j !== id);
  q.count = Math.max(0, q.count - 1);
  // Report what actually landed. A swallowed write would otherwise log a
  // release that did not happen, and the slot stays spent for the day with the
  // log insisting otherwise.
  if (!writeQuota(q)) {
    console.error('quota slot for', id, 'could not be released (write failed)');
    return false;
  }
  console.log('released quota slot for failed job', id);
  return true;
}

// Every way a job can fail before it is even running writes the same status and
// returns the same slot. One place, so the two callers cannot drift.
function failToStart(id, detail, error) {
  writeStatus(id, {
    jobId: id, state: 'failed', stage: null, progress: 0,
    detail, error: String(error),
  });
  releaseQuota(id);
}

// Jobs with a worker process still running. The stale sweep decides a job is
// dead purely from how long ago status.json was touched, and the assembly stage
// writes status once per track — a single track can take longer than STALE_MS,
// so a perfectly healthy render looks stale. Refunding its slot would let the
// day's cap be exceeded, and every over-cap render spends real credits.
//
// (The sweep also *marks that job failed*, which frees the concurrency lock
// under a live worker. That is issue #11 and is not fixed here; this map exists
// so the money half cannot be made worse in the meantime.)
const liveWorkers = new Map();  // jobId -> ChildProcess

// How long a render may run before it is reclaimed regardless of liveness.
// Liveness alone never recovers a worker wedged forever on a socket, so this is
// the backstop — and the only path that kills a process.
//
// A full 4-track render is 15-20 minutes, and a single TTS stall can add ~17
// (4 attempts x a 120 s timeout, plus 5+15+30 s of backoff, and again through
// the fallback settings on a 422). 45 minutes clears both without being so far
// out that a wedged job holds the service for an hour.
const HARD_TIMEOUT_MS = (() => {
  const n = parseInt(process.env.HARD_TIMEOUT_MS || '2700000', 10);
  return Number.isFinite(n) && n > 0 ? n : 45 * 60 * 1000;
})();

function pidPath(id) {
  return path.join(jobDir(id), 'worker.json');
}

// A pid on its own is not an identity. Pids are reused, and the reuse case is
// not hypothetical here: an OOM-kill reboot resets the pid namespace, so a
// stale low-numbered worker pid from the previous boot names whatever early
// daemon claimed it on this one. That would make a finished job read as alive
// forever (the service answers 409 until the ceiling) and, past the ceiling,
// send SIGTERM/SIGKILL to an innocent process.
//
// /proc/<pid>/stat field 22 is the process start time in clock ticks since
// boot, which is stable for the life of a process and cannot be inherited by a
// reused pid. `comm` may contain spaces and parentheses, hence the rindex.
function procStartTime(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    const t = after[19];
    return t === undefined ? null : t;
  } catch {
    return null;
  }
}

// Recorded on disk as well as in liveWorkers, because a job can outlive the
// server process that started it — after a crash the in-memory set is empty
// while the child may still be running. A sidecar rather than a status.json
// field, because the Python worker rewrites that file wholesale on every
// transition and would erase it.
function recordWorker(id, pid) {
  try {
    fs.writeFileSync(pidPath(id), JSON.stringify({
      pid,
      procStart: procStartTime(pid),
      // When the job began, for the hard ceiling. status.json's updatedAt
      // measures *silence*, which a chatty worker resets forever — so it cannot
      // bound how long a render has actually been running.
      spawnedAt: Date.now(),
    }));
  } catch (e) {
    console.error('could not record worker identity for', id, e && e.message);
  }
}

function readWorkerRecord(id) {
  const rec = readJsonSafe(pidPath(id));
  if (!rec || !Number.isFinite(rec.pid) || rec.pid <= 0) return null;
  return rec;
}

// Is the recorded pid still the process we started, rather than a reused one?
// `unknown` when we cannot tell — the callers treat that differently, because
// the safe answer is not the same for "may I reclaim this" and "may I kill it".
function recordedWorkerState(id) {
  const rec = readWorkerRecord(id);
  if (!rec) return { state: 'gone' };
  let alive;
  try {
    process.kill(rec.pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  if (!alive) return { state: 'gone' };
  const now = procStartTime(rec.pid);
  if (rec.procStart === null || now === null) return { state: 'unknown', rec };
  return now === rec.procStart ? { state: 'ours', rec } : { state: 'gone' };
}

// Is this job's worker still running?
//
// liveWorkers is exact for jobs this process started — the child is ours and we
// hold the handle, so there is no pid-reuse ambiguity. The pid file is the
// fallback for jobs orphaned across a restart. A job with no pid recorded reads
// as dead, so it stays reclaimable rather than blocking the service forever.
function workerAlive(id) {
  if (liveWorkers.has(id)) return true;          // exact: the child is ours
  const { state } = recordedWorkerState(id);
  // `unknown` counts as alive. Getting this wrong in the other direction
  // reintroduces #11 itself — declaring a running worker dead and letting a
  // second mixer start beside it.
  return state === 'ours' || state === 'unknown';
}

function startWorker(id, goal, voiceSet) {
  // The whole body is guarded, not just the spawn. bumpQuota() has already run
  // by the time we get here, so anything that throws on the way to a live
  // child leaks a slot for the rest of the day — and opening worker.log can
  // genuinely throw, e.g. if the retention sweep removes the directory in
  // between. That is the same leak this issue exists to close.
  let logFd;
  try {
    logFd = fs.openSync(path.join(jobDir(id), 'worker.log'), 'a');
  } catch (e) {
    failToStart(id, 'could not open worker log', e);
    return;
  }
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
    failToStart(id, 'worker spawn failed', e);
    return;
  }
  fs.closeSync(logFd); // child holds its own copy of the fd
  liveWorkers.set(id, child);
  if (child.pid) recordWorker(id, child.pid);
  child.on('error', (e) => {
    liveWorkers.delete(id);
    failToStart(id, 'worker spawn failed', e);
  });
  child.on('exit', () => {
    liveWorkers.delete(id);
    const st = readJsonSafe(path.join(jobDir(id), 'status.json'));
    if (!st || (st.state !== 'ready' && st.state !== 'failed')) {
      writeStatus(id, {
        jobId: id, state: 'failed', stage: st ? st.stage : null,
        progress: st ? st.progress : 0,
        detail: 'worker crashed', error: 'worker crashed',
      });
    }
    // The customer has nothing either way, so a crash and a clean failure are
    // not worth charging differently for. A `ready` job keeps its slot.
    if (!st || st.state !== 'ready') releaseQuota(id);
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
    if (!bumpQuota(jobId)) {
      // No spend. A render whose slot was never recorded is one the cap cannot
      // see, and the volume that could not take 80 bytes of JSON is not going
      // to hold ~500 MB of audio either.
      writeStatus(jobId, {
        jobId, state: 'failed', stage: null, progress: 0,
        detail: 'could not record the render against the daily quota',
        error: 'quota storage unavailable',
      });
      return sendJson(res, 503, { error: 'storage_unavailable' });
    }
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
// Reclaim jobs whose worker is gone, and only those.
//
// This used to declare a job dead purely from how long ago status.json was
// touched, with STALE_MS at 2 minutes. A single segment can legitimately go
// quiet far longer than that — the retry budget alone is ~8.8 minutes, ~17.7
// through the fallback settings — and assembly writes status once per track. So
// the sweep fired on healthy renders, marked them `failed` WITHOUT killing the
// child, and anyJobRendering() then reported nothing in flight: a second POST
// was accepted and two NumPy mixers ran on a 4 GB box.
//
// Liveness rather than a bigger timeout, because a timeout tuned to the current
// retry budget silently goes wrong the next time that budget changes — which is
// exactly what #7 did to the 2-minute one.
function sweepStaleJobs() {
  let dirs;
  try { dirs = fs.readdirSync(RENDERS, { withFileTypes: true }); } catch { return; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const p = path.join(RENDERS, d.name, 'status.json');
    const st = readJsonSafe(p);
    if (!st || st.state !== 'rendering') continue;

    const alive = workerAlive(d.name);
    const age = jobAgeMs(d.name, st);

    if (alive) {
      // "I cannot tell how old this is" must never reach the kill path. Killing
      // is the one irreversible thing here, and a missing or unparseable
      // timestamp used to mean only "mark stale" — now it would destroy a
      // healthy, paid-for render.
      if (age === null || !Number.isFinite(age)) {
        console.warn('cannot determine age for', d.name, '- leaving it alone');
        continue;
      }
      if (age <= HARD_TIMEOUT_MS) continue;   // working, however quietly

      // Past the ceiling and still running: the only path that kills.
      if (!killWorker(d.name)) {
        // Could not stop it. Marking the job failed here would free the
        // concurrency lock and let a second mixer start beside a live one,
        // which is precisely the bug this issue is about.
        console.error('job', d.name, 'is past the hard timeout but its worker could not '
          + 'be stopped - leaving it `rendering` rather than freeing the lock');
        continue;
      }
      if (!writeStatus(d.name, {
        ...st, state: 'failed',
        error: 'the render ran too long and was stopped — please start a new one',
      })) continue;   // see below
      console.warn('swept job past the hard timeout:', d.name, `(${Math.round(age / 60000)} min)`);
    } else if (!writeStatus(d.name, {
      ...st, state: 'failed',
      error: 'service restarted during render — please start a new one',
    })) {
      // The slot is only returned once the job is genuinely recorded as failed.
      // Releasing against a status that still says `rendering` would raise the
      // day's cap while the service stays busy on a job nobody can finish.
      continue;
    } else {
      console.log('swept stale job', d.name);
    }
    releaseQuota(d.name);
  }
}

// SIGTERM, then SIGKILL if it is still there. Never throws: this runs in a timer
// callback, where a throw is an uncaughtException rather than something the
// request backstop can catch.
// Stop a worker. Returns false if we could not — which the caller must respect,
// because marking the job `failed` frees the concurrency lock and a second
// render would then start beside a worker that is still going: #11 all over
// again.
//
// Never throws: this runs in a timer callback, where a throw is an
// uncaughtException rather than something the request backstop can catch.
function killWorker(id) {
  const child = liveWorkers.get(id);
  if (child) {
    // Ours, in this process. No pid lookup and so no reuse risk at all.
    try {
      child.kill('SIGTERM');
    } catch {
      return false;
    }
    setTimeout(() => {
      // `child.killed` means "a signal was delivered", not "the process died" —
      // it is true the instant kill() returns, so gating on it made this
      // escalation dead code and a SIGTERM-resistant worker survived the only
      // path that is supposed to be able to stop it. exitCode/signalCode stay
      // null until the child actually exits, which is the question being asked.
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill('SIGKILL');
        console.warn('worker for', id, 'ignored SIGTERM; killed');
      } catch { /* exited in between */ }
    }, 1000).unref();
    return true;
  }

  const { state, rec } = recordedWorkerState(id);
  if (state === 'gone') return true;      // nothing to stop
  if (state !== 'ours') {
    // Cannot prove this pid is still our worker rather than a process that
    // inherited the number. Signalling it could kill something unrelated.
    console.error('refusing to signal pid for', id, '- cannot confirm it is our worker');
    return false;
  }
  const { pid, procStart } = rec;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return true; // exited between the check and the signal
  }
  setTimeout(() => {
    // Re-verify before escalating: the worker can exit inside this second and
    // the pid be reused, and SIGKILL against the new owner is exactly the harm
    // the identity check exists to prevent.
    if (procStartTime(pid) !== procStart) return;
    try {
      process.kill(pid, 'SIGKILL');
      console.warn('worker', pid, 'ignored SIGTERM; killed');
    } catch { /* exited on SIGTERM, the normal case */ }
  }, 1000).unref();
  return true;
}

// How long this job has actually been running. Falls back to time-since-last-
// status-write only when there is no spawn record, e.g. a job from before this
// change. Returns null when it cannot be determined at all.
function jobAgeMs(id, st) {
  const rec = readWorkerRecord(id);
  if (rec && Number.isFinite(rec.spawnedAt)) return Date.now() - rec.spawnedAt;
  const t = new Date(st.updatedAt || 0).getTime();
  return Number.isFinite(t) && t > 0 ? Date.now() - t : null;
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
// Overridable for the same reason RENDERS_DIR and ENGINE_PY are: a 60 s tick is
// right in production and untestable in a unit test, and the sweep's behaviour
// against a live worker is exactly what needs pinning.
const SWEEP_MS = (() => {
  const n = parseInt(process.env.SWEEP_INTERVAL_MS || '60000', 10);
  return Number.isFinite(n) && n > 0 ? n : 60 * 1000;
})();

sweepJobs();
setInterval(sweepJobs, SWEEP_MS).unref();

server.listen(PORT, '127.0.0.1', () => console.log('hypnosis-studio on 127.0.0.1:' + PORT));
