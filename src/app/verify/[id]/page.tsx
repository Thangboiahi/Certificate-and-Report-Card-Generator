/**
 * Public verification portal: `/verify/{id}`, what a scanned QR code or a shared link opens. No
 * sign-in. `{id}` is the credential's unguessable share id (ADR-027, ADR-034), not its Firestore
 * document id: only credentials whose owner chose to share them can be looked up, and an unknown
 * id looks the same as one that is no longer shared.
 */
import { ShieldQuestion } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { Suspense } from 'react';

import { VerificationResult } from '@/components/verify/VerificationResult';
import { adminFirestore } from '@/lib/server/firebase-admin';
import { requestTime } from '@/lib/server/request-time';
import { verificationState } from '@/lib/vault/verification';
import { findSharedCredential } from '@/lib/vault/vault';

export const metadata: Metadata = {
  title: 'Verify a credential',
  // The id is a capability: keep it out of referrers, search results and link previews' crawlers.
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

async function Verification({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  let credential;
  try {
    credential = await findSharedCredential(adminFirestore(), id);
  } catch (error) {
    console.error(
      JSON.stringify({ severity: 'ERROR', message: 'verify page', cause: String(error) }),
    );
    return (
      <p role="alert" className="text-center text-sm" data-testid="verify-error">
        This page could not be loaded just now. Please try again in a moment.
      </p>
    );
  }
  if (!credential) {
    return (
      <div className="flex flex-col items-center gap-3 text-center" data-testid="share-missing">
        <ShieldQuestion className="size-10 text-neutral-400" aria-hidden />
        <h1 className="text-lg font-semibold">We couldn’t verify this credential</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          This link is not valid, or the owner has stopped sharing it. If you scanned a QR code, ask
          the holder for a fresh link.
        </p>
      </div>
    );
  }
  return (
    <VerificationResult
      credential={credential}
      state={verificationState(credential, requestTime())}
    />
  );
}

export default function VerifyPage({ params }: PageProps<'/verify/[id]'>) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-4 py-10">
      <div className="rounded-3xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-6 dark:border-neutral-800 dark:bg-neutral-950">
        <Suspense fallback={<p className="text-center text-sm text-neutral-500">Checking…</p>}>
          <Verification params={params} />
        </Suspense>
      </div>
      <p className="text-center text-xs text-neutral-500">
        Credential check by{' '}
        <Link href="/" className="underline underline-offset-2">
          Bulk document generator
        </Link>
      </p>
    </main>
  );
}
