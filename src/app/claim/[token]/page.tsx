/**
 * Public claim page: `/claim/{token}` — the link in the WhatsApp message or email.
 *
 * Shows who issued what (never the recipient's details to a stranger), then hands over to
 * `ClaimFlow`: passwordless sign-in with the contact the link was sent to, then an instant claim
 * (free) or the pay-to-claim checkout (ADR-027, ADR-028).
 */
import { Award, Clock, ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import { Suspense } from 'react';

import { ClaimFlow } from '@/components/claim/ClaimFlow';
import { getSessionUser } from '@/lib/auth/session';
import { loadClaimView, type ClaimView } from '@/lib/claim/claim';
import { pricingFromEnv, type PricingPolicy } from '@/lib/payments/pricing';
import { razorpayConfigFromEnv, razorpayMode } from '@/lib/razorpayClient';
import { adminFirestore } from '@/lib/server/firebase-admin';
import { firebaseClientConfig } from '@/lib/server/firebase-client-config';

export const metadata: Metadata = {
  title: 'Claim your credential',
  // The token is in the address: never leak it to other sites or search engines.
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

const DATE = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
});

/** The pricing in force, or `null` when payments cannot be taken (keys or pricing missing). */
function paymentPricing(): PricingPolicy | null {
  if (!razorpayConfigFromEnv()) return null;
  try {
    return pricingFromEnv();
  } catch (error) {
    console.error(
      JSON.stringify({ severity: 'ERROR', message: 'pricing misconfigured', cause: String(error) }),
    );
    return null;
  }
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 text-center" data-testid="claim-notice">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">{children}</p>
    </div>
  );
}

async function Claim({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let user = null;
  let view: ClaimView;
  try {
    user = await getSessionUser(false);
    view = await loadClaimView(adminFirestore(), token, user);
  } catch (error) {
    console.error(
      JSON.stringify({ severity: 'ERROR', message: 'claim page', cause: String(error) }),
    );
    return <Notice title="Please try again">This page could not be loaded just now.</Notice>;
  }

  if (view.status === 'not_found') {
    return (
      <Notice title="This link is not valid">
        Check that you opened the whole link from your message, or ask the issuer to send it again.
      </Notice>
    );
  }
  if (view.status === 'expired') {
    return (
      <Notice title="This link has expired">
        {view.issuerName} can send you a new one from their dashboard.
      </Notice>
    );
  }
  if (view.status === 'claimed' && !view.claimedByUser) {
    return (
      <Notice title="Already claimed">
        This credential is already in a vault. If that was you, sign in to see it.
      </Notice>
    );
  }

  const pricing = paymentPricing();
  const razorpay = razorpayConfigFromEnv();
  const paymentsTestMode = razorpay !== null && razorpayMode(razorpay.keyId) === 'test';
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col items-center gap-3 text-center">
        <span className="rounded-2xl bg-blue-50 p-3 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
          <Award className="size-8" aria-hidden />
        </span>
        <p className="text-sm text-neutral-500">{view.issuerName} has issued you</p>
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="claim-credential">
          {view.credentialName}
        </h1>
        {view.recipientName && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">for {view.recipientName}</p>
        )}
        {view.status === 'valid' && view.expiresAt && (
          <p className="flex items-center gap-1 text-xs text-amber-800 dark:text-amber-300">
            <Clock className="size-3.5" aria-hidden /> Claim by {DATE.format(view.expiresAt)}
          </p>
        )}
      </header>
      <ClaimFlow
        key={user?.uid ?? 'signed-out'}
        token={token}
        view={view}
        config={firebaseClientConfig()}
        signedIn={user !== null && user.role !== 'guest'}
        paymentsReady={pricing !== null}
        paymentsTestMode={paymentsTestMode}
        aiAddOnPaise={pricing?.aiEnrichmentPaise ?? null}
      />
      <p className="flex items-center justify-center gap-1.5 text-xs text-neutral-500">
        <ShieldCheck className="size-3.5" aria-hidden />
        Your credential is stored in your private vault. Only you decide who sees it.
      </p>
    </div>
  );
}

export default function ClaimPage({ params }: PageProps<'/claim/[token]'>) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
        <Suspense fallback={<p className="py-10 text-center text-sm text-neutral-500">Loading…</p>}>
          <Claim params={params} />
        </Suspense>
      </div>
    </main>
  );
}
