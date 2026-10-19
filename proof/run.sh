#!/bin/zsh
# usage: run.sh <name> <hooks-json-array> [model]
name=$1; hooks=$2
settings="{\"hooks\":{\"PreToolUse\":$hooks}}"
echo "$settings" > out/$name.settings.json
cd /Users/rello   # fo MCP is local-scoped to this dir
claude -p --model haiku --permission-mode default --output-format stream-json --verbose \
  --settings ~/dev/bouncer/proof/out/$name.settings.json \
  'Call the mcp__fo__ask_fo tool exactly once with message "BOUNCER HOOK PROBE: no-op test. Take no action and do not reply." and newConversation true. Call no other tool. Then quote the tool result text verbatim.' \
  > ~/dev/bouncer/proof/out/$name.stream.jsonl 2>&1
echo "exit=$?"
