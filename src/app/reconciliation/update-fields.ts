/**
 * Which fields an "Update statement" submit actually changes — LL-093 (Gate 6 M4).
 *
 * The form shows the ending balance in the two-decimal input form (ADR-037) but the
 * stored figure has four decimals. Sending the shown value back unchanged would
 * silently round the stored figure (1000.0050 → 1000.0000). So the amount is sent
 * only when the reviewer changed the text; the date likewise. Pure; unit-tested.
 */
export function changedUpdateFields(submitted: {
  statementDate: string | undefined;
  statementEndingAmount: string | undefined;
  shownDate: string | undefined;
  shownAmount: string | undefined;
}): { statementDate?: string; statementEndingAmount?: string } {
  const out: { statementDate?: string; statementEndingAmount?: string } = {};
  if (submitted.statementDate !== undefined && submitted.statementDate !== submitted.shownDate) {
    out.statementDate = submitted.statementDate;
  }
  if (submitted.statementEndingAmount !== undefined && submitted.statementEndingAmount !== submitted.shownAmount) {
    out.statementEndingAmount = submitted.statementEndingAmount;
  }
  return out;
}
