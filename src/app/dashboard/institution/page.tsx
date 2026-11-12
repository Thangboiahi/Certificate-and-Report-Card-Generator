import type { Metadata } from 'next';
import { Suspense } from 'react';

import { requireRouteAccess } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Institution' };

async function InstitutionHome() {
  const user = await requireRouteAccess('/dashboard/institution');
  return (
    <p
      data-testid="guarded"
      data-role={user.role}
      data-institution={user.institutionId ?? ''}
      className="text-sm text-neutral-600 dark:text-neutral-400"
    >
      Signed in as {user.email ?? user.uid} · {user.role === 'inst_admin' ? 'admin' : 'staff'} of{' '}
      {user.institutionId}
    </p>
  );
}

export default function InstitutionPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Institution dashboard</h1>
      <Suspense fallback={<p className="text-sm text-neutral-500">Checking access…</p>}>
        <InstitutionHome />
      </Suspense>
    </main>
  );
}
