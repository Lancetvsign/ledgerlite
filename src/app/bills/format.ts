/**
 * The label an account is shown by in the bill pickers — LL-065. The A/P mirror of
 * the invoices' `accountLabel`, kept per-feature (like notice.ts / actions.ts) so the
 * bill form's `<datalist>` options resolve back to an account id consistently.
 */
export function accountLabel(a: { readonly accountNumber: string | null; readonly name: string }): string {
  return a.accountNumber !== null && a.accountNumber !== '' ? `${a.accountNumber} · ${a.name}` : a.name;
}
