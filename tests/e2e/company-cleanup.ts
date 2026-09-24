import { expect, type Page } from '@playwright/test';

/**
 * Deletes every company the signed-in user OWNS, through the Account page's own
 * delete flow (LL-082): open "Delete…", retype the legal name, confirm.
 *
 * Why: the e2e users persist between runs and every spec creates fresh companies,
 * so the /account list grew without bound — three forms per row, rendered on every
 * visit — until create-company assertions timed out on CI. Each setup project calls
 * this once, right after signing in, so a run starts from an empty list and only
 * ever sees the handful of companies it creates itself.
 *
 * Going through the UI keeps every guarantee the product makes: only an OWNER sees
 * the control, the service re-proves that capability, an untouched company is
 * purged and one with any history is archived (hidden, records kept). Nothing here
 * can reach another user's data, whichever database the suite is pointed at.
 *
 * Not every company can go. A member of an organization must leave it first
 * (LL-096), and it cannot leave while a Due from / Due to balance stands against
 * another member (ORG_HAS_INTERCOMPANY_BALANCE) — the intercompany specs leave
 * exactly such companies behind. Those are skipped, not waited on: each attempt
 * ends in a redirect to /account?ok=… or /account?error=…, and an error means the
 * row stays. A skipped company is reported and never retried in this run.
 */
export async function deleteOwnedCompanies(page: Page): Promise<void> {
  const list = page.getByTestId('company-list');
  const skipped = new Set<string>();
  let removed = 0;

  for (;;) {
    // A fresh, query-free /account on every pass: the outcome of each action is
    // read from the redirect's query string, so the page must not start with one.
    await page.goto('/account');

    // Only rows that offer the delete control — a membership held as a non-owner
    // (the members spec's invitee) has no such control and is left alone.
    const deletable = list.locator('li').filter({ has: page.locator('summary', { hasText: 'Delete…' }) });
    const names = await deletable.getByTestId('company-name').allTextContents();
    const name = names.find((n) => n !== '' && !skipped.has(n));
    if (name === undefined) break;

    const row = deletable.filter({ has: page.getByTestId('company-name').getByText(name, { exact: true }) }).first();

    // A member of an organization leaves it first; the service refuses the delete
    // otherwise (COMPANY_IN_ORGANIZATION). If leaving is refused, the company stays.
    const leave = row.getByTestId('leave-organization');
    if ((await leave.count()) > 0) {
      await leave.click();
      const outcome = await redirectOutcome(page);
      if (outcome.error !== null) {
        console.info(`company-cleanup: keeping "${name}" — cannot leave its organization (${outcome.error})`);
        skipped.add(name);
      }
      // Either way, start over on a fresh page: the row is now deletable, or skipped.
      continue;
    }

    await row.locator('summary', { hasText: 'Delete…' }).click();
    await row.getByPlaceholder('Type the company name to confirm').fill(name);
    await row.getByTestId('delete-company-confirm').click();

    const outcome = await redirectOutcome(page);
    if (outcome.error !== null) {
      console.info(`company-cleanup: keeping "${name}" — delete refused (${outcome.error})`);
      skipped.add(name);
      continue;
    }
    // The row leaves the list only on a successful purge or archive; prove it
    // rather than trusting the ok code alone.
    await expect(list.getByText(name, { exact: true })).toHaveCount(0, { timeout: 15_000 });
    removed += 1;
  }

  if (removed > 0) console.info(`company-cleanup: removed ${removed} companies left by earlier runs`);
  if (skipped.size > 0) console.info(`company-cleanup: left ${skipped.size} companies that cannot be deleted`);
}

/**
 * Every Account action ends in a redirect to /account?ok=<code> or
 * /account?error=<code>; the query string is the only reliable signal. The
 * notice element is not: the previous action's notice stays on screen until
 * the next redirect lands.
 */
async function redirectOutcome(page: Page): Promise<{ ok: string | null; error: string | null }> {
  await page.waitForURL(/\/account\?(ok|error)=/, { timeout: 15_000 });
  const params = new URL(page.url()).searchParams;
  return { ok: params.get('ok'), error: params.get('error') };
}
