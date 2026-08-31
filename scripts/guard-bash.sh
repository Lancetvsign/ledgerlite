#!/usr/bin/env bash
# LedgerLite Claude Code guardrail.
# PreToolUse hook for Bash. Receives the tool call as JSON on stdin.
# Exit 2 blocks the call and returns stderr to the model as feedback.
set -uo pipefail

payload="$(cat)"
cmd="$(printf '%s' "$payload" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null || true)"
[ -z "$cmd" ] && exit 0

deny() { printf 'BLOCKED by LedgerLite guardrail: %s\n' "$1" >&2; exit 2; }

# --- git: never write to main, never self-merge -----------------------------
if grep -Eq '(^|[;&|[:space:]])git[[:space:]]+push([[:space:]]|$)' <<<"$cmd"; then
  grep -Eq '(origin[[:space:]]+)?(HEAD:)?(refs/heads/)?main([[:space:]]|$)' <<<"$cmd" \
    && deny "pushing to main. Push your feature branch and open a pull request."
  grep -Eq '\-\-force|\-f([[:space:]]|$)' <<<"$cmd" \
    && deny "force push. Rewriting shared history is not permitted."
fi
grep -Eq '(^|[;&|[:space:]])gh[[:space:]]+pr[[:space:]]+merge' <<<"$cmd" \
  && deny "merging a pull request. Merges require human approval."
grep -Eq '(^|[;&|[:space:]])git[[:space:]]+merge' <<<"$cmd" \
  && deny "git merge. Integration happens through reviewed pull requests."
grep -Eq '(^|[;&|[:space:]])git[[:space:]]+(checkout|switch)[[:space:]]+main([[:space:]]|$).*(&&|;).*(commit|add)' <<<"$cmd" \
  && deny "committing on main."

# --- schema: migrations only ------------------------------------------------
grep -Eq 'drizzle-kit[[:space:]]+push|db:push' <<<"$cmd" \
  && deny "drizzle-kit push. Every schema change must be a committed migration (npm run db:generate)."

# --- destructive SQL --------------------------------------------------------
grep -Eiq '(drop[[:space:]]+(table|schema|database)|truncate[[:space:]]+table|delete[[:space:]]+from[[:space:]]+journal_)' <<<"$cmd" \
  && deny "destructive SQL against accounting tables. Financial data is never deleted; use reversal."

# --- secrets ----------------------------------------------------------------
grep -Eq '\.env\.local|\.env\.production|\.env\.preview' <<<"$cmd" \
  && deny "touching a real environment file. Use .env.example for names, and ask the human for values."

# --- production database ----------------------------------------------------
grep -Eiq 'db:migrate.*prod|PROD.*DATABASE_URL|neonctl.*--branch[[:space:]]+(main|production)' <<<"$cmd" \
  && deny "operating against the production database. Production migrations run only through the gated deploy workflow."

exit 0
