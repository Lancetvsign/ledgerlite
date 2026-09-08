import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const serverOnlyStub = fileURLToPath(
  new URL('./tests/helpers/server-only-stub.ts', import.meta.url),
);

const resolve = {
  // Honour the `@/*` path alias from tsconfig.json.
  tsconfigPaths: true,
  // `server-only` throws outside a React Server Component. See the stub's comment.
  alias: { 'server-only': serverOnlyStub },
};

export default defineConfig({
  resolve,
  test: {
    projects: [
      {
        resolve,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/helpers/integration-setup.ts'],
          // Integration tests share one database. Running files in parallel would
          // let one suite truncate tables another is mid-assertion on.
          fileParallelism: false,
          // These run serially against a remote Neon branch whose latency varies run
          // to run. The suite has grown (A/R + A/P documents, reconciliation and
          // concurrency scenarios), and on a heavily-contended Neon day the whole job
          // crawls (~2× baseline) — the heaviest single tests (the isolation
          // registry-attack, which seeds + attacks ~18 descriptors, and the 27-table
          // truncate hook) then blow a 30s budget, failing a GREEN suite. 90s gives
          // headroom without hiding a genuine hang (the 45-min job cap still catches
          // that). The proper fix — sharding / trimming Neon round-trips — is LL-070.
          hookTimeout: 90_000,
          testTimeout: 90_000,
        },
      },
    ],
  },
});
