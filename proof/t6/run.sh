#!/bin/zsh
# usage: run.sh <name> <prompt>  — a real Claude Code session with Bouncer's hooks, from the dir where fo is configured
name=$1; prompt=$2
out=~/dev/bouncer/proof/out/t6_$name.stream.jsonl
cd /Users/rello
claude -p --model haiku --permission-mode default --output-format stream-json --verbose \
  --settings /Users/rello/dev/bouncer/hooks/claude-settings.json "$prompt" > $out 2>&1
echo "exit=$?"
