import { createHash, randomBytes } from 'node:crypto';

/**
 * Invitation secrets — LL-090 / ADR-041 amendment.
 *
 * The link an inviter hands over IS the authorization to join. The secret is 32
 * random bytes (base64url, 43 chars); only its SHA-256 hex hash is stored, so a
 * database read never yields a usable link. Tokens are never logged.
 */
export const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** The short-lived cookie the join page sets so the sign-up endpoint can admit an invitee. */
export const JOIN_COOKIE = 'ledgerlite_join';
export const JOIN_COOKIE_TTL_SECONDS = 30 * 60;

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Shape check before any lookup — a malformed string never reaches the database. */
export function looksLikeToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}
