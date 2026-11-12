'use client';

/**
 * The interactive part of the claim page:
 *
 *   not signed in            → passwordless sign-in with the channel the link came through
 *   signed in, wrong contact → explain, offer to switch account
 *   signed in, free          → claims at once ("claim instantly to Vault")
 *   signed in, fee           → Razorpay Checkout, then claims with the verified payment
 *
 * After signing in, the server page is refreshed so it re-checks the account against the link.
 */
import { CheckCircle2, CreditCard, LoaderCircle, UserRoundX, Wallet } from 'lucide-react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { PasswordlessSignIn } from '@/components/auth/PasswordlessSignIn';
import type { ClaimView } from '@/lib/claim/claim';
import { endSession, type FirebaseClientConfig } from '@/lib/firebase';

type Phase =
  | { kind: 'sign-in' }
  | { kind: 'mismatch' }
  | { kind: 'claiming' }
  | { kind: 'pay' }
  | { kind: 'paying' }
  | { kind: 'done' }
  | { kind: 'error'; message: string; retry: 'claim' | 'pay' | null };

interface RazorpayResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}
interface RazorpayInstance {
  open(): void;
}
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_SRC;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Razorpay could not be loaded.'));
    document.head.append(script);
  });
}

const rupees = (paise: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => null)) as
    (T & { error?: undefined }) | { error: { code: string; message: string } } | null;
  if (!response.ok || !json || json.error) {
    throw new Error(json?.error?.message ?? 'Something went wrong. Please try again.');
  }
  return json as T;
}

export interface ClaimFlowProps {
  token: string;
  view: ClaimView;
  config: FirebaseClientConfig | null;
  signedIn: boolean;
}

export function ClaimFlow({ token, view, config, signedIn }: ClaimFlowProps) {
  const router = useRouter();
  const fee = view.feePaise ?? 0;
  const [phase, setPhase] = useState<Phase>(() =>
    view.claimedByUser
      ? { kind: 'done' }
      : !signedIn
        ? { kind: 'sign-in' }
        : !view.matchesUser
          ? { kind: 'mismatch' }
          : fee > 0
            ? { kind: 'pay' }
            : { kind: 'claiming' },
  );
  const started = useRef(false);

  async function claim(payment?: { orderId: string; paymentId: string; signature: string }) {
    setPhase({ kind: 'claiming' });
    try {
      await postJson('/api/claim', { token, ...(payment ? { payment } : {}) });
      setPhase({ kind: 'done' });
    } catch (error) {
      setPhase({ kind: 'error', message: (error as Error).message, retry: 'claim' });
    }
  }

  async function pay() {
    setPhase({ kind: 'paying' });
    try {
      const order = await postJson<{
        orderId: string;
        amount: number;
        currency: string;
        keyId: string;
        issuerName: string;
        credentialName: string;
      }>('/api/claim/order', { token });
      await loadCheckout();
      const checkout = new window.Razorpay!({
        key: order.keyId,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        name: order.issuerName,
        description: order.credentialName,
        theme: { color: '#2563eb' },
        handler: (response: RazorpayResponse) =>
          void claim({
            orderId: response.razorpay_order_id,
            paymentId: response.razorpay_payment_id,
            signature: response.razorpay_signature,
          }),
        modal: { ondismiss: () => setPhase({ kind: 'pay' }) },
      });
      checkout.open();
    } catch (error) {
      setPhase({ kind: 'error', message: (error as Error).message, retry: 'pay' });
    }
  }

  // Free credential and the right person is signed in: claim straight away.
  useEffect(() => {
    if (phase.kind !== 'claiming' || started.current) return;
    started.current = true;
    queueMicrotask(() => void claim());
    // Runs once when the page opens in the claiming state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const button =
    'inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-4 text-base font-medium';

  if (phase.kind === 'sign-in') {
    if (!config) {
      return (
        <p role="alert" className="text-sm text-red-700">
          Sign-in is not available right now. Please try again later.
        </p>
      );
    }
    return (
      <PasswordlessSignIn
        config={config}
        methods={view.channel === 'email' ? ['email'] : ['phone']}
        returnPath={`/claim/${token}`}
        hint={`Sign in with the ${view.channel === 'email' ? 'email address' : 'mobile number'} this was sent to (${view.maskedContact}). No password needed.`}
        onSignedIn={() => router.refresh()}
      />
    );
  }

  if (phase.kind === 'mismatch') {
    return (
      <div className="flex flex-col gap-3" data-testid="claim-mismatch">
        <p className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <UserRoundX className="mt-0.5 size-4 shrink-0" aria-hidden />
          You are signed in with a different {view.channel === 'email' ? 'email address' : 'number'}
          . This credential was sent to {view.maskedContact}.
        </p>
        <button
          type="button"
          className={`${button} border border-neutral-300 dark:border-neutral-700`}
          onClick={async () => {
            await endSession();
            router.refresh();
          }}
        >
          Sign in with {view.maskedContact}
        </button>
      </div>
    );
  }

  if (phase.kind === 'claiming' || phase.kind === 'paying') {
    return (
      <p className="flex items-center justify-center gap-2 py-6 text-sm" role="status">
        <LoaderCircle className="size-5 animate-spin" aria-hidden />
        {phase.kind === 'paying' ? 'Opening secure payment…' : 'Adding to your vault…'}
      </p>
    );
  }

  if (phase.kind === 'pay') {
    return (
      <div className="flex flex-col gap-3" data-testid="claim-pay">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {view.issuerName} charges {rupees(fee)} to issue this credential. Pay securely with UPI,
          card or net banking.
        </p>
        <button
          type="button"
          onClick={() => void pay()}
          className={`${button} bg-blue-600 text-white hover:bg-blue-700`}
          data-testid="pay-and-claim"
        >
          <CreditCard className="size-5" aria-hidden />
          Pay {rupees(fee)} and claim
        </button>
      </div>
    );
  }

  if (phase.kind === 'error') {
    return (
      <div className="flex flex-col gap-3">
        <p
          role="alert"
          className="rounded-xl bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
        >
          {phase.message}
        </p>
        {phase.retry && (
          <button
            type="button"
            className={`${button} border border-neutral-300 dark:border-neutral-700`}
            onClick={() => void (phase.retry === 'pay' ? pay() : claim())}
          >
            Try again
          </button>
        )}
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex flex-col items-center gap-3 py-2 text-center"
      data-testid="claim-done"
    >
      <CheckCircle2 className="size-12 text-emerald-600" aria-hidden />
      <h2 className="text-lg font-semibold">Added to your vault</h2>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {view.credentialName} from {view.issuerName} is now in your digital vault.
      </p>
      <Link
        href="/dashboard/vault"
        className={`${button} bg-blue-600 text-white hover:bg-blue-700`}
      >
        <Wallet className="size-5" aria-hidden />
        Open my vault
      </Link>
    </motion.div>
  );
}
