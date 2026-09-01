/**
 * Points one PR's Vercel Preview deployment at its own database.
 *
 * Sets branch-scoped Preview environment variables via the Vercel REST API.
 *
 * WHY THE API AND NOT THE CLI. `vercel env add` resolves the project from a
 * `.vercel/project.json` link file, which is gitignored and therefore absent in
 * CI. Supplying VERCEL_ORG_ID / VERCEL_PROJECT_ID gets it as far as
 * "Could not retrieve Project Settings" — the CLI wants a link, not identifiers.
 * Working around that means running `vercel link` first, which is another
 * network call with its own failure modes. The API takes the identifiers
 * directly and does exactly one thing.
 *
 * Usage:
 *   set-preview-env.ts <git-branch>          upsert
 *   set-preview-env.ts <git-branch> --remove teardown
 *
 * Requires VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID, and — unless
 * --remove — DATABASE_URL and DATABASE_URL_UNPOOLED.
 *
 * Prints variable names and the git branch only. Never a value.
 */
const API = 'https://api.vercel.com';

interface VercelEnv {
  readonly id: string;
  readonly key: string;
  readonly target?: readonly string[];
  readonly gitBranch?: string | null;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

async function main(): Promise<void> {
  const gitBranch = process.argv[2];
  const remove = process.argv.includes('--remove');

  if (gitBranch === undefined || gitBranch.trim() === '' || gitBranch.startsWith('--')) {
    throw new Error('Usage: set-preview-env.ts <git-branch> [--remove]');
  }

  const token = required('VERCEL_TOKEN');
  const teamId = required('VERCEL_ORG_ID');
  const projectId = required('VERCEL_PROJECT_ID');

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const KEYS = ['DATABASE_URL', 'DATABASE_URL_UNPOOLED'] as const;

  // Remove any existing branch-scoped entries first. Vercel permits duplicates
  // for the same key and branch, and a stale one would leave the deployment
  // pointing at a database that no longer exists.
  const listed = (await (
    await fetch(`${API}/v9/projects/${projectId}/env?teamId=${teamId}`, { headers })
  ).json()) as { envs?: VercelEnv[]; error?: { message: string } };

  if (listed.error) {
    throw new Error(`Vercel API: ${listed.error.message}`);
  }

  for (const existing of listed.envs ?? []) {
    if (!KEYS.includes(existing.key as (typeof KEYS)[number])) continue;
    if (existing.gitBranch !== gitBranch) continue;
    const res = await fetch(
      `${API}/v9/projects/${projectId}/env/${existing.id}?teamId=${teamId}`,
      { method: 'DELETE', headers },
    );
    console.info(`  removed existing ${existing.key} for ${gitBranch} (${res.status})`);
  }

  if (remove) {
    console.info(`Preview variables cleared for ${gitBranch}.`);
    return;
  }

  for (const key of KEYS) {
    const res = await fetch(`${API}/v10/projects/${projectId}/env?teamId=${teamId}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        key,
        value: required(key),
        type: 'encrypted',
        target: ['preview'],
        gitBranch,
      }),
    });

    if (!res.ok) {
      const body = (await res.json()) as { error?: { message?: string } };
      throw new Error(`Failed to set ${key}: ${res.status} ${body.error?.message ?? ''}`);
    }
    console.info(`  set ${key} for preview branch ${gitBranch}`);
  }
}

void main().catch((error: unknown) => {
  console.error('\nFAILED TO SET PREVIEW ENVIRONMENT\n');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
