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
 */
export async function deleteOwnedCompanies(page: Page): Promise<void> {
  await page.goto('/account');
  const list = page.getByTestId('company-list');
  // Only rows that offer the delete control — a membership held as a non-owner
  // (the members spec's invitee) has no such control and is left alone.
  const deletable = list.locator('li').filter({ has: page.locator('summary', { hasText: 'Delete…' }) });

  let removed = 0;
  while ((await deletable.count()) > 0) {
    const row = deletable.first();
    const name = (await row.getByTestId('company-name').textContent()) ?? '';
    expect(name, 'a deletable company row must show its legal name').not.toBe('');

    await row.locator('summary', { hasText: 'Delete…' }).click();
    await row.getByPlaceholder('Type the company name to confirm').fill(name);
    await row.getByTestId('delete-company-confirm').click();

    // Wait for THIS row to be gone before touching the next one. The row only
    // leaves the list on a successful purge or archive (an error redirect renders
    // it again), so this is both the progress signal and the success check; the
    // previous delete's notice is still on screen until the redirect lands, so
    // the notice cannot be either.
    await expect(list.getByText(name, { exact: true })).toHaveCount(0, { timeout: 15_000 });
    removed += 1;
  }
  if (removed > 0) console.info(`company-cleanup: removed ${removed} companies left by earlier runs`);
}
