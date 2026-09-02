'use client';

/**
 * Browser-side auth client. Talks to /api/auth/* on the same origin — no base
 * URL is configured here on purpose; the server decides its own identity.
 * Nothing secret lives in this file or may be imported into it.
 */
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient();

export const { signIn, signUp, signOut, useSession } = authClient;
