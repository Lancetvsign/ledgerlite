/**
 * Minimal Better Auth config used ONLY by `@better-auth/cli generate`.
 *
 * The runtime config (src/lib/auth) imports `server-only` and the real database
 * module, both of which throw under the CLI's plain-Node loader. The CLI needs
 * nothing from either — only which features are enabled, which determines the
 * tables. KEEP THE FEATURE FLAGS IN SYNC with src/lib/auth/index.ts; a drift
 * here silently generates the wrong schema.
 *
 * Regenerate after changing auth features:
 *   npx @better-auth/cli generate --config scripts/auth-cli-config.ts --output src/db/schema/auth.ts
 * then review the diff and run `npm run db:generate -- --name=<description>`.
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

export const auth = betterAuth({
  database: drizzleAdapter({}, { provider: 'pg', usePlural: false }),
  emailAndPassword: { enabled: true },
});
