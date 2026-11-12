/**
 * `/v/{shareId}` is the Phase 7 address of the verification page. Links already shared keep working:
 * they land on `/verify/{shareId}` (ADR-034).
 */
import type { Metadata } from 'next';
import { permanentRedirect } from 'next/navigation';
import { connection } from 'next/server';
import { Suspense } from 'react';

export const metadata: Metadata = { referrer: 'no-referrer', robots: { index: false } };

async function Forward({ params }: { params: Promise<{ shareId: string }> }): Promise<null> {
  await connection();
  const { shareId } = await params;
  permanentRedirect(`/verify/${encodeURIComponent(shareId)}`);
}

export default function LegacySharedPage({ params }: PageProps<'/v/[shareId]'>) {
  return (
    <Suspense fallback={<p className="p-6 text-center text-sm text-neutral-500">Opening…</p>}>
      <Forward params={params} />
    </Suspense>
  );
}
