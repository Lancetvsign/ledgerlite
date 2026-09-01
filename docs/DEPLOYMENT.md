# Deployment

> **Status: partial.** LL-002 established the migration mechanism. Environment wiring,
> Vercel/Neon setup, and the Preview workflow land in **LL-006**; CI lands in **LL-005**.
>
> Binding decisions live in [DECISIONS.md](DECISIONS.md).

## Environments

| Environment | Git branch | Database |
|---|---|---|
| Local development | any | your own Neon branch (`dev/lance`, `dev/claude`) |
| CI | pull request | ephemeral Neon branch, destroyed after the run |
| Preview | pull request | isolated Neon branch, **never production data** |
| Production | `main` | production Neon branch |

The production database is never used for local development, tests, pull request
testing, or Preview deployments.

## Where migrations run

This is a correctness question, not a convenience one.

### Not in the build command

`db:migrate && next build` is **wrong for production**:

- Builds are not guaranteed to run once. Retries and concurrent branch builds can invoke
  the runner in parallel.
- The build step is not the deploy step. A build can succeed, apply a migration, and then
  fail to promote — leaving the database ahead of the deployed code, which is the exact
  failure `expand → migrate → contract` exists to prevent.
- Build environments are cached and may not carry the `DATABASE_URL` you expect.

### Instead

| Environment | When migrations run |
|---|---|
| Local | manually, `npm run db:migrate`, against your own branch |
| CI | in the GitHub Actions job, against the ephemeral branch, **before** tests |
| Preview | in the workflow that provisions the Preview branch, before the app is used |
| Production | a **discrete, gated job** that must succeed **before** the deployment is promoted |

The advisory lock in `scripts/migrate.ts` applies everywhere, so even if two runners are
somehow triggered at once they serialise rather than race.

### A failed migration fails the pipeline

`scripts/migrate.ts` exits non-zero on any failure and prints the error. Never catch a
migration error and continue — a deployment that proceeds past one runs new code against
an old schema.

Verified in LL-002: with `DATABASE_URL` unset, `npm run db:migrate` exits 1 with an
actionable message and no credential in the output.

## Secrets

| Variable | Where it lives |
|---|---|
| `DATABASE_URL` | `.env.local` locally; Vercel environment variables per environment; GitHub secret in CI |
| `BETTER_AUTH_SECRET` | per environment, never shared across them (LL-010) |
| `NEON_API_KEY`, `NEON_PROJECT_ID` | GitHub Actions secrets only (LL-005) |

Never in source, commits, test fixtures, error responses, logs, or documentation.
`.env.example` carries names and explanations only.

Connection strings are stripped of credentials by `describeConnection()` before being
printed anywhere.

## Runtime

Financial write paths use the Neon Pool client over WebSocket, which requires the Node
runtime. Every route that posts financially declares:

```ts
export const runtime = 'nodejs';
```

Node is pinned to 22 (`.nvmrc`, `engines`). Keep local, CI, and Vercel on the same major.

> **Open item for LL-006:** confirm Node 22 against Vercel's currently supported runtimes
> and bump if 24 is available, so all three environments match exactly.
