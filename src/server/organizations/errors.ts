/** Typed organization-domain errors with stable, machine-readable codes (LL-096). */
export type OrganizationErrorCode =
  /** The company already belongs to an organization. */
  | 'ALREADY_IN_ORGANIZATION'
  /** The company belongs to no organization. */
  | 'NOT_IN_ORGANIZATION'
  /** The master template company seeds new companies and cannot be a member. */
  | 'TEMPLATE_IN_ORGANIZATION'
  /** Every member of an organization keeps one currency; intercompany balances mirror in it. */
  | 'CURRENCY_MISMATCH'
  /** A company with a non-zero Due from / Due to balance against any member cannot leave. */
  | 'ORG_HAS_INTERCOMPANY_BALANCE';

export class OrganizationError extends Error {
  public override readonly name = 'OrganizationError';
  constructor(
    public readonly code: OrganizationErrorCode,
    message: string,
  ) {
    super(message);
  }
}
