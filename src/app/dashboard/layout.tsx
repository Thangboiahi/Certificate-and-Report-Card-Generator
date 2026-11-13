import { Suspense, type ReactNode } from 'react';

import { AppHeader } from '@/components/dashboard/AppHeader';
import { postLoginPath } from '@/lib/auth/access';
import { getSessionUser } from '@/lib/auth/session';
import { firebaseClientConfig } from '@/lib/server/firebase-client-config';

/**
 * Frame shared by everything under /dashboard: the top bar with the profile menu and Sign out.
 *
 * The header only *displays* who is signed in. It grants nothing: every page below still calls
 * `requireRouteAccess` and the proxy still gates the routes (ADR-017), so a failure to read the
 * session here shows a bare header and leaves the decision to them.
 */
async function Header() {
  let user = null;
  let homeHref = '/dashboard/vault';
  try {
    const session = await getSessionUser(false);
    if (session && session.role !== 'guest') {
      user = {
        identity: session.email ?? session.phoneNumber ?? session.uid,
        role: session.role,
      };
      homeHref = postLoginPath(session, null);
    }
  } catch (error) {
    // While the static shell is built there is no request to read a session from: not an error.
    if (error instanceof Error && error.message.includes('During prerendering')) {
      return <AppHeader user={null} config={null} homeHref={homeHref} />;
    }
    console.error(
      JSON.stringify({
        severity: 'ERROR',
        message: 'dashboard header: session read failed',
        cause: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  let config = null;
  try {
    config = firebaseClientConfig();
  } catch {
    // Misconfigured emulator settings: sign-out still clears the server cookie.
  }
  return <AppHeader user={user} config={config} homeHref={homeHref} />;
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Suspense fallback={<AppHeader user={null} config={null} />}>
        <Header />
      </Suspense>
      {children}
    </>
  );
}
