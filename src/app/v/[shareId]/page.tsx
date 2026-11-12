/**
 * Public verification page: `/v/{shareId}` — what a recipient's shared link opens (ADR-027).
 * Shows only what the owner chose to share; unknown or un-shared ids look identical.
 */
import { BadgeCheck, ShieldAlert } from 'lucide-react';
import type { Metadata } from 'next';
import { connection } from 'next/server';
import { Suspense } from 'react';

import { adminFirestore } from '@/lib/server/firebase-admin';
import { findSharedCredential } from '@/lib/vault/vault';

export const metadata: Metadata = {
  title: 'Verify a credential',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

const DATE = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
});

function isPast(millis: number | null): boolean {
  return millis !== null && millis < Date.now();
}

async function Shared({ params }: { params: Promise<{ shareId: string }> }) {
  await connection();
  const { shareId } = await params;
  let credential;
  try {
    credential = await findSharedCredential(adminFirestore(), shareId);
  } catch (error) {
    console.error(
      JSON.stringify({ severity: 'ERROR', message: 'share page', cause: String(error) }),
    );
    return <p className="text-center text-sm">This page could not be loaded just now.</p>;
  }
  if (!credential) {
    return (
      <p className="text-center text-sm" data-testid="share-missing">
        This link is not valid, or the owner has stopped sharing it.
      </p>
    );
  }
  const revoked = credential.status === 'revoked';
  const expired = isPast(credential.expiresAt);
  return (
    <div className="flex flex-col items-center gap-3 text-center" data-testid="share-credential">
      {revoked ? (
        <ShieldAlert className="size-10 text-red-700" aria-hidden />
      ) : (
        <BadgeCheck className="size-10 text-green-700" aria-hidden />
      )}
      <p className="text-sm font-medium" data-testid="share-status">
        {revoked ? 'Revoked by the issuer' : expired ? 'Expired' : 'Valid credential'}
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">{credential.credentialName}</h1>
      {credential.recipientName && <p className="text-sm">awarded to {credential.recipientName}</p>}
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Issued by {credential.issuerName}
        {credential.issuerVerified && ' (verified institution)'} on{' '}
        {DATE.format(credential.issuedAt)}
      </p>
      {credential.expiresAt && (
        <p className="text-xs text-neutral-500">
          {expired ? 'Expired' : 'Valid until'} {DATE.format(credential.expiresAt)}
        </p>
      )}
    </div>
  );
}

export default function SharedPage({ params }: PageProps<'/v/[shareId]'>) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
        <Suspense fallback={<p className="text-center text-sm text-neutral-500">Loading…</p>}>
          <Shared params={params} />
        </Suspense>
      </div>
    </main>
  );
}
