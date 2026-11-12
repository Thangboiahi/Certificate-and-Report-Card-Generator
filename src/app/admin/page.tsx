import type { Metadata } from 'next';
import { Suspense } from 'react';

import { requireRouteAccess } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Super Admin' };

/** Everything that depends on who is asking stays inside the guarded component. */
async function AdminHome() {
  const user = await requireRouteAccess('/admin');
  return (
    <p
      data-testid="guarded"
      data-role={user.role}
      className="text-sm text-neutral-600 dark:text-neutral-400"
    >
      Signed in as {user.email ?? user.uid} · super admin
    </p>
  );
}

export default function AdminPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Super Admin</h1>
      <Suspense fallback={<p className="text-sm text-neutral-500">Checking access…</p>}>
        <AdminHome />
      </Suspense>
    </main>
  );
}
