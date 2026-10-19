#!/usr/bin/env node
// PreToolUse gate for mcp__fo__*. Fail-closed contract, derived from proof/PROOF.md:
//  - allow ONLY by printing the exact allow JSON and exiting 0, after the server granted release
//  - every other path (server down, crash, deny, reject, expiry, deadline) exits 2
//  - nothing else ever goes to stdout (stray stdout fails open, test r4)
//  - own deadline below the hook timeout (a hook killed by Claude Code fails open, test r5)
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { requestHash } from '../src/policy.mjs';

const BASE = process.env.BOUNCER_URL || 'http://127.0.0.1:7788';
const HOME = process.env.BOUNCER_HOME || join(homedir(), '.config', 'bouncer');
const DEADLINE_MS = Number(process.env.BOUNCER_GATE_DEADLINE_MS) || 280_000; // hook timeout is 300s

let finished = false;
let deadlineHit = false;
function block(reason) {
  if (finished) return;
  finished = true;
  if (deadlineHit) reason = 'no decision before the hook deadline';
  process.stderr.write(`Bouncer blocked this Fo call: ${reason}`);
  process.exit(2);
}
process.on('uncaughtException', (e) => block(`gate error (${e.message})`));
process.on('unhandledRejection', (e) => block(`gate error (${e?.message ?? e})`));

let requestId = null;
let gateToken = null;
setTimeout(async () => {
  deadlineHit = true;
  if (requestId) await call('POST', `/gate/requests/${requestId}/abandon`, { reason: 'The hook reached its deadline without a decision.' }, 1000).catch(() => {});
  block('no decision before the hook deadline');
}, DEADLINE_MS);

async function call(method, path, body, timeoutMs = 30_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-bouncer-gate': gateToken },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function main() {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  try { gateToken = readFileSync(join(HOME, 'gate.token'), 'utf8').trim(); } catch { return block('Bouncer is not set up (no gate token). Start it with `npm start` in ~/dev/bouncer.'); }

  const toolName = payload.tool_name;
  const toolInput = payload.tool_input ?? {};
  const hash = requestHash(toolName, toolInput);

  let sub;
  try {
    sub = await call('POST', '/gate/requests', { toolName, toolInput, toolUseId: payload.tool_use_id, sessionId: payload.session_id });
  } catch (e) {
    return block(`the Bouncer server is unreachable at ${BASE} (${e.cause?.code ?? e.message}). Nothing reaches Fo while it is down.`);
  }
  if (sub.status !== 200) return block(`the Bouncer server refused the request (HTTP ${sub.status}: ${sub.json.error ?? 'no detail'}).`);
  const r = sub.json;
  requestId = r.id;
  if (r.hash !== hash) return block('the server evaluated a different call than this one (hash mismatch).');

  if (r.effect === 'deny') return block(`${r.rule}. ${r.reason} [${r.id}]`);
  if (r.effect === 'hold') {
    let state = r.status;
    while (state === 'pending') {
      const p = await call('GET', `/gate/requests/${r.id}?wait=20`);
      if (p.status !== 200) return block(`lost track of the approval (HTTP ${p.status}).`);
      state = p.json.status;
    }
    if (state === 'rejected') return block(`a human rejected it on the approval page. [${r.id}]`);
    if (state !== 'approved') return block(`the approval ended as "${state}". [${r.id}]`);
  } else if (r.effect !== 'allow') {
    return block(`unknown policy effect "${r.effect}".`);
  }

  // One-time release: the server flips the request to released exactly once, for exactly this hash.
  const rel = await call('POST', `/gate/requests/${r.id}/release`, { hash });
  if (rel.status !== 200 || rel.json.ok !== true) return block(`release refused (${rel.json.reason ?? rel.status}). [${r.id}]`);

  finished = true;
  const why = r.effect === 'allow' ? `policy: ${r.rule}` : 'approved by a human';
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: `Bouncer ${why} [${r.id}]` } }));
  process.exit(0);
}

main().catch((e) => block(`gate error (${e.message})`));
