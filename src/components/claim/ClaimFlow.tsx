'use client';

/**
 * The interactive part of the claim page:
 *
 *   not signed in            → passwordless sign-in with the channel the link came through
 *   signed in, wrong contact → explain, offer to switch account
 *   signed in, free          → claims at once ("claim instantly to Vault")
 *   signed in, fee           → cart (Base Fee + optional AI add-on) → POST /api/checkout →
 *                              Razorpay Checkout → poll GET /api/checkout until the server has
 *                              seen the capture (webhook) and minted the credential (ADR-028).
 *                              The browser's own success callback proves nothing and mints
 *                              nothing.
 *
 * After signing in, the server page is refreshed so it re-checks the account against the link.
 */
import { CheckCircle2, CreditCard, LoaderCircle, Sparkles, UserRoundX, Wallet } from 'lucide-react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { PasswordlessSignIn } from '@/components/auth/PasswordlessSignIn';
import type { ClaimView } from '@/lib/claim/claim';
import { endSession, type FirebaseClientConfig } from '@/lib/firebase';
import type { CartLine, CheckoutStatus, ClaimAddOn, RefundReason } from '@/types/payments';

type Phase =
  | { kind: 'sign-in' }
  | { kind: 'mismatch' }
  | { kind: 'claiming' }
  | { kind: 'pay' }
  | { kind: 'paying' }
  | { kind: 'confirming'; orderId: string }
  | { kind: 'unconfirmed' }
  | { kind: 'done' }
  | { kind: 'error'; message: string; retry: 'claim' | 'pay' | null };

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

async function requestJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(
    url,
    body === undefined
      ? { cache: 'no-store' }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const json = (await response.json().catch(() => null)) as
    (T & { error?: undefined }) | { error: { code: string; message: string } } | null;
  if (!response.ok || !json || json.error) {
    throw new Error(json?.error?.message ?? 'Something went wrong. Please try again.');
  }
  return json as T;
}

interface ClaimCheckout {
  orderId: string;
  keyId: string;
  amount: number;
  currency: string;
  cart: CartLine[];
  issuerName: string;
  credentialName: string;
}

const REFUND_REASONS: Record<RefundReason, string> = {
  already_claimed: 'This credential was already in your vault, so this payment was not needed.',
  claimed_by_other: 'This credential was claimed before your payment arrived.',
  token_gone: 'This claim link was withdrawn before your payment arrived.',
  amount_mismatch: 'The payment did not match the order.',
  duplicate_payment: 'This order had already been paid.',
};

/** How often, and for how long, the page asks whether the payment has been confirmed. */
const POLL_INTERVAL_MS = 2_000;
const POLL_ATTEMPTS = 60;

export interface ClaimFlowProps {
  token: string;
  view: ClaimView;
  config: FirebaseClientConfig | null;
  signedIn: boolean;
  /** Whether the server can take payments at all (Razorpay keys and pricing configured). */
  paymentsReady: boolean;
  /** Price of the AI enrichment add-on, or `null` when it is not offered. */
  aiAddOnPaise: number | null;
}

export function ClaimFlow({
  token,
  view,
  config,
  signedIn,
  paymentsReady,
  aiAddOnPaise,
}: ClaimFlowProps) {
  const router = useRouter();
  const fee = view.feePaise ?? 0;
  const [addAi, setAddAi] = useState(false);
  const total = fee + (addAi && aiAddOnPaise !== null ? aiAddOnPaise : 0);
  const unmounted = useRef(false);
  useEffect(
    () => () => {
      unmounted.current = true;
    },
    [],
  );
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

  async function claim() {
    setPhase({ kind: 'claiming' });
    try {
      await requestJson('/api/claim', { token });
      setPhase({ kind: 'done' });
    } catch (error) {
      setPhase({ kind: 'error', message: (error as Error).message, retry: 'claim' });
    }
  }

  /** Waits for the server to confirm the capture (webhook or its own check with Razorpay). */
  async function confirm(orderId: string) {
    setPhase({ kind: 'confirming', orderId });
    for (let attempt = 0; attempt < POLL_ATTEMPTS && !unmounted.current; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      let status: CheckoutStatus;
      try {
        status = await requestJson<CheckoutStatus>(
          `/api/checkout?orderId=${encodeURIComponent(orderId)}`,
        );
      } catch {
        continue; // A failed poll is not a failed payment; ask again.
      }
      if (status.status === 'paid') {
        setPhase({ kind: 'done' });
        return;
      }
      if (status.status === 'refund_due' || status.status === 'refunded') {
        const why = status.refundReason ? REFUND_REASONS[status.refundReason] : '';
        setPhase({
          kind: 'error',
          message: `${why} Your payment will be refunded to the account you paid from.`.trim(),
          retry: null,
        });
        return;
      }
    }
    if (!unmounted.current) setPhase({ kind: 'unconfirmed' });
  }

  async function pay() {
    setPhase({ kind: 'paying' });
    try {
      const addOns: ClaimAddOn[] = addAi && aiAddOnPaise !== null ? ['ai_enrichment'] : [];
      const order = await requestJson<ClaimCheckout>('/api/checkout', { token, addOns });
      await loadCheckout();
      const checkout = new window.Razorpay!({
        key: order.keyId,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        name: order.issuerName,
        description: order.credentialName,
        theme: { color: '#2563eb' },
        // Razorpay calls this once the payment went through on its side. The response's
        // signature is not used: the server mints only after Razorpay tells IT (webhook).
        handler: () => void confirm(order.orderId),
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

  if (phase.kind === 'claiming' || phase.kind === 'paying' || phase.kind === 'confirming') {
    return (
      <p
        className="flex items-center justify-center gap-2 py-6 text-sm"
        role="status"
        data-testid={`claim-${phase.kind}`}
      >
        <LoaderCircle className="size-5 animate-spin" aria-hidden />
        {phase.kind === 'paying'
          ? 'Opening secure payment…'
          : phase.kind === 'confirming'
            ? 'Confirming your payment…'
            : 'Adding to your vault…'}
      </p>
    );
  }

  if (phase.kind === 'unconfirmed') {
    return (
      <div className="flex flex-col gap-3 text-center" data-testid="claim-unconfirmed">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          We have not received confirmation of your payment yet. This can take a few minutes; the
          credential will appear in your vault as soon as it arrives. If the payment does not go
          through, any amount taken is refunded automatically.
        </p>
        <Link
          href="/dashboard/vault"
          className={`${button} border border-neutral-300 dark:border-neutral-700`}
        >
          <Wallet className="size-5" aria-hidden />
          Go to my vault
        </Link>
      </div>
    );
  }

  if (phase.kind === 'pay') {
    if (!view.payable || !paymentsReady) {
      return (
        <p
          role="alert"
          className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          data-testid="claim-not-payable"
        >
          {view.issuerName} charges {rupees(fee)} for this credential, but online payment is not
          available for it yet. Please contact {view.issuerName}.
        </p>
      );
    }
    return (
      <div className="flex flex-col gap-3" data-testid="claim-pay">
        <dl className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800">
          <div className="flex justify-between gap-3">
            <dt className="text-neutral-600 dark:text-neutral-400">{view.credentialName}</dt>
            <dd className="tabular-nums">{rupees(fee)}</dd>
          </div>
          {aiAddOnPaise !== null && (
            <div className="flex items-center justify-between gap-3">
              <dt>
                <label className="flex min-h-11 cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-5 accent-blue-600"
                    checked={addAi}
                    onChange={(event) => setAddAi(event.target.checked)}
                    data-testid="add-on-ai"
                  />
                  <Sparkles className="size-4 text-blue-600" aria-hidden />
                  Add AI enrichment
                </label>
              </dt>
              <dd className="tabular-nums">{rupees(aiAddOnPaise)}</dd>
            </div>
          )}
          <div className="flex justify-between gap-3 border-t border-neutral-200 pt-2 font-semibold dark:border-neutral-800">
            <dt>Total</dt>
            <dd className="tabular-nums" data-testid="cart-total">
              {rupees(total)}
            </dd>
          </div>
        </dl>
        <p className="text-xs text-neutral-500">
          Pay securely with UPI, card or net banking. If the credential cannot be added to your
          vault, you are refunded automatically.
        </p>
        <button
          type="button"
          onClick={() => void pay()}
          className={`${button} bg-blue-600 text-white hover:bg-blue-700`}
          data-testid="pay-and-claim"
        >
          <CreditCard className="size-5" aria-hidden />
          Pay {rupees(total)} and claim
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
