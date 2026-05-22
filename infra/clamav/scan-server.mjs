/**
 * F7.1a US2 — HTTP scan-wrapper in front of clamd (Option D).
 *
 * Why this exists: Fly.io's 6PN private network is IPv6-only and a
 * Vercel serverless function cannot join it, so the Chamber-OS app
 * cannot reach `clamav-swecham.internal:3310` directly. This tiny HTTP
 * server is exposed publicly via the Fly edge (HTTPS, force_https),
 * authenticates callers with a bearer token, and forwards the bytes to
 * clamd over localhost using the native INSTREAM wire protocol. clamd
 * itself stays bound to localhost only — never publicly exposed.
 *
 * Pure Node (`http` + `net` + `crypto`) — ZERO npm dependencies — so the
 * clamav/clamav:stable container needs only a Node runtime, no
 * `pnpm install`. See specs/014-email-broadcast-advance/clamav-vercel-connectivity.md.
 *
 * Endpoints:
 *   POST /scan      — Bearer-authed; body = raw bytes (≤ MAX_BYTES);
 *                     → 200 { verdict, signature?, durationMs }
 *   GET  /healthz   — clamd PING/PONG liveness (no auth); → 200 "ok" / 503
 *
 * Env (set as Fly secrets / app env):
 *   CLAMAV_SCAN_SECRET   bearer token (≥32 bytes) — REQUIRED
 *   CLAMD_HOST           default 127.0.0.1
 *   CLAMD_PORT           default 3310
 *   SCAN_SERVER_PORT     default 8080  (matches fly.toml internal_port)
 *   SCAN_MAX_BYTES       default 5767168 (5.5 MB — matches FR-012 cap)
 *   CLAMD_TIMEOUT_MS     default 50000
 */
import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';

const SECRET = process.env.CLAMAV_SCAN_SECRET ?? '';
const CLAMD_HOST = process.env.CLAMD_HOST ?? '127.0.0.1';
const CLAMD_PORT = Number(process.env.CLAMD_PORT ?? '3310');
const PORT = Number(process.env.SCAN_SERVER_PORT ?? '8080');
const MAX_BYTES = Number(process.env.SCAN_MAX_BYTES ?? String(5.5 * 1024 * 1024));
const CLAMD_TIMEOUT_MS = Number(process.env.CLAMD_TIMEOUT_MS ?? '50000');

if (SECRET.length < 32) {
  console.error(
    '[scan-server] FATAL: CLAMAV_SCAN_SECRET missing or <32 bytes — refusing to start.',
  );
  process.exit(1);
}
const SECRET_BUF = Buffer.from(SECRET, 'utf8');

/** Constant-time bearer compare. Returns false on any length/format mismatch. */
function bearerOk(header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const tokenBuf = Buffer.from(header.slice('Bearer '.length), 'utf8');
  if (tokenBuf.length !== SECRET_BUF.length) return false;
  return timingSafeEqual(tokenBuf, SECRET_BUF);
}

/**
 * Scan a Buffer via clamd INSTREAM over a fresh TCP socket.
 * Protocol: `nINSTREAM\n` → repeated `<uint32 BE len><chunk>` → `<uint32 0>`
 * → clamd replies `stream: OK\0` (clean) or `stream: <SIG> FOUND\0`.
 * Resolves a { verdict, signature?, durationMs } object — never rejects;
 * all failures map to a fail-closed verdict.
 */
function clamdScan(bytes) {
  const start = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* already closed */
      }
      resolve({ ...v, durationMs: Date.now() - start });
    };

    const sock = net.connect(CLAMD_PORT, CLAMD_HOST);
    let reply = '';

    sock.setTimeout(CLAMD_TIMEOUT_MS, () => done({ verdict: 'timeout' }));
    sock.on('error', (err) =>
      done({ verdict: 'error', reason: 'unreachable', detail: err.code ?? err.message }),
    );
    sock.on('data', (d) => {
      reply += d.toString('utf8');
    });
    sock.on('end', () => {
      const text = reply.replace(/\0/g, '').trim();
      if (/\bOK$/.test(text)) return done({ verdict: 'clean' });
      const found = text.match(/stream:\s+(.+)\s+FOUND/);
      if (found) return done({ verdict: 'infected', signature: found[1] });
      done({ verdict: 'error', reason: 'daemon_error', detail: text.slice(0, 200) || 'empty_reply' });
    });

    sock.on('connect', () => {
      sock.write('nINSTREAM\n');
      // chunk the payload in ≤64 KB frames (clamd StreamMaxLength friendly)
      const CHUNK = 64 * 1024;
      for (let off = 0; off < bytes.length; off += CHUNK) {
        const slice = bytes.subarray(off, Math.min(off + CHUNK, bytes.length));
        const len = Buffer.allocUnsafe(4);
        len.writeUInt32BE(slice.length, 0);
        sock.write(len);
        sock.write(slice);
      }
      const term = Buffer.allocUnsafe(4);
      term.writeUInt32BE(0, 0);
      sock.write(term);
    });
  });
}

/** clamd PING/PONG over a fresh socket for /healthz. */
function clamdPing() {
  return new Promise((resolve) => {
    const sock = net.connect(CLAMD_PORT, CLAMD_HOST);
    let reply = '';
    sock.setTimeout(5000, () => {
      sock.destroy();
      resolve(false);
    });
    sock.on('error', () => resolve(false));
    sock.on('data', (d) => {
      reply += d.toString('utf8');
    });
    sock.on('connect', () => sock.write('nPING\n'));
    sock.on('end', () => resolve(reply.replace(/\0/g, '').trim() === 'PONG'));
    sock.on('close', () => resolve(reply.includes('PONG')));
  });
}

function send(res, status, bodyObj) {
  const body = JSON.stringify(bodyObj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    clamdPing().then((ok) =>
      ok ? res.writeHead(200).end('ok') : res.writeHead(503).end('clamd unreachable'),
    );
    return;
  }

  if (req.method !== 'POST' || req.url !== '/scan') {
    send(res, 404, { verdict: 'error', reason: 'not_found' });
    return;
  }

  if (!bearerOk(req.headers.authorization)) {
    send(res, 401, { verdict: 'error', reason: 'unauthorized' });
    return;
  }

  const chunks = [];
  let total = 0;
  let aborted = false;
  req.on('data', (c) => {
    if (aborted) return;
    total += c.length;
    if (total > MAX_BYTES) {
      aborted = true;
      send(res, 413, { verdict: 'error', reason: 'payload_too_large' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    clamdScan(Buffer.concat(chunks)).then((v) => send(res, 200, v));
  });
  req.on('error', () => {
    if (!aborted) send(res, 400, { verdict: 'error', reason: 'request_error' });
  });
});

server.listen(PORT, () => {
  console.log(
    `[scan-server] listening on :${PORT} → clamd ${CLAMD_HOST}:${CLAMD_PORT} (max ${MAX_BYTES}B, timeout ${CLAMD_TIMEOUT_MS}ms)`,
  );
});
