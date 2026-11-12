'use client';

/**
 * The sign-in card on `/login`: email link or SMS code (no passwords, ADR-027).
 *
 * Once the session cookie exists the page is reloaded in full. The login page is a server
 * component that reads the verified session and redirects by role, so the destination is decided
 * from the server's view of the claims, never from anything the browser says about itself.
 */
import { PasswordlessSignIn } from '@/components/auth/PasswordlessSignIn';
import type { FirebaseClientConfig } from '@/lib/firebase';

export interface LoginFormProps {
  config: FirebaseClientConfig;
  /** Same-origin path the email link returns to: `/login` with the original `?next=` kept. */
  returnPath: string;
}

export function LoginForm({ config, returnPath }: LoginFormProps) {
  return (
    <PasswordlessSignIn
      config={config}
      methods={['email', 'phone']}
      returnPath={returnPath}
      hint="Use the email address or mobile number your institution registered. No password needed."
      // A full navigation (not router.refresh) so the redirect is a plain 307 from the server.
      onSignedIn={() => window.location.replace(returnPath)}
    />
  );
}
