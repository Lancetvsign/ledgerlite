/**
 * Vendor service domain errors — stable, machine-readable codes. Tests assert on
 * the CODE, never on message text.
 */
export type VendorErrorCode = 'VENDOR_NOT_FOUND' | 'DUPLICATE_VENDOR_NUMBER';

export class VendorError extends Error {
  public override readonly name = 'VendorError';
  constructor(
    public readonly code: VendorErrorCode,
    message: string,
  ) {
    super(message);
  }
}
