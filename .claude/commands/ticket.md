---
description: Start a LedgerLite ticket with the full engineering protocol
argument-hint: LL-XXX [optional extra context]
---

You are implementing ticket **$1** of the LedgerLite accounting application.

## Establish context first

Do not assume prior chat history. The repository is the source of truth.

1. Read `AGENTS.md` in full.
2. Read `/docs/DECISIONS.md` — it settles every ambiguous choice. If this ticket
   depends on a decision that has no ADR, **stop and ask** rather than inventing one.
3. Read the `/docs` files this ticket touches.
4. Read the ticket definition in `/docs/tickets/$1.md`.
5. Run `git status` and `git log --oneline -10`. Confirm the working tree is clean.
6. Read the existing implementation and tests in the area you are about to change.

## Branch

If on `main`: `git pull origin main`, then create the branch named in the ticket.
Never develop on `main`.

## Implement

- Scope is exactly this ticket. Do not fix unrelated things you notice — report them
  at the end instead.
- Use the existing architecture. No new frameworks, ORMs, or libraries without an ADR.
- **If this ticket changes the schema:** enter plan mode, present the full migration
  plan, and wait for approval before generating DDL. Then read the generated SQL and
  explain in plain language what it does.
- Financial write paths use `dbTx` (the Pool client) and a real transaction. Never the
  HTTP client.
- Money is `string` at boundaries and `Decimal` in computation. Never `number`.
- Tests ship in this PR, not a later one.

## Verify before you claim completion

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

Then:
- Run `git diff main...HEAD` and read it in full. Look for accidental changes,
  debugging leftovers, weakened tests, and relaxed constraints.
- Run `/code-review high` on the diff and address real findings.
- Confirm no secret, no real financial data, and no `.env` value is in the diff.

## Finish

Commit with a conventional message. Push the feature branch. Write the PR description
using the template in `/docs/PR_TEMPLATE.md`.

**Do not merge the pull request.**

Then produce the end-of-ticket report specified in section 11 of `AGENTS.md`.
Be honest about failures and about any decision you made that the ticket did not
specify.

$2
