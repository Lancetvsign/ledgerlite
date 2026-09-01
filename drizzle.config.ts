import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// Local development reads .env.local; CI and deployment provide DATABASE_URL
// directly in the environment. .env.local is never committed.
config({ path: '.env.local', quiet: true });

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Empty rather than throwing: `drizzle-kit generate` and `check` diff schema
    // against committed migrations and need no database. Commands that DO need a
    // connection fail with drizzle-kit's own error, and `npm run db:migrate`
    // fails earlier and more clearly via getDatabaseUrl().
    url: process.env['DATABASE_URL'] ?? '',
  },
  strict: true,
  verbose: true,
});
