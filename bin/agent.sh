#!/bin/zsh
# Start the demo agent: a Claude Code session with Fo available (Fo is local-scoped to /Users/rello)
# and every mcp__fo__* call routed through Bouncer. Refuses to start unless `bouncer doctor` passes.
node /Users/rello/dev/bouncer/bin/bouncer.mjs doctor || { echo "\nBouncer doctor failed: not starting the agent."; exit 1; }
cd /Users/rello || exit 1
exec claude --permission-mode default --settings /Users/rello/dev/bouncer/hooks/claude-settings.json "$@"
