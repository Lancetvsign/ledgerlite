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
          // Every file in ONE run shares one Neon branch. Running files in parallel
          // would let one suite truncate tables another is mid-assertion on. This
          // stays false even under CI sharding (LL-070): `--shard=i/N` splits the
          // files across N *jobs*, each with its OWN Neon branch, and within a job the
          // shard's slice still runs serially. So one branch is still never shared by
          // parallel files.
          fileParallelism: false,
          // These run serially against a remote Neon branch whose latency varies run
          // to run. The suite has grown (A/R + A/P documents, reconciliation and
          // concurrency scenarios), and on a heavily-contended Neon day a shard can
          // still crawl — the heaviest single tests (the isolation registry-attack,
          // which seeds + attacks ~18 descriptors, and the 27-table truncate hook)
          // then blow a 30s budget, failing a GREEN suite. 90s gives headroom without
          // hiding a genuine hang (the 45-min per-shard job cap still catches that).
          // CI sharding (LL-070) cuts wall-clock; this timeout guards the per-test one.
          hookTimeout: 90_000,
          testTimeout: 90_000,
        },
      },
    ],
  },
});
