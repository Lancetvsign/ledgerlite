/**
 * Drizzle carries a PostgreSQL constraint name in the CAUSE chain, not the top message —
 * walk it. Cycle-safe. Used to map a named unique/check violation to a domain error.
 */
export function errorChainText(error: unknown): string {
  const seen = new Set<unknown>();
  let cur: unknown = error;
  let acc = '';
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    acc += ' ' + cur.message;
    cur = (cur as { cause?: unknown }).cause;
  }
  return acc;
}
