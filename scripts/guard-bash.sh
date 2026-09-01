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
  # --force can silently overwrite work that arrived since you last fetched.
  # --force-with-lease refuses in exactly that case, which makes it safe on a
  # feature branch after a rebase — a routine operation that a blanket ban turns
  # into a reason to switch the guard off.
  if grep -Eq '\-\-force([[:space:]]|=|$)|(^|[[:space:]])\-f([[:space:]]|$)' <<<"$cmd" \
     && ! grep -Eq '\-\-force-with-lease' <<<"$cmd"; then
    deny "bare force push. Use --force-with-lease, which refuses if the remote moved."
  fi
fi
grep -Eq '(^|[;&|[:space:]])gh[[:space:]]+pr[[:space:]]+merge' <<<"$cmd" \
  && deny "merging a pull request. Merges require human approval."
# `git merge` is only dangerous in one direction. Merging main INTO a feature
# branch is routine and safe — it is how you resolve a conflict before review.
# Merging a feature branch INTO main is the thing that bypasses review.
# The rule therefore keys on the branch you are ON, not on the word "merge".
if grep -Eq '(^|[;&|[:space:]])git[[:space:]]+merge([[:space:]]|$)' <<<"$cmd"; then
  # --abort/--quit/--continue are RECOVERY, not integration. Blocking them would
  # strand someone mid-conflict with no way out, which is how a guard stops being
  # trusted and starts being disabled.
  if ! grep -Eq '\-\-(abort|quit|continue)' <<<"$cmd"; then
    current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
    [ "$current_branch" = "main" ] \
      && deny "git merge while on main. Integration happens through reviewed pull requests."
  fi
fi
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
