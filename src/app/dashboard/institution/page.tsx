import type { Metadata } from 'next';
import { Suspense } from 'react';

import { KanbanBoard } from '@/components/dashboard/KanbanBoard';
import { sampleRequests } from '@/components/dashboard/sample-requests';
import { requireRouteAccess } from '@/lib/auth/session';
import { requestTime } from '@/lib/server/request-time';

export const metadata: Metadata = { title: 'Institution' };

async function InstitutionHome() {
  const user = await requireRouteAccess('/dashboard/institution');
  const renderedAt = requestTime();
  return (
    <>
      <p
        data-testid="guarded"
        data-role={user.role}
        data-institution={user.institutionId ?? ''}
        className="text-sm text-neutral-600 dark:text-neutral-400"
      >
        Signed in as {user.email ?? user.uid} · {user.role === 'inst_admin' ? 'admin' : 'staff'} of{' '}
        {user.institutionId}
      </p>
      <h2 className="mt-4 text-sm font-medium text-neutral-500">Credential requests</h2>
      <p className="text-xs text-neutral-500">Sample requests — moves are not saved yet.</p>
      <KanbanBoard initialRequests={sampleRequests(renderedAt)} renderedAt={renderedAt} />
    </>
  );
}

export default function InstitutionPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Institution dashboard</h1>
      <Suspense fallback={<p className="text-sm text-neutral-500">Checking access…</p>}>
        <InstitutionHome />
      </Suspense>
    </main>
  );
}
