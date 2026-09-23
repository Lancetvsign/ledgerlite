/** Typed company-domain errors with stable, machine-readable codes (LL-082). */
export type CompanyErrorCode =
  | 'NAME_MISMATCH'
  /** Another company already holds the single template slot (LL-083). */
  | 'TEMPLATE_EXISTS'
  /** A company with posted history cannot become the template. */
  | 'TEMPLATE_HAS_POSTINGS'
  /** Creation from the template was requested while no template exists. */
  | 'NO_TEMPLATE'
  /** Settings cannot change once the company has posted history. */
  | 'SETTINGS_LOCKED'
  /** The master template cannot be a member of an organization, nor a member become the template (LL-096). */
  | 'TEMPLATE_IN_ORGANIZATION'
  /** A company must leave its organization (and be nobody's counterpart) before it can be archived or purged. */
  | 'COMPANY_IN_ORGANIZATION';

export class CompanyError extends Error {
  public override readonly name = 'CompanyError';
  constructor(
    public readonly code: CompanyErrorCode,
    message: string,
  ) {
    super(message);
  }
}
