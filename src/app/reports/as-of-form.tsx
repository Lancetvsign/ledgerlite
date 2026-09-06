/**
 * The "as of" date control shared by the Trial Balance and A/R Aging screens
 * (LL-055). A plain GET form — no client JavaScript — that reloads the current
 * page with `?asOf=YYYY-MM-DD`, the same client-free filter pattern as the
 * /accounts search and /invoices status filter. A native date input yields a
 * calendar-date string, which the page re-validates server-side.
 */
export function AsOfForm({ asOf }: { readonly asOf: string }) {
  return (
    <form method="get" className="flex items-center gap-2 text-sm">
      <label htmlFor="asOf">As of</label>
      <input
        type="date"
        id="asOf"
        name="asOf"
        defaultValue={asOf}
        data-testid="asof-input"
        className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
      />
      <button
        type="submit"
        data-testid="asof-submit"
        className="rounded border border-neutral-300 px-3 py-1 dark:border-neutral-700"
      >
        View
      </button>
    </form>
  );
}
