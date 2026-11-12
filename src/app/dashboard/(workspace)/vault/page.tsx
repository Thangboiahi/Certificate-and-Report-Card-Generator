import type { Metadata } from 'next';
import { Suspense } from 'react';

import { requireRouteAccess } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'My Digital Vault' };

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
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">My Digital Vault</h1>
      <Suspense fallback={<p className="text-sm text-neutral-500">Checking access…</p>}>
        <VaultHome />
      </Suspense>
      <p className="rounded-2xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
        Certificates issued to you will appear here.
      </p>
    </section>
  );
}
