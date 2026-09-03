/**
 * Customer service domain errors — stable, machine-readable codes. Tests assert
 * on the CODE, never on message text.
 */
export type CustomerErrorCode = 'CUSTOMER_NOT_FOUND' | 'DUPLICATE_CUSTOMER_NUMBER';

export class CustomerError extends Error {
  public override readonly name = 'CustomerError';
  constructor(
    public readonly code: CustomerErrorCode,
    message: string,
  ) {
    super(message);
  }
}
