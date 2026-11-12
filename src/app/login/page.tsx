/**
 * `/login` — sign-in for Issuers and institution staff. Every protected page and the proxy send
 * signed-out visitors here with `?next=<where they were going>` (B-001).
 *
 * Sign-in is passwordless (email link or SMS code, ADR-027). After the session cookie is set this
 * page is requested again; it then reads the verified session and redirects:
 *
 *   inst_admin / inst_staff → /dashboard/institution
 *   individual (Micro-Issuer) → /dashboard/vault
 *   super_admin → /admin
 *
 * unless `?next=` names a page that person may open, in which case they return to it.
 */
import { LockKeyhole, ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { LoginForm } from '@/components/auth/LoginForm';
import { postLoginPath, safeReturnPath } from '@/lib/auth/access';
import { getSessionUser } from '@/lib/auth/session';
import { firebaseClientConfig } from '@/lib/server/firebase-client-config';
import type { SessionUser } from '@/types/roles';

export const metadata: Metadata = {
  title: 'Sign in',
  // The return path can carry a claim token or other private ids.
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

async function currentUser(): Promise<SessionUser | null> {
  try {
    const user = await getSessionUser(true);
    return user && user.role !== 'guest' ? user : null;
  } catch (error) {
    // Verification could not run: show the form rather than an error page. The protected pages
    // fail closed on their own.
    console.error(
      JSON.stringify({
        severity: 'ERROR',
        message: 'login page: session check failed',
        cause: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

async function Login({ searchParams }: { searchParams: PageProps<'/login'>['searchParams'] }) {
  const query = await searchParams;
  const rawNext = Array.isArray(query.next) ? query.next[0] : query.next;
  // `null` when absent or unsafe, so the role's home page is used.
  const next = rawNext ? safeReturnPath(rawNext, '') || null : null;

  const user = await currentUser();
  if (user) redirect(postLoginPath(user, next));

  const config = firebaseClientConfig();
  if (!config) {
    return (
      <div className="flex flex-col gap-2 text-center" data-testid="login-unavailable">
        <h1 className="text-xl font-semibold">Sign-in is not available yet</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          This server has no sign-in configuration. Please try again later.
        </p>
      </div>
    );
  }

  const returnPath = next ? `/login?next=${encodeURIComponent(next)}` : '/login';
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col items-center gap-3 text-center">
        <span className="rounded-2xl bg-blue-50 p-3 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
          <LockKeyhole className="size-8" aria-hidden />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          For issuers and institution staff.
        </p>
      </header>
      <LoginForm config={config} returnPath={returnPath} />
      <p className="flex items-center justify-center gap-1.5 text-xs text-neutral-500">
        <ShieldCheck className="size-3.5" aria-hidden />
        Received a credential? Open the link in your message to claim it.
      </p>
    </div>
  );
}

export default function LoginPage({ searchParams }: PageProps<'/login'>) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
        <Suspense fallback={<p className="py-10 text-center text-sm text-neutral-500">Loading…</p>}>
          <Login searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}
