import type { Metadata } from 'next';
import { Suspense } from 'react';

import { VaultDashboard } from '@/components/vault/VaultDashboard';
import { requireRouteAccess } from '@/lib/auth/session';
import { adminFirestore } from '@/lib/server/firebase-admin';
import { listVaultItems } from '@/lib/vault/vault';

export const metadata: Metadata = { title: 'My Digital Vault' };

async function VaultHome() {
  const user = await requireRouteAccess('/dashboard/vault');
  let items;
  try {
    items = await listVaultItems(adminFirestore(), user.uid);
  } catch (error) {
    console.error(
      JSON.stringify({ severity: 'ERROR', message: 'vault list', cause: String(error) }),
    );
    return (
      <p role="alert" className="text-sm text-red-700 dark:text-red-400">
        Your vault could not be loaded just now. Please try again.
      </p>
    );
  }
  return (
    <div data-testid="guarded" data-role={user.role} className="flex flex-col gap-4">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Signed in as {user.email ?? user.phoneNumber ?? user.uid}
      </p>
      <VaultDashboard items={items} />
    </div>
  );
}

export default function VaultPage() {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">My Digital Vault</h1>
      <Suspense fallback={<p className="text-sm text-neutral-500">Checking access…</p>}>
        <VaultHome />
      </Suspense>
    </section>
  );
}
