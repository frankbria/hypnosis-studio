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

// Load .env before anything reads process.env.
//
// Nothing did this before, so a .env sitting next to server.js was inert: the
// operator would put ELEVENLABS_API_KEY in it, the server would start fine, and
// the first render would fail at the TTS step with the key unread on disk.
//
// process.loadEnvFile is native (Node >= 20.12) — no dependency for something
// the runtime does itself. Done HERE rather than via `node --env-file` in
// package.json because the systemd unit is not in this repo (#43) and may well
// invoke `node server.js` directly, which would skip an npm script entirely.
//
// Resolved against __dirname, not cwd: systemd sets WorkingDirectory, and a
// relative lookup would silently find nothing if that ever differs.
//
// The real environment WINS over the file — loadEnvFile does not overwrite
// variables that are already set. That is the precedence prod needs: systemd or
// the shell beats a stale .env left in the deploy directory.
// HYPNO_NO_DOTENV lets the test harnesses opt out. They spawn this file from
// the repo root and set every variable they depend on explicitly — but a
// developer's .env sits in that same directory, so any variable a test relies
// on the DEFAULT for would silently take the developer's value instead. That is
// a test suite that passes on one machine and not another, for reasons nothing
// in the test says.
if (!process.env.HYPNO_NO_DOTENV) {
  try {
    process.loadEnvFile(path.join(__dirname, '.env'));
  } catch (err) {
    // ENOENT is the normal case in production, where systemd supplies the
    // environment and no .env exists. Anything else is worth seeing.
    if (err.code !== 'ENOENT') {
      console.error('could not read .env:', err.message);
    }
  }
}

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
// `|| 6` treated 0 as absent, so an operator setting MAX_JOBS_PER_DAY=0 to stop
// renders got six of them — the opposite of what they asked for, silently, on a
// switch whose whole purpose is to spend nothing. Zero is a legitimate value
// here; only nonsense falls back, the same stance RETENTION_DAYS takes.
const MAX_JOBS_PER_DAY = (() => {
  const n = parseInt(process.env.MAX_JOBS_PER_DAY ?? '6', 10);
  return Number.isInteger(n) && n >= 0 ? n : 6;
})();

const VALID_GOALS = new Set(['polymath', 'golden_thread', 'inner_studio', 'open_gate', 'river']);

// The provider meters characters and bills monthly, so that is what the budget
// counts. MAX_JOBS_PER_DAY permits ~180 programs a month, which does not bound
// spend against any plan below Business — it only spreads it out, and a busy
// first week then exhausts the month with every later render failing after
// payment.
//
// Default sized to a Pro allocation (~500k characters, ~25 programs). Set it to
// match the plan actually being paid for.
// Mirrors VOICE_SETS in render_program.py — the ids that end up in the cache key.
const VOICE_SETS = {
  male: { narrator: 'nPczCjzI2devNBz1zQrb', whisper: 'RsoSo7Gg7GyAtGoPBiqb' },
  female: { narrator: 'EXAVITQu4vr4xnSDxMaL', whisper: 'pFZP5JQG7iQjIQuC4Bku' },
};

const MONTHLY_CHAR_BUDGET = (() => {
  const n = parseInt(process.env.MONTHLY_CHAR_BUDGET || '500000', 10);
  return Number.isFinite(n) && n > 0 ? n : 500000;
})();

// What each goal actually costs, computed from the scripts rather than assumed.
// A committed table would go stale the moment a script is edited and the failure
// would be silent — the budget would meter one number while ElevenLabs billed
// another. This is the exact string render_track.tts() sends: tag + text, with
// the whisper tag only on suggestion segments.
const GOAL_CHARS = (() => {
  const suffixes = ['', '_track2', '_track3', '_track4'];
  const out = {};
  for (const goal of VALID_GOALS) {
    let total = 0;
    for (const suffix of suffixes) {
      const p = path.join(__dirname, 'engine', 'scripts', `${goal}${suffix}_tts_segments.json`);
      const script = readJsonSafe(p);
      if (!script || !Array.isArray(script.segments)) { total = null; break; }
      for (const seg of script.segments) {
        const tag = seg.phase === 'suggestion' ? '[whispering] ' : '[soft] ';
        total += tag.length + String(seg.text || '').length;
      }
    }
    // A goal whose scripts cannot be read is charged the largest known program
    // rather than zero, so an unreadable file cannot quietly make renders free.
    out[goal] = total;
  }
  const known = Object.values(out).filter((v) => typeof v === 'number');
  const fallback = known.length ? Math.max(...known) : 25000;
  for (const goal of Object.keys(out)) {
    if (typeof out[goal] !== 'number') {
      console.error('could not size goal', goal, '- charging it', fallback, 'characters');
      out[goal] = fallback;
    }
  }
  return out;
})();
const VALID_VOICE_SETS = new Set(['male', 'female']);

// ---- checkout (#22) --------------------------------------------------------
//
// Deliberately no `stripe` package. This repo has zero dependencies and the
// deploy workflow scp's server.js/package.json/engine/web/dist without ever
// running `npm ci` at the root — an SDK here would mean shipping node_modules
// and rebuilding the pipeline to do it. Checkout Sessions are a form-encoded
// POST, which fetch does natively, and the webhook signature #23 needs is an
// HMAC, which the crypto already imported above does natively.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
// Overridable for the same reason ENGINE_PY and RENDERS_DIR are: the tests need
// a Stripe they control, and asserting "zero calls left the box" requires a box
// to point at.
const STRIPE_API_BASE = process.env.STRIPE_API_BASE || 'https://api.stripe.com';
// Pinned rather than floating. An account's default API version changes when
// Stripe upgrades it in the dashboard, which would silently change the shape of
// what this code sends and reads without a commit anywhere in this repo.
const STRIPE_API_VERSION = '2024-06-20';

// THE price. It lived only in the frontend bundle until now, which meant it was
// whatever the browser said it was. Nothing in the request body may reach this
// number — a test asserts that against every field name a tamperer would try.
const DEFAULT_PROGRAM_PRICE_CENTS = 3900;

// Same "nonsense lands on the documented default" stance as RETENTION_DAYS, but
// it cannot be written the same way, because parseInt is the wrong tool for
// money. `parseInt('1e21', 10)` is **1** — it stops at the 'e' — so an operator
// writing scientific notation to mean "a lot" would charge one cent, and
// Number.isInteger(1) waves it through. Require plain digits instead, and use
// isSafeInteger so a value past 2^53 cannot round on its way to Stripe.
const PROGRAM_PRICE_CENTS = (() => {
  const raw = (process.env.PROGRAM_PRICE_CENTS || '').trim();
  if (!raw) return DEFAULT_PROGRAM_PRICE_CENTS;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isSafeInteger(n) && n > 0) return n;
  console.error('PROGRAM_PRICE_CENTS is not a whole number of cents:', raw,
    '- charging the documented default instead');
  return DEFAULT_PROGRAM_PRICE_CENTS;
})();

// The site writes the price with a '$'. A test pins this to that, because
// setting it to gbp in production would charge £39 against a page saying $39
// and nothing else in the system would notice. A value Stripe would reject is
// refused here rather than becoming an opaque 502 at the moment of purchase.
const PROGRAM_CURRENCY = (() => {
  const raw = (process.env.PROGRAM_CURRENCY || 'usd').trim().toLowerCase();
  if (/^[a-z]{3}$/.test(raw)) return raw;
  console.error('PROGRAM_CURRENCY is not a three-letter code:', raw, '- using usd');
  return 'usd';
})();

// Where Stripe sends the customer back to. Required — NOT derived from the
// request's Host header, which is attacker-controlled: a forged Host would make
// success_url point at somebody else's site, and the customer would land there
// straight after paying us. One env var is cheaper than being careful about
// that forever.
//
// Validated at startup rather than trusted. A value like `hypnosisstudio.com`
// (no scheme) builds a success_url Stripe rejects, and the operator would see
// only `502 checkout_unavailable` at purchase time with nothing pointing at
// their env file. Treating it as unset instead means they get
// `checkout_disabled` — the code that means "you have not configured this" —
// plus a log line naming the variable.
const PUBLIC_BASE_URL = (() => {
  const raw = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(raw); } catch { parsed = null; }
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    console.error('PUBLIC_BASE_URL is not an http(s) URL:', raw,
      '- checkout stays disabled');
    return '';
  }
  return raw;
})();

// The webhook signing secret (`whsec_…`), from the Stripe dashboard endpoint.
// It is a DIFFERENT value from STRIPE_SECRET_KEY and is what turns an anonymous
// POST into an authorisation to spend TTS credits. Setting it also closes the
// ACCESS_CODE render path — see the /api/programs handler.
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

// Stripe's own default. A captured request stays perfectly signed forever, so
// the timestamp is the only thing that expires it.
const WEBHOOK_TOLERANCE_S = 300;

const CHECKOUT_TIMEOUT_MS = 10000;

// ---- delivery email (#28) --------------------------------------------------
//
// A 15-20 minute render means nobody sits on the page, so without this a
// finished program has no way of reaching the person who bought it. The email
// carries the resume link from #27, not the audio — the masters are hundreds of
// megabytes.
//
// Sent over an HTTP API rather than SMTP, because SMTP would mean a dependency
// and this repo has none. The provider surface is one fetch in sendEmail(), so
// swapping it is a contained change; EMAIL_API_BASE and the two fields below
// are all that is provider-specific.
const EMAIL_API_KEY = process.env.EMAIL_API_KEY || '';
const EMAIL_API_BASE = process.env.EMAIL_API_BASE || 'https://api.resend.com';
// Must be an address on a domain verified with the provider, or every send is
// rejected. There is no sensible default, so an unset value disables delivery
// rather than sending from something that will bounce.
const EMAIL_FROM = process.env.EMAIL_FROM || '';

// The address a customer can reply to. The frontend has its own copy of this
// (VITE_SUPPORT_EMAIL, inlined at build time); a test pins the two defaults
// together, because an email telling someone to write to an address the site
// does not show is worse than no address at all.
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'frank.bria@pm.me';

const EMAIL_TIMEOUT_MS = 10000;

// Bounded for the same reason the refund retry is: a permanently rejected
// address should not be retried every sixty seconds forever.
const DELIVERY_MAX_ATTEMPTS = 5;

// ---- credit preflight (#25) ------------------------------------------------
//
// The daily cap and the ElevenLabs plan quota were never reconciled: ~20k
// characters a program against a 500k plan is ~25 programs a month, while
// MAX_JOBS_PER_DAY=6 permits ~180. Now that money changes hands the gap has a
// specific shape — a customer pays, waits twenty minutes, and receives a
// quota-exhaustion failure.
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
// Overridable for the same reason STRIPE_API_BASE is: the tests need a provider
// they control, and "no request was made" has to be an assertion.
const ELEVENLABS_API_BASE = process.env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io';

// How long a balance reading is reused. The acceptance criterion is that this
// does not add a provider round-trip to every page view; a minute is far longer
// than a burst of checkouts and far shorter than the time it takes to spend a
// meaningful number of credits.
const CREDIT_CACHE_MS = (() => {
  const n = parseInt(process.env.CREDIT_CACHE_MS || '60000', 10);
  return Number.isFinite(n) && n > 0 ? n : 60000;
})();

const CREDIT_TIMEOUT_MS = 5000;

// The last reading, kept even once stale. See creditsRemaining().
let creditReading = null;   // { remaining, at }
let creditInFlight = null;  // de-duplicates concurrent refreshes

// A ceiling on how many Checkout Sessions this service will ask Stripe for.
//
// /api/programs is gated by ACCESS_CODE, the daily quota and the monthly budget;
// /api/checkout has none of those and cannot — it is the endpoint a customer who
// has not bought anything yet must be able to reach. Without a cap, a loop
// against it runs unbounded requests against our Stripe account.
//
// ponytail: deliberately a GLOBAL cap, not per-IP. Behind nginx every peer
// address is 127.0.0.1, so a per-IP bucket would have to trust X-Forwarded-For,
// which a client can forge — a bucket keyed on a forgeable value is not a
// bucket. The ceiling that buys is that one attacker can lock out real
// customers for a minute; move to a per-IP bucket keyed on a
// trusted-proxy-verified address if that ever happens.
const CHECKOUT_MAX_PER_MINUTE = (() => {
  const n = parseInt(process.env.CHECKOUT_MAX_PER_MINUTE || '30', 10);
  return Number.isInteger(n) && n > 0 ? n : 30;
})();

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

// The bytes exactly as they arrived.
//
// The webhook cannot use readBody(): Stripe signs the body it sent, and
// JSON.stringify(JSON.parse(x)) is not x — key order, whitespace and unicode
// escaping all differ — so verifying against a re-serialisation fails on
// perfectly genuine events. Parsing happens only after the signature checks
// out, which is also the right order for a security check.
//
// Resolves null when the body exceeds the cap, rather than verifying a
// truncated prefix. Same 64 KB ceiling as readBody; a Stripe event is a few KB.
function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > 64 * 1024) { aborted = true; chunks.length = 0; req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(aborted ? null : Buffer.concat(chunks)));
    // destroy() emits 'close' without 'end'; without this the promise never
    // settles and the request handler is left awaiting forever.
    req.on('close', () => resolve(aborted ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(data || '{}'); } catch { parsed = null; }
      // A body of the literal `null` parses fine and is not an object, so every
      // caller's first `body.field` read throws — which the request backstop
      // turns into a 500 for what is plainly a client error. Guarded here rather
      // than at each route: both callers would otherwise need the same check,
      // and the next one would forget it.
      resolve(parsed && typeof parsed === 'object' ? parsed : {});
    });
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

// The cache key Python writes, recomputed here. Must stay byte-identical to
// segment_cache.key(): sha256 over each field as <utf8 length> NUL <utf8 bytes>.
// A cross-language test pins the two together, because a silent divergence
// would make every segment look uncached and charge for work already paid for.
function segmentCacheKey(voiceId, tag, text) {
  const h = crypto.createHash('sha256');
  for (const field of [voiceId, tag, text]) {
    const raw = Buffer.from(field, 'utf8');
    h.update(String(raw.length), 'ascii');
    h.update(Buffer.from([0]));
    h.update(raw);
  }
  return h.digest('hex');
}

function segmentCacheDir() {
  return process.env.SEGMENT_CACHE_DIR || path.join(RENDERS, 'segment-cache');
}

// What this render would actually buy. Since #9 a segment already in the shared
// cache costs nothing, and a repeat of the same (goal, voiceSet) buys nothing at
// all — charging the full script there would refuse renders that are free, which
// is a lost sale rather than a saved credit.
//
// Falls back to the full size if anything about the cache cannot be read: over-
// charging delays a sale, under-charging overruns the plan, and only one of
// those is recoverable.
// Whether the renderer would actually reuse this entry.
//
// It must ask the same question segment_cache.lookup() asks, not a weaker one.
// lookup() discards an entry whose header is not RIFF — so a corrupt cached
// segment reads as free here while the renderer re-purchases it, and spend
// exceeds the cap by exactly the segments the budget thought were already paid
// for. Existence is not usability.
function cachedSegmentUsable(entryPath) {
  let fd;
  try {
    fd = fs.openSync(entryPath, 'r');
    const head = Buffer.alloc(4);
    const read = fs.readSync(fd, head, 0, 4, 0);
    return read === 4 && head.toString('latin1') === 'RIFF';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* nothing to do */ }
    }
  }
}

function uncachedChars(goal, voiceSet) {
  const voices = VOICE_SETS[voiceSet];
  if (!voices) return GOAL_CHARS[goal];
  const cache = segmentCacheDir();
  let total = 0;
  try {
    for (const suffix of ['', '_track2', '_track3', '_track4']) {
      const p = path.join(__dirname, 'engine', 'scripts', `${goal}${suffix}_tts_segments.json`);
      const script = readJsonSafe(p);
      if (!script || !Array.isArray(script.segments)) return GOAL_CHARS[goal];
      for (const seg of script.segments) {
        const whisper = seg.phase === 'suggestion';
        const tag = whisper ? '[whispering] ' : '[soft] ';
        const voiceId = whisper ? voices.whisper : voices.narrator;
        const cost = tag.length + String(seg.text || '').length;
        const key = segmentCacheKey(voiceId, tag, String(seg.text || ''));
        const entry = path.join(cache, key.slice(0, 2), `${key}.wav`);
        if (!cachedSegmentUsable(entry)) total += cost;
      }
    }
  } catch {
    return GOAL_CHARS[goal];
  }
  return total;
}

function budgetPath() {
  return path.join(RENDERS, '.budget.json');
}

// Same ledger shape as the daily quota, for the same reason: a release has to be
// idempotent against the exit-handler / stale-sweep race. A map rather than a
// list, because a release gives back *that job's* characters, not a fixed one.
//
// Discarding a file from another month on read is what keeps the ledger finite —
// with the daily cap no longer the binding limit it now spans a month, so the
// month rollover is the only thing bounding its size.
function readBudget() {
  const month = new Date().toISOString().slice(0, 7);
  const b = readJsonSafe(budgetPath());
  if (b && b.month === month && typeof b.chars === 'number') {
    return { month, chars: b.chars, jobs: (b.jobs && typeof b.jobs === 'object') ? b.jobs : {} };
  }
  return { month, chars: 0, jobs: {} };
}

function writeBudget(b) {
  const p = budgetPath();
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(b));
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    console.error('budget write failed:', e && e.message);
    return false;
  }
}

function budgetRemaining() {
  return Math.max(0, MONTHLY_CHAR_BUDGET - readBudget().chars);
}

function chargeBudget(id, cost) {
  const b = readBudget();
  b.chars += cost;
  b.jobs[id] = cost;
  return writeBudget(b);
}

function refundBudget(id) {
  const b = readBudget();
  const owed = b.jobs[id];
  // A job charged at 23:59 and failing at 00:01 finds an empty ledger and is not
  // refunded. That is deliberate rather than merely accepted: the charge sat
  // against a month that has closed, and crediting it to the new month would
  // hand out allowance that was never spent from it. The characters are stranded
  // in a file nothing reads again, which is the conservative direction.
  if (typeof owed !== 'number') return false;
  delete b.jobs[id];
  b.chars = Math.max(0, b.chars - owed);
  if (!writeBudget(b)) {
    console.error('budget for', id, 'could not be refunded (write failed)');
    return false;
  }
  console.log('refunded', owed, 'characters for failed job', id);
  return true;
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
  releaseJob(id);
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

// Both ledgers, at every point a job can be declared failed. Separate functions
// would mean four call sites to keep in step.
//
// Since #26 this is also where the customer's MONEY goes back. Every path that
// declares a job failed already routed through here — the worker exit handler,
// failToStart, and the stale sweep — and none of them run on success, so it is
// the one hook the refund needs rather than three.
function releaseJob(id) {
  releaseQuota(id);
  refundBudget(id);
  // Deliberately not awaited. Every caller is a synchronous callback — a child
  // 'exit' handler or a sweep timer — where a rejection is an
  // uncaughtException rather than something the request backstop can catch.
  // refundOrder never throws and never rejects; the .catch is the belt to that
  // brace.
  refundOrder(id).catch((e) => console.error('refund path threw for', id, e && e.message));
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
    if (!st || st.state !== 'ready') {
      releaseJob(id);
    } else {
      // Promptness only. sweepUndelivered() is what guarantees the email
      // eventually goes — this handler does not run at all for a job that
      // finishes while the service is restarting.
      deliverProgram(id).catch((e) => console.error('delivery threw for', id, e && e.message));
    }
  });
}

// ---- webhook (#23) ----

// Verify a Stripe-Signature header against the raw body.
//
// The header is `t=<unix>,v1=<hex>[,v1=<hex>…]` — more than one v1 during a
// secret rotation. The signed payload is `<t>.<raw>` using the timestamp STRING
// from the header: parsing it to a Number and interpolating it back would
// change the bytes for any value that does not round-trip identically.
//
// Never throws. timingSafeEqual rejects buffers of different lengths with a
// TypeError, and a throw reachable from a request is how this service has taken
// an outage before.
function verifyStripeSignature(raw, header, secret) {
  if (typeof header !== 'string' || !header) return false;

  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) return false;

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  if (Math.abs(Date.now() / 1000 - seconds) > WEBHOOK_TOLERANCE_S) return false;

  const expected = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.`).update(raw).digest();

  return signatures.some((sig) => {
    // A malformed hex string yields a short buffer rather than an error, so the
    // length check below is what keeps timingSafeEqual from throwing.
    const given = Buffer.from(sig, 'hex');
    if (given.length !== expected.length) return false;
    return crypto.timingSafeEqual(given, expected);
  });
}

// One file per paid session: the ORDER (#24).
//
// It lives here rather than inside the job directory on purpose.
// sweepExpiredJobs() deletes whole job directories after RETENTION_DAYS, and an
// order stored there would be destroyed on day 31 — taking the payment
// reference and the customer email with it, exactly when a refund or a support
// query needs them. A refund request arrives after the audio is gone, not
// before. JOB_DIR_RE requires a `job_` prefix, so the sweep can never select
// this directory.
//
// It is also the replay guard from #23: never deleted, because it is the
// evidence money changed hands. What makes replay safe is not the file's
// existence but what it says.
//
// ponytail: these accumulate — ~150 bytes per order, never reaped. At any
// plausible volume that is kilobytes a year, and expiring them would let an old
// event replay into a second paid render.
function sessionsDir() {
  return path.join(RENDERS, '.sessions');
}

function claimPath(sessionId) {
  return path.join(sessionsDir(), `${sessionId}.json`);
}

// How long a claim with no evidence either way is treated as "a delivery is
// mid-spawn right now".
//
// This covers ONLY the sub-second gap between taking the claim and the job
// directory existing. Everything else — a refusal, a failed render, a finished
// render — is answered from evidence below, not from the clock.
const RECLAIM_AFTER_MS = 60 * 1000;

// EVERY job started for this session, asked of the jobs themselves.
//
// The claim file cannot answer it alone: if the write that records the jobId
// fails, a claim with no jobId is indistinguishable from one whose render never
// started — and re-rendering the first case spends credits on a program the
// customer already has. The job directory records its own session, so the
// answer does not depend on a write that may not have happened.
//
// All of them, not the first: recovering a failed render leaves a session with
// two jobs, and readdir order is not creation order. Returning whichever came
// back first would let the failed one answer for the delivered one and
// re-render an order the customer already has.
//
// ponytail: a linear scan, bounded by the retention window (~180 dirs at the
// current caps) and only reached on the duplicate path. Index it if either
// number ever changes by an order of magnitude.
function jobsForSession(sessionId) {
  let dirs;
  try { dirs = fs.readdirSync(RENDERS, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory() || !JOB_DIR_RE.test(d.name)) continue;
    const rec = readJsonSafe(path.join(RENDERS, d.name, 'order.json'));
    if (rec && rec.sessionId === sessionId) out.push(d.name);
  }
  return out;
}

// May this session be rendered, given a claim that already exists?
//
// Deliberately conservative about the cases it cannot read: an unparseable
// claim means we do not know whether this order already rendered, and guessing
// "no" spends TTS credits on a maybe. Under-delivering is visible in the log
// and recoverable by a person; over-delivering is money already gone.
function claimIsRecoverable(claim, sessionId) {
  if (!claim || typeof claim !== 'object') return false;

  // Once a refund has been STARTED, this order is settled as money and must
  // never render (#26). Not just `refunded`:
  //
  //   pending  — the refund is in flight; rendering now races it, and the
  //              customer would end up with the program and their money back.
  //   failed   — the sweep still owes them the refund, so the same race is
  //              merely slower.
  //
  // Which leaves the customer of a permanently unrefundable order with
  // neither, deliberately: that case is already logged as NEEDS A HUMAN, and
  // whether to hand over the program or the money is a decision for the human,
  // not something to resolve by giving away both.
  if (claim.refund) return false;

  const jobIds = new Set(jobsForSession(sessionId));
  if (claim.jobId) jobIds.add(claim.jobId);
  if (jobIds.size > 0) {
    // Owed only if not ONE of them is still going or already delivered. A
    // missing status.json counts as not delivered: either the render never got
    // that far, or the retention sweep has taken the files the customer paid
    // for, and both leave them with nothing.
    for (const id of jobIds) {
      const st = readJsonSafe(path.join(jobDir(id), 'status.json'));
      if (st && st.state !== 'failed') return false;
    }
    return true;
  }

  // No render exists for this session at all.
  //
  // A recorded refusal is decisive: the studio said no (busy, daily cap, a full
  // disk, a spent budget) and the order is still owed. Waiting out a clock here
  // was the bug — Stripe retries a 500 within seconds, and a fresh claim with
  // no jobId read as "someone is mid-spawn", so the retry was acknowledged as a
  // duplicate and the paid order was dropped.
  if (claim.lastError) return true;

  // Nothing recorded either way: this is the only case the clock decides, and
  // it is the genuine mid-spawn window.
  const age = Date.now() - Date.parse(claim.claimedAt || 0);
  return Number.isFinite(age) && age >= RECLAIM_AFTER_MS;
}

// true = claimed by this call, false = already claimed by someone live,
// null = could not tell. null must not be read as "already done": that would
// silently drop a paid order on a full disk.
function claimSession(sessionId, record) {
  try {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    fs.writeFileSync(claimPath(sessionId), JSON.stringify(record, null, 2), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') {
      console.error('could not record session', sessionId, e && e.message);
      return null;
    }
    const existing = readJsonSafe(claimPath(sessionId));
    if (!claimIsRecoverable(existing, sessionId)) return false;
    // Recoverable: take it over. The window between this read and the write is
    // reachable only by two deliveries of a session whose previous render
    // already failed, and startRender's own concurrency lock refuses the second
    // with `busy`. Naming the ceiling rather than reaching for a lock file.
    console.warn('session', sessionId, 'is claimed but never delivered - rendering it again');
    return writeClaim(sessionId, record) ? true : null;
  }
}

// What the customer paid, pulled out of the session object.
//
// `payment_intent` is a string id normally, or the whole object when the
// endpoint expands it — storing "[object Object]" would make the refund in #26
// fail at the moment it is needed. The email is optional: Stripe fills
// customer_details.email or customer_email depending on how the session was
// created, and a render that is paid for must not be refused because an
// optional string is absent.
function paymentDetails(session) {
  const pi = session.payment_intent;
  const details = session.customer_details || {};
  const email = typeof details.email === 'string' ? details.email
    : typeof session.customer_email === 'string' ? session.customer_email
      : null;
  return {
    paymentIntent: typeof pi === 'string' ? pi
      : (pi && typeof pi.id === 'string' ? pi.id : null),
    email,
    // What was actually taken, not what the price happens to be at refund time.
    amountTotal: Number.isFinite(session.amount_total) ? session.amount_total : null,
    currency: typeof session.currency === 'string' ? session.currency : null,
  };
}

// Atomically, the way writeStatus writes status.json. A half-written claim is
// unparseable, and an unparseable claim is treated as "cannot tell" above —
// which strands the order rather than losing it twice.
function writeClaim(sessionId, record) {
  const p = claimPath(sessionId);
  const tmp = `${p}.tmp`;
  try {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    console.error('could not write session record', sessionId, e && e.message);
    return false;
  }
}

// ---- credit preflight ----

// Characters left on the ElevenLabs plan, or null when it cannot be told.
//
// null is a real third answer and the callers treat it as such. Refusing every
// sale because a metering endpoint is briefly unreachable closes the shop over
// something that is not the shop's problem; the monthly ledger
// (MONTHLY_CHAR_BUDGET) is the guard that actually bounds our own spend, and it
// is local and always available.
//
// A stale reading beats no reading: a value from ten minutes ago is far closer
// to the truth than a shrug, and credits do not move quickly at ~20k a program.
// So null is only returned when the balance has NEVER been read successfully —
// which in practice means the key is missing or lacks the `user_read` scope,
// and that is a configuration problem an operator has to see in the log rather
// than a reason to stop selling.
async function creditsRemaining() {
  if (creditReading && Date.now() - creditReading.at < CREDIT_CACHE_MS) {
    return creditReading.remaining;
  }
  if (!ELEVENLABS_API_KEY) return null;
  // One refresh at a time. A burst of checkouts on a cold cache would otherwise
  // each open their own request to the provider.
  if (!creditInFlight) {
    creditInFlight = fetchCredits().finally(() => { creditInFlight = null; });
  }
  const fresh = await creditInFlight;
  if (fresh !== null) {
    creditReading = { remaining: fresh, at: Date.now() };
    return fresh;
  }
  return creditReading ? creditReading.remaining : null;
}

async function fetchCredits() {
  let r;
  try {
    r = await fetch(`${ELEVENLABS_API_BASE}/v1/user/subscription`, {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
      signal: AbortSignal.timeout(CREDIT_TIMEOUT_MS),
    });
  } catch (e) {
    console.error('elevenlabs: could not read the credit balance:', e && e.message);
    return null;
  }
  if (!r.ok) {
    // 401 here almost always means the key is scoped to Text to Speech only.
    // Naming the scope saves an operator the hour this would otherwise take.
    console.error('elevenlabs: credit balance request returned', r.status,
      r.status === 401
        ? '- the key may lack the `user_read` scope, which this preflight needs'
        : '');
    return null;
  }
  let json;
  try {
    json = await r.json();
  } catch {
    console.error('elevenlabs: credit balance response was not JSON');
    return null;
  }
  const used = json && json.character_count;
  const limit = json && json.character_limit;
  if (!Number.isFinite(used) || !Number.isFinite(limit)) {
    console.error('elevenlabs: credit balance response had no usable counts');
    return null;
  }
  return Math.max(0, limit - used);
}

// Can this exact program be rendered? Returns null when it can, or a reason.
//
// Checked at CHECKOUT rather than at render start, which is the whole point of
// #25: startRender() runs from the webhook, so every refusal it makes now
// happens after the customer has paid.
//
// Priced against the specific goal and voice set rather than the worst-case
// program: since #9 a repeat of the same pair costs nothing, and refusing a
// render that is free would be a lost sale over credits that would not be
// spent.
async function capacityProblem(goal, voiceSet) {
  const cost = uncachedChars(goal, voiceSet);
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
    console.error('could not price goal', goal, '- refusing rather than guessing');
    return 'could not price the program';
  }
  // The local ledger first: no network call, and it is the limit that actually
  // binds our own spend.
  if (budgetRemaining() < cost) {
    return `the monthly allowance is spent (needs ${cost}, ${budgetRemaining()} left)`;
  }
  const credit = await creditsRemaining();
  if (credit !== null && credit < cost) {
    return `the voice provider has ${credit} characters left, this program needs ${cost}`;
  }
  return null;
}

// ---- refunds (#26) ---------------------------------------------------------
//
// web/src/lib/legal.ts states the policy this implements, and states it as a
// specification rather than a description:
//
//   "If your render fails, you are refunded in full, automatically. You do not
//    have to ask, and you do not have to prove anything — the refund is issued
//    by the same system that noticed the failure."
//
// So: full amount, no human in the loop, hung off the existing detection.

const REFUND_TIMEOUT_MS = 10000;

// How long a refund claim may sit before it is treated as abandoned by a
// crashed process. Long enough that a slow Stripe call is never overtaken.
const REFUND_CLAIM_STALE_MS = 5 * 60 * 1000;

// How many times the sweep will re-attempt an owed refund before leaving it to
// a person. Bounded so a permanently rejected refund (a payment already
// disputed, say) does not call Stripe every minute forever.
const REFUND_MAX_ATTEMPTS = 5;

// How long a paid order whose render was REFUSED waits before it is refunded.
//
// A transient refusal is answered 500 and Stripe retries, so the order may yet
// be fulfilled; a permanent one (`budget_exhausted`) is answered 422 and Stripe
// never retries, so it would sit paid and undelivered forever. This window is
// long enough for the first case and short enough that the second does not hold
// someone's money for a day.
const REFUND_UNSTARTED_GRACE_MS = (() => {
  const n = parseInt(process.env.REFUND_UNSTARTED_GRACE_MS || '900000', 10);
  return Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000;
})();

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function refundClaimPath(sessionId) {
  return path.join(sessionsDir(), `${sessionId}.refunding`);
}

// Refund the order this job belongs to, if it has one and has not been refunded
// already. Never throws and never rejects — see releaseJob().
//
// Idempotency has three independent layers, because this moves real money and
// the two callers genuinely race (a worker can exit at the moment the sweep
// decides it is stale):
//
//   1. an atomic `wx` claim file, so the filesystem picks the winner;
//   2. the recorded state on the order, so a later sweep does not repeat it;
//   3. a stable Idempotency-Key at Stripe, which holds even when 1 and 2 are
//      lost — a crash between claiming and confirming leaves Stripe itself as
//      the thing that refuses the duplicate.
async function refundOrder(jobId, { reason = 'the render failed', session = null } = {}) {
  let sessionId = null;
  try {
    if (session) {
      // Supplied by the sweep, which reads the orders directly. The job's
      // back-pointer is inside the job directory, and retention deletes that
      // after RETENTION_DAYS — an owed refund must not become unretryable
      // just because the audio has aged out.
      sessionId = session;
    } else {
      const link = readJsonSafe(path.join(jobDir(jobId), 'order.json'));
      // No order: this render was never paid for (the ACCESS_CODE path, or a
      // prototype run). Nothing to give back — but say so, rather than leaving
      // the field absent. The page watching this job cannot tell "no refund is
      // coming" from "the refund has not landed yet" unless we tell it, and it
      // would sit waiting for something that is never going to arrive.
      if (!link || typeof link.sessionId !== 'string') {
        writeRefundStatus(jobId, 'none');
        return;
      }
      sessionId = link.sessionId;
    }

    const order = readJsonSafe(claimPath(sessionId));
    if (!order) {
      console.error('refund: job', jobId, 'names session', sessionId, 'but there is no order');
      writeRefundStatus(jobId, 'failed');
      return;
    }
    if (order.refund && order.refund.state === 'refunded') return;   // already done
    if (!order.paymentIntent) {
      console.error('refund: order', sessionId, 'has no payment reference - NEEDS A HUMAN');
      writeRefundStatus(jobId, 'failed');
      return;
    }
    if (!STRIPE_SECRET_KEY) {
      console.error('refund: order', sessionId, 'is owed a refund but no Stripe key is set',
        '- NEEDS A HUMAN');
      writeRefundStatus(jobId, 'failed');
      return;
    }

    // Layer 1. The create IS the lock; a second caller loses here.
    try {
      fs.writeFileSync(refundClaimPath(sessionId), String(Date.now()), { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') {
        console.error('refund: could not claim', sessionId, e && e.message);
        return;
      }
      // Taken. Usually that means another caller is mid-refund and this one
      // should stand down. But a crash between claiming and releasing would
      // otherwise leave the claim forever, and with it an order that can never
      // be refunded — so an old claim is treated as abandoned. Safe to take
      // over because the Idempotency-Key means a genuine overlap is one refund
      // at Stripe, not two.
      const claimedAt = Number(readTextSafe(refundClaimPath(sessionId)));
      if (Number.isFinite(claimedAt) && Date.now() - claimedAt < REFUND_CLAIM_STALE_MS) return;
      console.warn('refund: taking over an abandoned claim for', sessionId);
    }

    const attempts = ((order.refund && order.refund.attempts) || 0) + 1;
    markRefund(sessionId, { state: 'pending', reason, attempts, at: new Date().toISOString() });
    const result = await stripeRefund(order.paymentIntent, sessionId);

    if (result.ok) {
      markRefund(sessionId, {
        state: 'refunded', reason, attempts, refundId: result.id,
        amount: order.amountTotal, currency: order.currency,
        at: new Date().toISOString(),
      });
      writeRefundStatus(jobId, 'refunded');
      console.log('refunded', order.amountTotal, order.currency, 'for failed job', jobId,
        `(session ${sessionId}, refund ${result.id})`);
    } else {
      markRefund(sessionId, {
        state: 'failed', reason, attempts, error: result.error, at: new Date().toISOString(),
      });
      writeRefundStatus(jobId, 'failed');
      console.error('refund FAILED for', sessionId, '-', result.error,
        '- NEEDS A HUMAN. The customer paid and has nothing.');
    }
    // Released either way. A failed attempt must be retryable — by the sweep,
    // or by a person — and the Idempotency-Key is what makes that safe.
    try { fs.unlinkSync(refundClaimPath(sessionId)); } catch { /* nothing to undo */ }
  } catch (e) {
    console.error('refund: unexpected failure for job', jobId, e && e.message);
    if (sessionId) {
      try { fs.unlinkSync(refundClaimPath(sessionId)); } catch { /* nothing to undo */ }
    }
  }
}

// Record the refund on the order, preserving everything else about it.
function markRefund(sessionId, refund) {
  const order = readJsonSafe(claimPath(sessionId));
  if (!order) return false;
  return writeClaim(sessionId, { ...order, refund });
}

// Tell the CUSTOMER, through the one file the job status endpoint serves.
//
// Deliberately only a state, with no refund id and no amount: /api/jobs/<id> is
// public and unauthenticated, and #24 exists to keep the order off it. "Your
// money is on its way back" is the whole of what someone needs here.
function writeRefundStatus(jobId, state) {
  // An order refunded before any render existed has no job to write to. The
  // sweep refunds those, and nobody is watching a page for them.
  if (!jobId) return;
  const st = readJsonSafe(path.join(jobDir(jobId), 'status.json'));
  if (!st) return;
  writeStatus(jobId, { ...st, refund: state });
}

async function stripeRefund(paymentIntent, sessionId) {
  const form = new URLSearchParams({ payment_intent: paymentIntent });
  let r;
  try {
    r = await fetch(`${STRIPE_API_BASE}/v1/refunds`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': STRIPE_API_VERSION,
        // Layer 3, and the only one that survives losing the filesystem. Keyed
        // on the session so every retry of THIS order's refund is the same
        // request as far as Stripe is concerned.
        'Idempotency-Key': `refund-${sessionId}`,
      },
      body: form,
      signal: AbortSignal.timeout(REFUND_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, error: `request failed: ${e && e.message}` };
  }
  let json = null;
  try { json = await r.json(); } catch { /* handled below */ }
  if (!r.ok) {
    return {
      ok: false,
      error: `HTTP ${r.status}: ${(json && json.error && json.error.message) || '(no message)'}`,
    };
  }
  if (!json || typeof json.id !== 'string') {
    return { ok: false, error: 'the refund response had no id' };
  }
  return { ok: true, id: json.id };
}

// ---- delivery email (#28) --------------------------------------------------

function deliveryClaimPath(sessionId) {
  return path.join(sessionsDir(), `${sessionId}.delivering`);
}

/**
 * Tell the customer their program is ready.
 *
 * Never throws and never rejects: the callers are a child 'exit' handler and a
 * sweep timer, where a rejection is an uncaughtException.
 *
 * Idempotent the same way the refund is, and for the same reason — two callers
 * observe the same completion. The `wx` claim decides the winner, the recorded
 * state stops a later sweep repeating it, and neither is trusted alone.
 */
async function deliverProgram(jobId) {
  let sessionId = null;
  try {
    const link = readJsonSafe(path.join(jobDir(jobId), 'order.json'));
    // No order means nobody bought this — the early-access path. There is no
    // address to write to, and inventing a reason to email would be worse.
    if (!link || typeof link.sessionId !== 'string') return;
    sessionId = link.sessionId;

    const order = readJsonSafe(claimPath(sessionId));
    if (!order) return;
    if (order.delivery && order.delivery.state === 'sent') return;
    if (order.refund) return;    // refunded: there is nothing to deliver
    if (!order.email) {
      // Stripe did not give us one. Not an error worth shouting about — the
      // customer still has the page — but it is why they got no email.
      if (!order.delivery) {
        markDelivery(sessionId, { state: 'skipped', why: 'no email address on the order' });
      }
      return;
    }
    if (!EMAIL_API_KEY || !EMAIL_FROM || !PUBLIC_BASE_URL) {
      if (!order.delivery) {
        console.warn('delivery: cannot email', sessionId,
          '- set EMAIL_API_KEY, EMAIL_FROM and PUBLIC_BASE_URL');
        markDelivery(sessionId, { state: 'skipped', why: 'email is not configured' });
      }
      return;
    }

    try {
      fs.writeFileSync(deliveryClaimPath(sessionId), String(Date.now()), { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') return;
      const claimedAt = Number(readTextSafe(deliveryClaimPath(sessionId)));
      if (Number.isFinite(claimedAt) && Date.now() - claimedAt < REFUND_CLAIM_STALE_MS) return;
    }

    const attempts = ((order.delivery && order.delivery.attempts) || 0) + 1;
    const link2 = `${PUBLIC_BASE_URL}/program/${jobId}`;
    const sent = await sendEmail(order.email, deliveryEmail(link2), sessionId);
    const recorded = markDelivery(sessionId, sent.ok
      ? { state: 'sent', attempts, at: new Date().toISOString() }
      : { state: 'failed', attempts, error: sent.error, at: new Date().toISOString() });
    if (sent.ok) console.log('delivery: emailed', sessionId, 'their program at', link2);
    else console.error('delivery: could not email', sessionId, '-', sent.error);

    if (!recorded) {
      // The email may well have gone, and the only local evidence of it just
      // failed to persist. Keeping the claim stops the next sweep tick sending
      // again — the attempt counter cannot bound anything when the counter is
      // the thing that would not write.
      //
      // The provider's idempotency key is the real backstop; this only avoids
      // leaning on it every sixty seconds.
      console.error('delivery: could not record the send for', sessionId,
        '- holding the claim so the sweep does not repeat it. NEEDS A HUMAN.');
      return;
    }
    try { fs.unlinkSync(deliveryClaimPath(sessionId)); } catch { /* nothing to undo */ }
  } catch (e) {
    console.error('delivery: unexpected failure for job', jobId, e && e.message);
    if (sessionId) {
      try { fs.unlinkSync(deliveryClaimPath(sessionId)); } catch { /* nothing to undo */ }
    }
  }
}

function markDelivery(sessionId, delivery) {
  const order = readJsonSafe(claimPath(sessionId));
  if (!order) return false;
  return writeClaim(sessionId, { ...order, delivery });
}

/**
 * The message.
 *
 * States the retention window and the support address because a customer
 * reading this in three weeks needs both, and this email may be the only thing
 * they still have. Both come from the same values the rest of the system uses —
 * a number retyped here would drift from the one that deletes the files.
 */
function deliveryEmail(link) {
  const days = RETENTION_DAYS;
  const text = [
    'Your program is ready.',
    '',
    'All four tracks are rendered and waiting here:',
    link,
    '',
    `Download them within ${days} days — the studio deletes finished renders after that, `
      + 'and the link outlives the files.',
    '',
    `Any problems, reply to this email or write to ${SUPPORT_EMAIL}. A person reads it.`,
    '',
    'Hypnosis Studio',
  ].join('\n');

  const html = [
    '<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a">',
    '<p>Your program is ready.</p>',
    '<p>All four tracks are rendered and waiting here:</p>',
    `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
    `<p>Download them within ${days} days — the studio deletes finished renders after `,
    'that, and the link outlives the files.</p>',
    `<p>Any problems, reply to this email or write to `,
    `<a href="mailto:${escapeHtml(SUPPORT_EMAIL)}">${escapeHtml(SUPPORT_EMAIL)}</a>. `,
    'A person reads it.</p>',
    '<p>Hypnosis Studio</p>',
    '</div>',
  ].join('');

  return { subject: 'Your program is ready', text, html };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// The one provider-specific call. Returns { ok } or { ok: false, error }.
//
// `key` makes the send idempotent at the PROVIDER, which is the only layer that
// survives losing the local record. The window is real: the process can die in
// the ten seconds between the provider accepting the message and the `sent`
// state reaching disk, and the stale-claim takeover would then send again.
async function sendEmail(to, { subject, text, html }, key) {
  let r;
  try {
    r = await fetch(`${EMAIL_API_BASE}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${EMAIL_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `deliver-${key}`,
      },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, text, html }),
      signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, error: `request failed: ${e && e.message}` };
  }
  if (!r.ok) {
    let detail = '';
    try { detail = JSON.stringify(await r.json()).slice(0, 200); } catch { /* no body */ }
    return { ok: false, error: `HTTP ${r.status} ${detail}` };
  }
  return { ok: true };
}

// Programs that are finished and paid for but have not been emailed.
//
// State-driven rather than event-driven, the same correction #26 needed: a job
// that completes while the service is restarting is observed by no exit
// handler at all, and "did this customer get their email" is a question the
// records can answer at any time.
function sweepUndelivered() {
  let dirs;
  try { dirs = fs.readdirSync(RENDERS, { withFileTypes: true }); } catch { return; }
  for (const d of dirs) {
    if (!d.isDirectory() || !JOB_DIR_RE.test(d.name)) continue;
    const st = readJsonSafe(path.join(RENDERS, d.name, 'status.json'));
    if (!st || st.state !== 'ready') continue;
    const link = readJsonSafe(path.join(RENDERS, d.name, 'order.json'));
    if (!link || typeof link.sessionId !== 'string') continue;
    const order = readJsonSafe(claimPath(link.sessionId));
    if (!order || !order.email || order.refund) continue;
    if (order.delivery) {
      if (order.delivery.state === 'sent' || order.delivery.state === 'skipped') continue;
      if ((order.delivery.attempts || 0) >= DELIVERY_MAX_ATTEMPTS) continue;
    }
    deliverProgram(d.name).catch((e) => console.error('delivery sweep threw:', e && e.message));
  }
}

// ---- starting a render ----

// Every ledger check, in the one order they have to happen in, ending with a
// live worker. Extracted at #23 because the webhook must take exactly this
// path — "the same worker path used today" is the acceptance criterion, and two
// copies of a sequence that charges a budget and bumps a quota is how one of
// them ends up skipping a step.
//
// Returns `{ jobId }`, or `{ error, status, body }` describing the refusal. The
// caller decides what to say: an HTTP client gets the status, Stripe gets a
// retry-or-not decision.
function startRender(goal, voiceSet, sessionId = null) {
  const refuse = (status, body) => ({ error: body.error, status, body });

  if (anyJobRendering()) return refuse(409, { error: 'busy' });
  // Daily cap first: it is the burst control and its answer is "come back
  // tomorrow". The monthly budget is a different statement — "unavailable
  // until the plan resets or is raised" — which is why it is a 503 and not a
  // second 429. #25 needs that second one for its own preflight.
  if (readQuota().count >= MAX_JOBS_PER_DAY) return refuse(429, { error: 'daily_cap' });

  const cost = uncachedChars(goal, voiceSet);
  // Unreachable today (GOAL_CHARS covers every VALID_GOAL), but the failure
  // is silent and expensive if it ever is: `remaining < undefined` is false,
  // so the render proceeds, then `chars += undefined` is NaN, which
  // JSON.stringify writes as null, which readBudget rejects — zeroing the
  // month's spend. Make the invariant explicit rather than rely on it.
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
    console.error('could not price goal', goal, '- refusing rather than guessing');
    return refuse(503, { error: 'storage_unavailable' });
  }
  if (budgetRemaining() < cost) {
    console.warn('refusing render: needs', cost, 'characters,', budgetRemaining(), 'left this month');
    return refuse(503, {
      error: 'budget_exhausted',
      detail: 'temporarily unavailable — the monthly rendering allowance is spent',
    });
  }

  const jobId = 'job_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  // Guarded because this is the one synchronous fs call on the path, and the
  // webhook caller has already taken a session claim by the time it runs. A
  // throw here would skip every refusal branch below and surface as a bare 500,
  // leaving that claim behind with no render against it.
  try {
    fs.mkdirSync(jobDir(jobId), { recursive: true });
  } catch (e) {
    console.error('could not create a job directory:', e && e.message);
    return refuse(503, { error: 'storage_unavailable' });
  }
  // What this render IS, for a page that arrives knowing only the job id (#27).
  // A resumed /program/<id> has none of the wizard's state, and the goal and
  // voice set are what its copy is built from.
  //
  // A sidecar rather than a status.json field, for the same reason worker.json
  // and order.json are: the Python worker rewrites status.json wholesale on
  // every transition and would erase it on the first stage change.
  try {
    fs.writeFileSync(path.join(jobDir(jobId), 'job.json'), JSON.stringify({ goal, voiceSet }));
  } catch (e) {
    console.error('could not record what job', jobId, 'is rendering:', e && e.message);
  }
  // Which purchase this render belongs to. A back-pointer only: the order
  // itself lives outside the job directory, because this one is deleted by the
  // retention sweep and an order must outlive the audio.
  //
  // A sidecar rather than a status.json field, for the same reason worker.json
  // is one: the Python worker rewrites status.json wholesale on every
  // transition and would erase it. It is also why the order cannot be a status
  // field even if retention were not a factor.
  if (sessionId) {
    try {
      fs.writeFileSync(path.join(jobDir(jobId), 'order.json'), JSON.stringify({ sessionId }));
    } catch (e) {
      // Recoverable — the order also records the jobId. Losing both is what the
      // duplicate check is careful about.
      console.error('could not record the session on job', jobId, e && e.message);
    }
  }
  writeStatus(jobId, {
    jobId, state: 'rendering', stage: 'scripting', progress: 0,
    detail: 'Queued',
  });
  if (!chargeBudget(jobId, cost)) {
    // Same reasoning as the quota below: a render the budget cannot see is a
    // render the budget cannot bound.
    writeStatus(jobId, {
      jobId, state: 'failed', stage: null, progress: 0,
      detail: 'could not record the render against the monthly budget',
      error: 'budget storage unavailable',
    });
    return refuse(503, { error: 'storage_unavailable' });
  }
  if (!bumpQuota(jobId)) {
    refundBudget(jobId);
    // No spend. A render whose slot was never recorded is one the cap cannot
    // see, and the volume that could not take 80 bytes of JSON is not going
    // to hold ~500 MB of audio either.
    writeStatus(jobId, {
      jobId, state: 'failed', stage: null, progress: 0,
      detail: 'could not record the render against the daily quota',
      error: 'quota storage unavailable',
    });
    return refuse(503, { error: 'storage_unavailable' });
  }
  startWorker(jobId, goal, voiceSet);
  return { jobId };
}

// ---- checkout ----

// The catalog title, from the id. A GOAL_TITLES table here would be a second
// copy of web/src/lib/data.ts that nothing keeps in step, and it would go stale
// on the receipt — the one document a customer keeps. The ids were named to
// read this way ('golden_thread' -> 'Golden Thread'), so derive it.
function goalTitle(goal) {
  return goal.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// Timestamps of the sessions asked for in the last minute. A plain array
// because CHECKOUT_MAX_PER_MINUTE bounds its length — there is nothing to grow.
const checkoutHits = [];

function checkoutRateOk() {
  const now = Date.now();
  while (checkoutHits.length && now - checkoutHits[0] > 60000) checkoutHits.shift();
  if (checkoutHits.length >= CHECKOUT_MAX_PER_MINUTE) return false;
  checkoutHits.push(now);
  return true;
}

// Create the Checkout Session. Every field is built here; the caller passes an
// already-validated goal and voice set and nothing else.
//
// Returns null on any failure, having logged it. The caller turns that into a
// 502 — never into a session object the browser cannot use.
async function createCheckoutSession(goal, voiceSet) {
  const form = new URLSearchParams({
    mode: 'payment',
    // Stripe substitutes the real id for the literal placeholder on redirect.
    success_url: `${PUBLIC_BASE_URL}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${PUBLIC_BASE_URL}/?checkout=cancelled`,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': PROGRAM_CURRENCY,
    'line_items[0][price_data][unit_amount]': String(PROGRAM_PRICE_CENTS),
    'line_items[0][price_data][product_data][name]': `Hypnosis Studio — ${goalTitle(goal)}`,
    // What was bought. #23 gates the render on the webhook, and it can only
    // start the right render if the session says which one was paid for.
    'metadata[goal]': goal,
    'metadata[voiceSet]': voiceSet,
  });

  let r;
  try {
    r = await fetch(`${STRIPE_API_BASE}/v1/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': STRIPE_API_VERSION,
      },
      body: form,
      signal: AbortSignal.timeout(CHECKOUT_TIMEOUT_MS),
    });
  } catch (e) {
    console.error('stripe: checkout session request failed:', e && e.message);
    return null;
  }

  let json;
  try {
    json = await r.json();
  } catch {
    json = null;
  }
  if (!r.ok) {
    // Stripe's message, not ours — it names the actual problem (bad key,
    // account not activated) and is the only way an operator finds out.
    console.error('stripe: checkout session rejected:', r.status,
      (json && json.error && json.error.message) || '(no message)');
    return null;
  }
  if (!json || typeof json.url !== 'string' || typeof json.id !== 'string') {
    console.error('stripe: checkout session response had no usable url');
    return null;
  }
  return { sessionId: json.id, url: json.url };
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
    const budgetNow = readBudget();
    const remaining = Math.max(0, MONTHLY_CHAR_BUDGET - budgetNow.chars);
    const dearest = Math.max(...Object.values(GOAL_CHARS));
    // `rendering` is what the deploy gate waits on (deploy/wait-for-idle.sh) —
    // the same predicate the render endpoint uses to return 409 busy, so there
    // is one source of truth rather than a second implementation in shell.
    return sendJson(res, 200, {
      ok: true,
      service: 'hypnosis-studio',
      rendering: anyJobRendering(),
      // The cheapest thing to watch: this endpoint is already polled by the
      // deploy gate, so the monthly allowance is visible without adding
      // anything new to monitor. `programsLeft` is deliberately measured
      // against the dearest goal, so it is the number that cannot disappoint.
      budget: {
        month: budgetNow.month,
        charsUsed: budgetNow.chars,
        charsRemaining: remaining,
        charsBudget: MONTHLY_CHAR_BUDGET,
        programsLeft: Math.floor(remaining / dearest),
      },
      time: new Date().toISOString(),
    });
  }

  if (url === '/api/programs' && req.method === 'POST') {
    // Once a verified webhook can authorise a render, it is the only thing that
    // should. ACCESS_CODE is a shared, unrate-limited string that spends real
    // credits and whose value has been in a public git history since the first
    // commit (#32) — leaving it live beside a paid path means the paid path
    // guards nothing.
    if (STRIPE_WEBHOOK_SECRET) {
      return sendJson(res, 503, { error: 'rendering_requires_payment' });
    }
    if (!ACCESS_CODE) return sendJson(res, 503, { error: 'rendering_disabled' });
    const body = await readBody(req);
    if (body.accessCode !== ACCESS_CODE) return sendJson(res, 403, { error: 'bad_access_code' });
    if (!VALID_GOALS.has(body.goal)) return sendJson(res, 422, { error: 'goal_in_production' });
    if (!VALID_VOICE_SETS.has(body.voiceSet)) return sendJson(res, 422, { error: 'bad_voice_set' });
    const started = startRender(body.goal, body.voiceSet);
    if (started.error) return sendJson(res, started.status, started.body);
    return sendJson(res, 202, { jobId: started.jobId, state: 'rendering' });
  }

  if (url === '/api/stripe/webhook' && req.method === 'POST') {
    // Refuse rather than trust the body. An unconfigured webhook that accepted
    // events would be an open "render this for free" endpoint.
    if (!STRIPE_WEBHOOK_SECRET) {
      console.error('a webhook arrived but STRIPE_WEBHOOK_SECRET is not set');
      return sendJson(res, 503, { error: 'webhook_not_configured' });
    }
    const raw = await readRawBody(req);
    if (raw === null) return sendJson(res, 400, { error: 'bad_request' });
    if (!verifyStripeSignature(raw, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)) {
      console.warn('rejected a webhook with an invalid signature');
      return sendJson(res, 400, { error: 'bad_signature' });
    }

    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    if (!event || typeof event !== 'object') return sendJson(res, 400, { error: 'bad_request' });

    // 200 for everything we do not act on. Stripe sends whatever the endpoint
    // is subscribed to, and a non-2xx makes it retry for days.
    if (event.type !== 'checkout.session.completed') return sendJson(res, 200, { received: true });

    const session = (event.data && event.data.object) || {};
    // checkout.session.completed also fires for asynchronous payment methods
    // before the money has arrived.
    if (session.payment_status !== 'paid') {
      console.log('session', session.id, 'completed but is', session.payment_status, '- not rendering');
      return sendJson(res, 200, { received: true });
    }

    const sessionId = session.id;
    const meta = session.metadata || {};
    // The id becomes a filename. It arrives inside a verified payload, but a
    // path separator reaching writeFileSync is not something to leave to trust.
    if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)) {
      console.error('webhook: unusable session id', JSON.stringify(sessionId));
      return sendJson(res, 422, { error: 'bad_session' });
    }
    // Deliberately not 2xx: this is a paid order the studio cannot fulfil, and
    // it must show up as a failed delivery in the dashboard rather than vanish.
    if (!VALID_GOALS.has(meta.goal) || !VALID_VOICE_SETS.has(meta.voiceSet)) {
      console.error('webhook: PAID SESSION', sessionId, 'names no valid program:',
        JSON.stringify(meta), '- this order needs a human');
      return sendJson(res, 422, { error: 'bad_metadata' });
    }

    // Claim before rendering, so two concurrent deliveries cannot both start
    // one. The claim is written first and filled in after, because the atomic
    // create is the lock.
    const claimedAt = new Date();
    // The order, written once and spread into every state below. Three separate
    // object literals were three chances for one of them to forget a field —
    // and the field it would forget is the payment reference a refund needs.
    const order = {
      sessionId,
      goal: meta.goal,
      voiceSet: meta.voiceSet,
      ...paymentDetails(session),
      claimedAt: claimedAt.toISOString(),
    };
    const claimed = claimSession(sessionId, order);
    if (claimed === null) {
      // Could not write the claim. Failing loudly makes Stripe retry, which is
      // the only path back to rendering an order that has been paid for.
      return sendJson(res, 500, { error: 'storage_unavailable' });
    }
    if (claimed === false) {
      console.log('webhook: session', sessionId, 'already handled - not rendering again');
      return sendJson(res, 200, { received: true, duplicate: true });
    }

    const started = startRender(meta.goal, meta.voiceSet, sessionId);
    if (started.error) {
      // The claim STAYS, recording that this session was paid for and is still
      // owed a render. It carries no jobId, so it reads as recoverable: a
      // Stripe retry or a manual resend past RECLAIM_AFTER_MS renders it.
      writeClaim(sessionId, {
        ...order,
        lastError: started.error,
        lastErrorAt: new Date().toISOString(),
      });
      // A spent monthly allowance does not come back inside Stripe's ~3-day
      // retry window, so reporting it as transient means the delivery quietly
      // drops out of the queue with the order unfulfilled and nobody told.
      // 422 puts it in the dashboard as a permanent failure instead.
      if (started.error === 'budget_exhausted') {
        console.error('webhook: PAID SESSION', sessionId, 'cannot be rendered this month -',
          'the monthly allowance is spent. THIS ORDER NEEDS A HUMAN (refund or a raised budget).');
        return sendJson(res, 422, { error: started.error });
      }
      console.error('webhook: PAID SESSION', sessionId, 'could not start a render:',
        started.error, '- Stripe will retry');
      return sendJson(res, 500, { error: started.error });
    }
    // Record the job against the order now that there is one. The `wx` create
    // above was the lock; this is the content. #27 is what lets the customer
    // find it again.
    if (!writeClaim(sessionId, { ...order, jobId: started.jobId })) {
      // The render is running; only the link is lost. Not fatal, because the
      // job records the session itself — which is exactly why it does.
      console.error('could not link job', started.jobId, 'to session', sessionId,
        '- the job sidecar is the remaining record');
    }
    console.log('webhook: session', sessionId, 'started render', started.jobId);
    return sendJson(res, 200, { received: true, jobId: started.jobId });
  }

  if (url === '/api/checkout' && req.method === 'POST') {
    const body = await readBody(req);
    // Validate before anything leaves the box. An order that could never be
    // fulfilled must not become a payable session — the customer would be
    // holding a receipt for a program that does not exist. Same codes as
    // /api/programs, because it is the same rejection.
    if (!VALID_GOALS.has(body.goal)) return sendJson(res, 422, { error: 'goal_in_production' });
    if (!VALID_VOICE_SETS.has(body.voiceSet)) return sendJson(res, 422, { error: 'bad_voice_set' });
    // Both are required, and a half-configured checkout is refused rather than
    // half-attempted: without PUBLIC_BASE_URL there is nowhere to send the
    // customer back to, and finding that out after they have paid is the worst
    // moment to find it out.
    if (!STRIPE_SECRET_KEY || !PUBLIC_BASE_URL) {
      return sendJson(res, 503, { error: 'checkout_disabled' });
    }
    // Can this actually be rendered? Asked HERE and not at render start, which
    // is the whole of #25: the render begins from the webhook, so a refusal
    // there arrives after the money has been taken and costs a refund, a
    // support contact and a wasted partial spend.
    const problem = await capacityProblem(body.goal, body.voiceSet);
    if (problem) {
      console.warn('refusing checkout:', problem);
      return sendJson(res, 503, {
        error: 'temporarily_unavailable',
        detail: 'the studio cannot take a new program right now',
      });
    }
    // Last, so a rejected, unconfigured or unrenderable request never spends a
    // slot — the cap exists to bound calls to Stripe, and none of those reach
    // it.
    if (!checkoutRateOk()) {
      console.warn('checkout rate cap reached -', CHECKOUT_MAX_PER_MINUTE, 'per minute');
      return sendJson(res, 429, { error: 'rate_limited' });
    }
    // NOTE: the body is read for `goal` and `voiceSet` and nothing else. No
    // amount, price or currency from the request reaches Stripe — that is the
    // whole point of #22 and there is a test per field name.
    const session = await createCheckoutSession(body.goal, body.voiceSet);
    if (!session) return sendJson(res, 502, { error: 'checkout_unavailable' });
    return sendJson(res, 200, session);
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
    // What was bought, so a page that arrives knowing only the job id can
    // render itself (#27). Deliberately just the goal and voice set — the
    // sidecar holds nothing else, and the order (payment reference, email)
    // lives outside the job directory precisely so it cannot reach here.
    const meta = readJsonSafe(path.join(jobDir(id), 'job.json'));
    if (meta) {
      out.goal = meta.goal;
      out.voiceSet = meta.voiceSet;
    }
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
    releaseJob(d.name);
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

// Money the studio still owes back.
//
// The refund normally happens the moment a job is declared failed. This exists
// for the ways that attempt can be lost: a Stripe blip, or the process dying
// between claiming the refund and confirming it. Without it those become a
// customer who paid, received nothing, and is never refunded — the outcome the
// policy on /refunds explicitly rules out.
//
// Safe to re-attempt because the Idempotency-Key is keyed on the session, so
// every retry is the same request as far as Stripe is concerned.
function sweepOwedRefunds() {
  let names;
  try { names = fs.readdirSync(sessionsDir()); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const order = readJsonSafe(path.join(sessionsDir(), name));
    if (!order || !order.paymentIntent) continue;
    if (order.refund && order.refund.state === 'refunded') continue;

    let reason;
    if (order.refund) {
      // An attempt was made and did not stick.
      // Give up quietly after the cap. Each failed attempt already logged
      // NEEDS A HUMAN; repeating that every sixty seconds forever buries it.
      if ((order.refund.attempts || 0) >= REFUND_MAX_ATTEMPTS) continue;
      reason = order.refund.reason || 'the render failed';
    } else if (order.lastError && !order.jobId) {
      // Paid, but the render was REFUSED and never existed — a spent monthly
      // allowance, a full disk, a busy studio. No job means releaseJob never
      // ran, so nothing has refunded this and nothing will.
      //
      // `budget_exhausted` is answered 422, which Stripe does not retry at all,
      // so that order would sit paid and undelivered forever. The transient
      // ones are answered 500 and Stripe does retry — hence the grace window,
      // which is what separates "a retry is still coming" from "nobody is
      // going to fulfil this".
      //
      // ponytail: a fixed window rather than tracking Stripe's retry schedule.
      // The ceiling is that a retry arriving after it finds an order already
      // refunded — which claimIsRecoverable now refuses to render, so the
      // outcome is a refunded customer rather than a double delivery.
      const age = Date.now() - Date.parse(order.lastErrorAt || order.claimedAt || 0);
      if (!Number.isFinite(age) || age < REFUND_UNSTARTED_GRACE_MS) continue;
      reason = `the studio could not start the render (${order.lastError})`;
      console.error('PAID SESSION', order.sessionId, 'never rendered -', order.lastError,
        '- refunding it');
    } else {
      continue;
    }

    console.warn('refunding an owed order for session', order.sessionId);
    refundOrder(order.jobId || null, { reason, session: order.sessionId })
      .catch((e) => console.error('refund retry threw:', e && e.message));
  }
}

// Order matters: failing a stale job refreshes its updatedAt, so its retention
// clock starts from the terminal state rather than from when it hung.
function sweepJobs() {
  sweepStaleJobs();
  sweepOwedRefunds();
  sweepUndelivered();
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
