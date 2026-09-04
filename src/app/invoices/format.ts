/**
 * The label an account is shown by in the invoice pickers — LL-044. Kept in ONE
 * place so the form's `<datalist>` options and the edit page's prefilled account
 * text always agree; if they diverged, edit prefill would silently stop resolving
 * an account back to its id.
 */
export function accountLabel(a: { readonly accountNumber: string | null; readonly name: string }): string {
  return a.accountNumber !== null && a.accountNumber !== '' ? `${a.accountNumber} · ${a.name}` : a.name;
}
