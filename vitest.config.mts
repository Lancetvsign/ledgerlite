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
          hookTimeout: 30_000,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
