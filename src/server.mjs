// Bouncer HTTP server. Two audiences on one port:
//   /gate/*  the Claude Code hooks: loopback only, gate token required
//   /api/*   the human approver: paired-device session cookie, CSRF token, same-origin POSTs
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { AuditLog, verify } from './audit.mjs';
import { Store } from './store.mjs';

const PUBLIC = new URL('../public/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const SESSION_MS = 12 * 3600 * 1000;
const PAIR_MS = 10 * 60 * 1000;
const MAX_BODY = 256 * 1024;

const token = () => randomBytes(32).toString('base64url');
const safeEq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

export function loadGateToken(homeDir) {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const p = join(homeDir, 'gate.token');
  if (!existsSync(p)) writeFileSync(p, token(), { mode: 0o600 });
  chmodSync(p, 0o600);
  return readFileSync(p, 'utf8').trim();
}

function deviceLabel(ua = '') {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh/.test(ua)) return 'Mac browser';
  return 'Browser';
}

export function createBouncer({ dataDir, homeDir, policy, port = 7788, hosts = ['127.0.0.1'], now = () => new Date() }) {
  const audit = new AuditLog(join(dataDir, 'audit.jsonl'), now);
  const store = new Store(audit, policy, now);
  const gateToken = loadGateToken(homeDir);
  const sessions = new Map(); // sid -> { csrf, label, expires } (memory only: a restart means re-pairing)
  const pairCodes = new Map(); // code -> expires
  const allowedHosts = new Set();
  const setHosts = (p) => { allowedHosts.clear(); for (const h of [...hosts, 'localhost']) allowedHosts.add(`${h}:${p}`); };
  setHosts(port);

  const issuePairCode = () => { const c = token(); pairCodes.set(c, Date.now() + PAIR_MS); return c; };
  // Short codes for typing on a phone: 8 chars from 32 unambiguous symbols (40 bits), single use, 10 min.
  // Guessing is capped: 5 failed pair attempts cancel every outstanding code.
  const SHORT = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const issueShortPairCode = () => {
    const raw = [...randomBytes(8)].map((b) => SHORT[b & 31]).join('');
    pairCodes.set(raw, Date.now() + PAIR_MS);
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  };
  let pairFailures = 0;

  const tick = setInterval(() => store.expireDue(), 1000);
  tick.unref();

  const send = (res, code, body, headers = {}) => {
    const isJson = typeof body !== 'string';
    res.writeHead(code, { 'content-type': isJson ? 'application/json' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(isJson ? JSON.stringify(body) : body);
  };

  const readJson = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });

  const session = (req) => {
    const sid = /(?:^|;\s*)bouncer_sid=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '')?.[1];
    const s = sid && sessions.get(sid);
    if (!s) return null;
    if (s.expires < Date.now()) { sessions.delete(sid); return null; }
    return { sid, ...s };
  };

  const publicRequest = (r) => ({
    id: r.id, createdAt: r.createdAt, toolName: r.toolName, toolInput: r.toolInput, hash: r.hash, status: r.status,
    policy: r.policy, expiresAt: r.expiresAt, decision: r.decision, releasedAt: r.releasedAt, result: r.result,
    expiredReason: r.expiredReason, events: r.events,
  });

  // Independent checks recorded by a person after the fact (for example, the email is in the recipient's inbox).
  // They live outside the hash chain and never change a request's lifecycle; the dashboard labels them as such.
  const verifications = () => {
    try {
      const raw = JSON.parse(readFileSync(join(dataDir, 'verifications.json'), 'utf8'));
      const out = {};
      for (const [id, v] of Object.entries(raw)) {
        if (!store.requests.has(id) || !v || typeof v !== 'object') continue;
        if (!['confirmed', 'not-found'].includes(v.outcome)) continue;
        const str = (x) => (typeof x === 'string' ? x.slice(0, 500) : null);
        if (!str(v.by) || !str(v.method) || !str(v.checkedAt)) continue;
        out[id] = { outcome: v.outcome, by: str(v.by), method: str(v.method), checkedAt: str(v.checkedAt), detail: str(v.detail) };
      }
      return out;
    } catch { return {}; }
  };

  const stats = () => {
    const all = [...store.requests.values()];
    const by = (f) => all.filter(f).length;
    return {
      protected: all.length,
      pending: by((r) => r.status === 'pending'),
      approved: by((r) => r.decision?.decision === 'approved'),
      autoAllowed: by((r) => r.policy?.effect === 'allow'),
      blocked: by((r) => ['denied', 'rejected', 'expired'].includes(r.status)),
      failed: by((r) => r.status === 'failed'),
    };
  };

  async function gateRoute(req, res, url) {
    if (!isLoopback(req.socket.remoteAddress)) return send(res, 403, { error: 'gate API is loopback only' });
    if (!safeEq(req.headers['x-bouncer-gate'], gateToken)) return send(res, 401, { error: 'bad gate token' });
    const m = url.pathname.match(/^\/gate\/requests\/(req_[0-9a-f]{12})(\/release|\/abandon)?$/);
    if (req.method === 'GET' && url.pathname === '/gate/health') return send(res, 200, { ok: true, auditHead: audit.head });
    if (req.method === 'POST' && url.pathname === '/gate/requests') {
      const b = await readJson(req);
      if (typeof b.toolName !== 'string') return send(res, 400, { error: 'toolName required' });
      const r = store.submit(b);
      return send(res, 200, { id: r.id, status: r.status, hash: r.hash, expiresAt: r.expiresAt, ...r.policy });
    }
    if (m && req.method === 'GET' && !m[2]) {
      const id = m[1];
      if (!store.requests.has(id)) return send(res, 404, { error: 'unknown request' });
      const wait = Math.min(Number(url.searchParams.get('wait')) || 0, 25) * 1000;
      const reply = () => send(res, 200, { id, status: store.requests.get(id).status });
      if (store.requests.get(id).status !== 'pending' || !wait) return reply();
      let done = false;
      const finish = () => { if (done) return; done = true; store.off('change', onChange); clearTimeout(t); reply(); };
      const onChange = (e) => { if (e.requestId === id && store.requests.get(id).status !== 'pending') finish(); };
      const t = setTimeout(finish, wait);
      store.on('change', onChange);
      req.on('close', () => { if (!done) { done = true; store.off('change', onChange); clearTimeout(t); } });
      return;
    }
    if (m && req.method === 'POST' && m[2] === '/release') {
      const b = await readJson(req);
      const out = store.release(m[1], b.hash);
      return send(res, out.ok ? 200 : 409, out);
    }
    if (m && req.method === 'POST' && m[2] === '/abandon') {
      const b = await readJson(req);
      store.abandon(m[1], String(b.reason || 'The hook gave up waiting and blocked the call.').slice(0, 300));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/gate/results') {
      store.result(await readJson(req));
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  }

  async function apiRoute(req, res, url) {
    const s = session(req);
    if (!s) return send(res, 401, { error: 'This device is not paired. Open a pairing link from the Bouncer terminal.' });
    if (req.method === 'POST') {
      // Same-origin only, and the CSRF token from /api/state must come back in a header.
      if (req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'cross-origin request refused' });
      if (!safeEq(req.headers['x-csrf-token'], s.csrf)) return send(res, 403, { error: 'missing or wrong CSRF token' });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      store.expireDue();
      const requests = [...store.requests.values()].reverse().slice(0, 200).map(publicRequest);
      const chain = verify(audit.path);
      return send(res, 200, { me: { label: s.label }, csrf: s.csrf, stats: stats(), requests, policy: { self: policy.self, trusted: policy.trusted, holdTimeoutSeconds: policy.holdTimeoutSeconds },
        chain: { ok: chain.ok, count: chain.count, head: chain.head, line: chain.line, reason: chain.reason }, verifications: verifications(), serverTime: now().toISOString() });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      const onChange = (e) => res.write(`data: ${JSON.stringify({ seq: e.seq, type: e.type, requestId: e.requestId })}\n\n`);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      store.on('change', onChange);
      req.on('close', () => { store.off('change', onChange); clearInterval(ping); });
      return;
    }
    const m = url.pathname.match(/^\/api\/requests\/(req_[0-9a-f]{12})\/decision$/);
    if (m && req.method === 'POST') {
      const b = await readJson(req);
      if (!['approve', 'reject'].includes(b.decision)) return send(res, 400, { error: 'decision must be approve or reject' });
      const out = store.decide(m[1], b.decision === 'approve' ? 'approved' : 'rejected', b.hash, s.label);
      return send(res, out.ok ? 200 : out.code, out);
    }
    if (req.method === 'POST' && url.pathname === '/api/pair-codes') {
      const code = issuePairCode();
      store.record('device.pair_code_issued', null, { by: s.label });
      const links = hosts.map((h) => ({ label: isLoopback(h) ? 'This Mac' : 'iPhone or other device (Tailscale on)', url: `http://${h}:${port}/pair/${code}` }));
      return send(res, 200, { links, expiresInSeconds: PAIR_MS / 1000 });
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      sessions.delete(s.sid);
      return send(res, 200, { ok: true }, { 'set-cookie': 'bouncer_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict' });
    }
    return send(res, 404, { error: 'not found' });
  }

  function pairRoute(req, res, code) {
    const exp = pairCodes.get(code);
    pairCodes.delete(code); // single use, even when it fails
    if (!exp || exp < Date.now()) {
      pairFailures++;
      const lockout = pairFailures >= 5;
      if (lockout) { pairCodes.clear(); pairFailures = 0; }
      store.record('device.pair_refused', null, { reason: exp ? 'expired code' : 'unknown or used code', allCodesCancelled: lockout });
      return send(res, 403, 'This pairing link is invalid, used or expired. Ask the Bouncer terminal for a new one.');
    }
    const sid = token();
    const label = deviceLabel(req.headers['user-agent']);
    sessions.set(sid, { csrf: token(), label, expires: Date.now() + SESSION_MS });
    store.record('device.paired', null, { label, remote: isLoopback(req.socket.remoteAddress) ? 'loopback' : 'tailnet' });
    res.writeHead(303, { location: '/', 'set-cookie': `bouncer_sid=${sid}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; SameSite=Strict`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end();
  }

  function staticRoute(req, res, url) {
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!/^[a-z0-9-]+\.(html|css|js|svg)$/.test(name) || !existsSync(join(PUBLIC, name))) return send(res, 404, 'not found');
    res.writeHead(200, {
      'content-type': TYPES[extname(name)], 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(readFileSync(join(PUBLIC, name)));
  }

  async function handle(req, res) {
    // Host allowlist blocks DNS-rebinding pages from talking to the local server.
    if (!allowedHosts.has(req.headers.host)) return send(res, 421, 'unknown host');
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith('/gate/')) return await gateRoute(req, res, url);
      if (url.pathname.startsWith('/api/')) return await apiRoute(req, res, url);
      const pm = url.pathname.match(/^\/pair\/([A-Za-z0-9_-]{43})$/);
      if (pm && req.method === 'GET') return pairRoute(req, res, pm[1]);
      const sm = url.pathname.match(/^\/p\/([A-Za-z0-9]{4})-?([A-Za-z0-9]{4})$/);
      if (sm && req.method === 'GET') return pairRoute(req, res, (sm[1] + sm[2]).toUpperCase());
      if (req.method === 'GET') return staticRoute(req, res, url);
      return send(res, 405, 'method not allowed');
    } catch (err) {
      // Any failure, including an audit write failure, is a 5xx; the gate treats that as a block.
      if (!res.headersSent) send(res, 500, { error: err.message });
      else res.end();
    }
  }

  const servers = [];
  return {
    store, audit, gateToken, issuePairCode, issueShortPairCode,
    async listen() {
      for (const host of hosts) {
        const srv = http.createServer(handle);
        await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, host, resolve); });
        if (port === 0) { port = srv.address().port; setHosts(port); }
        servers.push(srv);
      }
      return port;
    },
    async close() {
      clearInterval(tick);
      await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); })));
    },
  };
}
