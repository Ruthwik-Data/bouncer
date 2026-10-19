// Hook-enforcement probe. Logs the exact PreToolUse payload, then behaves per mode.
import { appendFileSync, readFileSync } from 'node:fs';
const mode = process.argv[2];
const log = new URL('./out/hook-calls.jsonl', import.meta.url);
const input = readFileSync(0, 'utf8');
appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), mode, payload: JSON.parse(input) }) + '\n');
const deny = (reason) => console.log(JSON.stringify({ hookSpecificOutput: {
  hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
switch (mode) {
  case 'deny': deny('BOUNCER_PROBE_DENY'); break;
  case 'sentinel': deny('BOUNCER_SENTINEL_DENY'); break;
  case 'exit2': process.stderr.write('BOUNCER_PROBE_EXIT2'); process.exit(2);
  case 'crash': throw new Error('BOUNCER_PROBE_CRASH');
  case 'garbage': console.log('this is not json {'); break;
  case 'deadline': setTimeout(() => { process.stderr.write('BOUNCER_PROBE_DEADLINE'); process.exit(2); }, 2000); setTimeout(() => {}, 30000); break;
  case 'hang': setTimeout(() => {}, 30000); break;
  default: process.exit(1);
}
