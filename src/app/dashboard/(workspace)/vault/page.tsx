import type { Metadata } from 'next';
import { Suspense } from 'react';

import { requireRouteAccess } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'My vault' };

async function VaultHome() {
  const user = await requireRouteAccess('/dashboard/vault');
  return (
    <p
      data-testid="guarded"
      data-role={user.role}
      className="text-sm text-neutral-600 dark:text-neutral-400"
    >
      Signed in as {user.email ?? user.uid}
    </p>
  );
}

export default function VaultPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">My vault</h1>
      <Suspense fallback={<p className="text-sm text-neutral-500">Checking access…</p>}>
        <VaultHome />
      </Suspense>
    </main>
  );
}
