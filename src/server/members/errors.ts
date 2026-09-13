/** Typed team-membership errors with stable, machine-readable codes (LL-086). */
export type MemberErrorCode =
  /** The email already holds an ACTIVE membership in this company. */
  | 'ALREADY_MEMBER'
  /** A PENDING invitation for that email already exists in this company. */
  | 'ALREADY_INVITED'
  /** The change would leave nobody who still covers the affected member's role. */
  | 'LAST_OWNER';

export class MemberError extends Error {
  public override readonly name = 'MemberError';
  constructor(
    public readonly code: MemberErrorCode,
    message: string,
  ) {
    super(message);
  }
}
