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
const RENDERS = path.join(__dirname, 'renders');
const ENGINE_PY = path.join(__dirname, 'engine', 'venv', 'bin', 'python');
const WORKER = path.join(__dirname, 'engine', 'render_program.py');

const ACCESS_CODE = process.env.ACCESS_CODE || '';
const MAX_JOBS_PER_DAY = parseInt(process.env.MAX_JOBS_PER_DAY || '6', 10) || 6;

const VALID_GOALS = new Set(['polymath', 'golden_thread', 'inner_studio', 'open_gate']);
const VALID_VOICE_SETS = new Set(['male', 'female']);
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

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

function writeStatus(id, obj) {
  obj.updatedAt = new Date().toISOString();
  const p = path.join(jobDir(id), 'status.json');
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function anyJobRendering() {
  for (const d of fs.readdirSync(RENDERS, { withFileTypes: true })) {
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
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/') rel = '/index.html';
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

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';

  if (url === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'hypnosis-studio', time: new Date().toISOString() });
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
    const allowed = manifest && manifest.track
      ? [manifest.track.mp3, manifest.track.wav].filter(Boolean)
      : [];
    if (!allowed.includes(name)) return sendJson(res, 404, { error: 'unknown file' });
    const filePath = path.join(jobDir(id), name);
    const ext = path.extname(name).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Content-Length': fs.statSync(filePath).size,
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath).pipe(res);
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
});

server.listen(PORT, '127.0.0.1', () => console.log('hypnosis-studio on 127.0.0.1:' + PORT));
