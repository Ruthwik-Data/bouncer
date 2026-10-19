#!/usr/bin/env node
// bouncer serve | verify | trace [--json] | stats | doctor
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readEntries, verify } from '../src/audit.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const DATA = process.env.BOUNCER_DATA || join(ROOT, 'data');
const HOME = process.env.BOUNCER_HOME || join(homedir(), '.config', 'bouncer');
const PORT = Number(process.env.BOUNCER_PORT) || 7788;
const AUDIT = join(DATA, 'audit.jsonl');
const SETTINGS = join(ROOT, 'hooks', 'claude-settings.json');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function tailnetIp() {
  if (process.env.BOUNCER_NO_TAILNET === '1') return null;
  for (const bin of ['/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    try {
      const ip = execFileSync(bin, ['ip', '-4'], { encoding: 'utf8', timeout: 3000 }).trim().split('\n')[0];
      if (/^100\.\d+\.\d+\.\d+$/.test(ip)) return ip; // CGNAT range only: never a public or LAN interface
    } catch {}
  }
  return null;
}

// Rebuild request outcomes straight from the log, so trace/stats don't depend on the server.
function outcomes() {
  const reqs = new Map();
  for (const e of readEntries(AUDIT)) {
    if (!e.requestId) continue;
    if (e.type === 'request.received') reqs.set(e.requestId, { id: e.requestId, at: e.ts, tool: e.data.toolName, input: e.data.toolInput, hash: e.data.hash, steps: [] });
    const r = reqs.get(e.requestId);
    if (!r) continue;
    r.steps.push(e);
    if (e.type === 'policy.decided') { r.policy = e.data; r.status = { allow: 'allowed', deny: 'denied', hold: 'pending' }[e.data.effect]; }
    if (e.type === 'approval.decided') { r.status = e.data.decision; r.by = e.data.by; }
    if (e.type === 'request.expired') r.status = 'expired';
    if (e.type === 'release.granted') r.status = 'released';
    if (e.type === 'result.recorded') { r.status = e.data.ok ? 'completed' : 'failed'; r.result = e.data; }
  }
  return [...reqs.values()];
}

function counts(rs) {
  const c = (f) => rs.filter(f).length;
  return {
    total: rs.length,
    autoAllowed: c((r) => r.policy?.effect === 'allow'),
    held: c((r) => r.policy?.effect === 'hold'),
    approved: c((r) => r.by && r.steps.some((s) => s.type === 'approval.decided' && s.data.decision === 'approved')),
    rejected: c((r) => r.steps.some((s) => s.type === 'approval.decided' && s.data.decision === 'rejected')),
    denied: c((r) => r.policy?.effect === 'deny'),
    expired: c((r) => r.status === 'expired'),
    reachedFo: c((r) => r.steps.some((s) => s.type === 'release.granted')),
    foCompleted: c((r) => r.status === 'completed'),
    failed: c((r) => r.status === 'failed'),
  };
}

const cmd = process.argv[2];

if (cmd === 'serve') {
  const { createBouncer } = await import('../src/server.mjs');
  const ip = tailnetIp();
  const hosts = ['127.0.0.1', ...(ip ? [ip] : [])];
  const b = createBouncer({ dataDir: DATA, homeDir: HOME, policy: readJson(join(ROOT, existsSync(join(ROOT, 'policy.local.json')) ? 'policy.local.json' : 'policy.json')), port: PORT, hosts });
  await b.listen();
  console.log(`Bouncer listening on ${hosts.map((h) => `http://${h}:${PORT}`).join(' and ')}`);
  console.log(`Audit log: ${AUDIT} (${b.audit.seq} entries, head ${b.audit.head.slice(0, 12)})`);
  console.log('\nPairing links (single use, valid 10 minutes). Open one per device:');
  console.log(`  This Mac:  http://127.0.0.1:${PORT}/pair/${b.issuePairCode()}`);
  if (ip) {
    console.log(`  iPhone:    http://${ip}:${PORT}/pair/${b.issuePairCode()}   (Tailscale on)`);
    console.log(`  or type:   http://${ip}:${PORT}/p/${b.issueShortPairCode()}`);
  }
  else console.log('  Tailscale not detected: phone access is off. Only this Mac can approve.');
  console.log('\nMore links: "Pair a device" on the dashboard. Ctrl+C stops Bouncer, and every Fo call is then blocked.');
  const stop = async () => { await b.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else if (cmd === 'verify') {
  const v = verify(AUDIT);
  if (v.ok) console.log(`OK: ${v.count} entries, hash chain intact. Head ${v.head}`);
  else console.log(`TAMPERED: line ${v.line}: ${v.reason}`);
  process.exit(v.ok ? 0 : 1);
} else if (cmd === 'stats') {
  console.log(JSON.stringify(counts(outcomes()), null, 2));
} else if (cmd === 'trace') {
  const rs = outcomes();
  const v = verify(AUDIT);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ chain: v, counts: counts(rs), requests: rs }, null, 2));
  } else {
    const c = counts(rs);
    console.log(`# Bouncer run trace\n\nAudit chain: ${v.ok ? 'intact' : `BROKEN at line ${v.line}`}, ${v.count} entries, head \`${v.head?.slice(0, 16)}\`\n`);
    console.log(`Run counts: ${c.total} Fo calls gated · ${c.autoAllowed} auto-allowed · ${c.held} held for a human (${c.approved} approved, ${c.rejected} rejected, ${c.expired} expired) · ${c.denied} denied by policy · ${c.reachedFo} reached Fo · ${c.foCompleted} returned a result · ${c.failed} failed\n`);
    for (const r of rs) {
      const msg = r.input?.message ? `“${r.input.message.replace(/\s+/g, ' ').slice(0, 140)}”` : JSON.stringify(r.input);
      console.log(`## ${r.id} · ${r.tool.replace('mcp__fo__', '')} · ${r.status}\n${msg}`);
      for (const s of r.steps) {
        const fmt = {
          'request.received': (d) => `received (hash ${d.hash?.slice(0, 12)})`,
          'policy.decided': (d) => `policy ${d.effect.toUpperCase()}: ${d.rule}. ${d.reason}`,
          'approval.decided': (d) => `${d.decision} by ${d.by}`,
          'approval.refused': (d) => `decision refused (${d.reason})`,
          'release.granted': (d) => `released to Fo (${d.via})`,
          'release.refused': (d) => `release refused (${d.reason})`,
          'request.expired': (d) => `expired: ${d.reason}`,
          'result.recorded': (d) => `${d.ok ? 'returned' : 'FAILED'}; Fo-reported status: ${d.foStatus ?? 'none given'}${d.conversationId ? ` · conversation ${d.conversationId}` : ''}${d.error ? ` · error: ${d.error}` : ''}`,
        }[s.type];
        const what = fmt ? fmt(s.data) : s.type;
        console.log(`- ${s.ts} #${s.seq} ${what}`);
      }
      console.log('');
    }
  }
} else if (cmd === 'doctor') {
  let bad = 0;
  const check = (ok, label, hint = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !hint ? '' : `\n      → ${hint}`}`); if (!ok) bad++; };
  let s = null;
  try { s = readJson(SETTINGS); } catch (e) { check(false, `hooks settings parse (${SETTINGS})`, e.message); }
  if (s) {
    const pre = s.hooks?.PreToolUse?.find((h) => h.matcher === 'mcp__fo__.*');
    const hook = pre?.hooks?.[0];
    check(!!hook, 'PreToolUse hook on mcp__fo__.*');
    check(/\|\| exit 2$/.test(hook?.command ?? ''), 'gate command is wrapped with "|| exit 2" (crash or missing file = block)');
    check(existsSync(join(ROOT, 'bin', 'gate.mjs')), 'gate script exists');
    check((hook?.timeout ?? 0) >= 300, 'hook timeout ≥ 300s, above the gate’s own 280s deadline');
    check(!!s.hooks?.PostToolUse && !!s.hooks?.PostToolUseFailure, 'result hooks registered');
    const deny = s.permissions?.deny ?? [];
    // Deny beats allow from every settings source, so this neutralises broad Bash allow rules elsewhere.
    check(['Bash', 'Write', 'Edit'].every((t) => deny.includes(t)), 'demo agent has no Bash, Write or Edit (it can only reach Fo through the gate)',
      'add "Bash", "Write" and "Edit" to permissions.deny in hooks/claude-settings.json');
  }
  const allowLists = [];
  for (const p of [join(homedir(), '.claude', 'settings.json'), join(homedir(), '.claude', 'settings.local.json')]) {
    try { allowLists.push([p, readJson(p).permissions?.allow ?? [], readJson(p).permissions?.defaultMode]); } catch {}
  }
  try { allowLists.push(['~/.claude.json (/Users/rello)', readJson(join(homedir(), '.claude.json')).projects?.[homedir()]?.allowedTools ?? [], undefined]); } catch {}
  for (const [p, allow, mode] of allowLists) {
    check(!allow.some((a) => /mcp__fo/.test(a)), `no Fo tools allow-listed in ${p}`, 'remove them: the permission prompt is the backstop if the hook config breaks');
    check(!['bypassPermissions', 'auto', 'acceptEdits'].includes(mode), `default permission mode is safe in ${p}`);
  }
  const v = verify(AUDIT);
  check(v.ok, `audit chain intact (${v.count} entries)`, v.reason);
  try {
    const token = readFileSync(join(HOME, 'gate.token'), 'utf8').trim();
    const res = await fetch(`http://127.0.0.1:${PORT}/gate/health`, { headers: { 'x-bouncer-gate': token }, signal: AbortSignal.timeout(2000) });
    check(res.ok, 'Bouncer server is running and accepts the gate token');
  } catch (e) {
    check(false, 'Bouncer server is running', 'start it with `npm start` (until then every Fo call is blocked)');
  }
  console.log(bad ? `\n${bad} problem(s).` : '\nAll checks passed.');
  process.exit(bad ? 1 : 0);
} else {
  console.log('usage: bouncer serve | verify | trace [--json] | stats | doctor');
  process.exit(cmd ? 1 : 0);
}
