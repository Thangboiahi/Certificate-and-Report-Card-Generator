import { FileText, PenLine } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import { requireRouteAccess } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Issue Credentials' };

async function IssueHome() {
  const user = await requireRouteAccess('/dashboard/issue');
  return (
    <p
      data-testid="guarded"
      data-role={user.role}
      className="text-sm text-neutral-600 dark:text-neutral-400"
    >
      Issuing as {user.email ?? user.uid}
    </p>
  );
}

export default function IssuePage() {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Issue Credentials</h1>
      <Suspense fallback={<p className="text-sm text-neutral-500">Checking access…</p>}>
        <IssueHome />
      </Suspense>
      <h2 className="mt-2 text-sm font-medium text-neutral-500">Templates</h2>
      <ul className="flex flex-col gap-2">
        <li>
          <Link
            href="/editor"
            data-testid="open-editor"
            className="flex items-center gap-3 rounded-2xl border border-neutral-200 p-4 hover:border-neutral-400 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-none dark:border-neutral-800 dark:hover:border-neutral-600"
          >
            <span className="rounded-xl bg-blue-50 p-2.5 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
              <FileText className="size-5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium">Sample certificate and report card</span>
              <span className="block text-xs text-neutral-500">2 pages · 18 fields</span>
            </span>
            <PenLine className="size-4 text-neutral-400" aria-hidden />
          </Link>
        </li>
      </ul>
    </section>
  );
}
