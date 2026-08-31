import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // A type error must fail the build. Never set ignoreBuildErrors — a build that
  // ships known-broken types is how an accounting defect reaches production.
  // See AGENTS.md section 7.
  //
  // Lint is NOT configured here: Next 16 removed the `eslint` config key along
  // with `next lint`. Linting runs as its own step via `npm run lint`, and
  // `npm run ci` chains lint -> typecheck -> test -> build.
  typescript: { ignoreBuildErrors: false },

  // Pin the workspace root. Without this, Turbopack walks up and finds the
  // unrelated package-lock.json in the parent directory, which is outside this
  // git repository.
  turbopack: { root: import.meta.dirname },

  reactStrictMode: true,
};

export default nextConfig;
