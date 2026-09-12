/** Typed company-domain errors with stable, machine-readable codes (LL-082). */
export type CompanyErrorCode = 'NAME_MISMATCH';

export class CompanyError extends Error {
  public override readonly name = 'CompanyError';
  constructor(
    public readonly code: CompanyErrorCode,
    message: string,
  ) {
    super(message);
  }
}
