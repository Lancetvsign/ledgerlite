/**
 * Who may create an account — LL-090 / ADR-041 amendment.
 *
 * 'invitation': the sign-up endpoint admits only a request carrying a live
 * invitation secret (the join cookie). Always the case in production, and in any
 * environment that sets AUTH_SIGNUP_MODE=invitation.
 * 'open': anyone may register — development, APP_ENV=test, CI and the e2e suite,
 * which all create fixture users directly. Read per request: the auth instance is
 * memoized, and tests flip the variable.
 *
 * Bootstrapping a fresh instance: set AUTH_SIGNUP_MODE=open once, create the first
 * owner, unset it (docs/DEPLOYMENT.md).
 */
export type SignUpMode = 'open' | 'invitation';

export function signUpMode(env: Readonly<Record<string, string | undefined>> = process.env): SignUpMode {
  if (env['AUTH_SIGNUP_MODE'] === 'invitation') return 'invitation';
  if (env['AUTH_SIGNUP_MODE'] === 'open') return 'open';
  return env['APP_ENV'] === 'production' ? 'invitation' : 'open';
}
