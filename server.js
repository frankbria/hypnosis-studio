// Hypnosis Studio — static host + minimal API (zero-dependency Node).
// Serves the built frontend from web/dist and a small JSON API under /api.
// The render pipeline itself lives in engine/ (Python) and is invoked
// out-of-band for now; the API below is the seam the frontend will grow into.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4100;
const DIST = path.join(__dirname, 'web', 'dist');

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

// ---- mock job store (in-memory; real render queue comes later) ----
const STAGES = ['scripting', 'voicing', 'whisper-layer', 'entrainment-bed', 'mastering-qa'];
const jobs = new Map();

function createJob(payload) {
  const id = 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  jobs.set(id, { id, payload, started: Date.now() });
  return jobs.get(id);
}

function jobStatus(job) {
  const elapsed = (Date.now() - job.started) / 1000;
  const perStage = 3; // mock: ~15s total, mirrors the frontend staging
  const idx = Math.min(Math.floor(elapsed / perStage), STAGES.length);
  return {
    id: job.id,
    state: idx >= STAGES.length ? 'ready' : 'rendering',
    stage: idx >= STAGES.length ? null : STAGES[idx],
    progress: Math.min(1, elapsed / (perStage * STAGES.length)),
    prototype: true,
    note: 'Prototype mock — full renders are delivered after purchase.',
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 64 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
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
    const body = await readBody(req);
    const job = createJob({ goal: body.goal || null, voiceSet: body.voiceSet || null, custom: body.custom || null });
    return sendJson(res, 202, { jobId: job.id, ...jobStatus(job) });
  }
  const jobMatch = url.match(/^\/api\/jobs\/([A-Za-z0-9_]+)$/);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) return sendJson(res, 404, { error: 'unknown job' });
    return sendJson(res, 200, jobStatus(job));
  }
  if (url.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  serveStatic(req, res, url);
});

server.listen(PORT, '127.0.0.1', () => console.log('hypnosis-studio on 127.0.0.1:' + PORT));
