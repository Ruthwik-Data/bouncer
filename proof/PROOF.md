# Bouncer hook enforcement proof — 2026-10-18 04:26–04:45 UTC

Result: **PASS, with conditions** (see Fail-closed design).
Claude Code 2.1.302. Each test is a nested `claude -p --model haiku --permission-mode default --settings <test hooks>`, run from /Users/rello (fo is local-scoped there). Each test told the model to call `ask_fo` once with a no-op message and `newConversation: true`.
Raw evidence: `out/*.stream.jsonl` (full transcripts), `out/*.settings.json`, `out/hook-calls.jsonl` (exact hook payloads).

## Exact tool identity (from hook payload, not assumed)
- `tool_name`: `mcp__fo__ask_fo`
- `tool_input`: `{"message": "...", "newConversation": true}` (schema: message required; conversationId, newConversation optional)
- `mcp_server`: `{"name": "fo", "source": "local"}`
- Matchers `mcp__fo__ask_fo` (exact) and `mcp__fo__.*` (regex) both fire.

## Results
| Test | Hook behavior | Outcome | Blocked by |
|---|---|---|---|
| t1 | JSON permissionDecision=deny | rejected | **hook** |
| t8 | deny, regex matcher | rejected | **hook** |
| r2 | exit 2 | rejected | **hook** |
| r3 | uncaught crash (exit 1) | **FAILS OPEN** → fell to permission layer | config backstop only |
| r4 | exit 0, non-JSON stdout | **FAILS OPEN** | config backstop only |
| r5 | hang past 3s hook timeout | **FAILS OPEN** | config backstop only |
| r6 | crash, wrapped `\|\| exit 2` | rejected | **hook** |
| r7 | missing script, wrapped `\|\| exit 2` | rejected | **hook** |
| r8 | waits for approval, self-deny at 2s (< 5s timeout), wrapped | rejected | **hook** |
| t6/t7 (accidental) | invalid settings JSON → no hooks loaded | rejected | config backstop only |
| bash/bypassPermissions | deny | rejected | **hook** (deny holds) |
| bash/auto | deny | rejected | **hook** (deny holds) |

Fo side, before and after: 3 conversations, latest thread 3 turns. **No ask_fo reached Fo.** No email sent.

## Fail-closed design (required, derived from r3–r5)
1. Wrap the hook command as `node gate.mjs || exit 2`. Any crash or missing file then blocks.
2. The gate allows **only** by printing the exact allow JSON and exiting 0. Every other path exits 2. Never print stray stdout (r4).
3. The gate sets an internal deadline below the configured hook timeout (for example, 240s inside 300s) and exits 2 when it fires. A hook killed by Claude Code fails open (r5).
4. Backstop: never allow-list `mcp__fo__*`. If the hook is missing or invalid, `-p` rejects the call, and an interactive session falls back to a human prompt.
   - Residual: in auto or bypass mode with a broken or missing hook config, nothing blocks. Run the Bouncer session in `default` mode, and have the gate self-check at startup. (Done: `bin/agent.sh` runs `bouncer doctor` and refuses to start the agent if it fails.)
5. Logging failure: the gate writes the "request" audit entry before deciding. If that write throws, exit 2.
