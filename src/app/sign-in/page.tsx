import { signUpMode } from '@/lib/auth/signup-mode';

import { SignInForm } from './sign-in-form';

/** Server wrapper: the sign-up mode is environment configuration, decided on the server (LL-090). */
export const dynamic = 'force-dynamic';

export default function SignInPage() {
  return <SignInForm signUpMode={signUpMode()} />;
}
