#!/usr/bin/env bash
# PreToolUse hook for Edit/Write. Protects committed migrations and env files.
set -uo pipefail
payload="$(cat)"
path="$(printf '%s' "$payload" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))' 2>/dev/null || true)"
[ -z "$path" ] && exit 0

deny() { printf 'BLOCKED by LedgerLite guardrail: %s\n' "$1" >&2; exit 2; }

case "$path" in
  *.env.local|*.env.production|*.env.preview)
    deny "editing a real environment file. Put variable names in .env.example instead." ;;
esac

# A migration that is already committed has been reviewed and may have been applied.
# Editing it desynchronizes environments. Generate a new migration instead.
if [[ "$path" == *drizzle/migrations/* || "$path" == *drizzle/*.sql ]]; then
  if git -C "$(dirname "$path")" ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    deny "editing an already-committed migration. It may be applied elsewhere. Create a new migration."
  fi
fi
exit 0
