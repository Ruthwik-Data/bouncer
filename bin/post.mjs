#!/usr/bin/env node
// PostToolUse / PostToolUseFailure hook: records what Fo reported. The call already happened, so
// this hook never blocks; if recording fails it says so on stderr and the audit shows no result.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BOUNCER_URL || 'http://127.0.0.1:7788';
const HOME = process.env.BOUNCER_HOME || join(homedir(), '.config', 'bouncer');

try {
  const p = JSON.parse(readFileSync(0, 'utf8'));
  const token = readFileSync(join(HOME, 'gate.token'), 'utf8').trim();
  const res = await fetch(`${BASE}/gate/results`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bouncer-gate': token },
    body: JSON.stringify({ toolUseId: p.tool_use_id, event: p.hook_event_name, response: p.tool_response, error: p.error }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) process.stderr.write(`Bouncer could not record the Fo result (HTTP ${res.status}).`);
} catch (e) {
  process.stderr.write(`Bouncer could not record the Fo result (${e.message}).`);
}
process.exit(0);
