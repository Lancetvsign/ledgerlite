# CLAUDE.md

@AGENTS.md

The engineering contract above is imported verbatim and is binding. Follow it exactly.

## Claude Code specifics

- **Use plan mode for any ticket that changes the database schema.** Present the full
  migration plan for human review before generating DDL.
- **Never run `npm run db:migrate` against anything but your own dev branch.**
- **Read every generated migration before committing it.** Report what the SQL does in
  plain language; do not just confirm that it generated.
- Prefer `rg` over `grep`, and read tests before reading implementation — the tests
  state the intended contract.
- One ticket per session. Do not begin the next ticket in the same context.
- Before opening a PR, run `/code-review high` on your own diff and address findings.
