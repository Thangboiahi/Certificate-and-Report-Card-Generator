/**
 * HTTP handling of the escrow payment routes (ADR-028):
 *
 *   POST /api/checkout                { token, addOns? }  → 200 ClaimCheckout       (recipient)
 *   GET  /api/checkout?orderId=…                          → 200 CheckoutStatus      (recipient)
 *   POST /api/webhooks/razorpay       Razorpay event      → 2xx once consumed       (Razorpay)
 *   POST /api/cron/reconcile-payments                     → 200 SweepResult         (scheduler)
 *
 * Only the webhook (signature-verified) and our own Razorpay API calls can mint a paid
 * credential; nothing the browser sends about a payment is trusted.
 */
import 'server-only';

import type { Firestore } from 'firebase-admin/firestore';

import { authorize } from '@/lib/auth/session';
import { claimFailure, readToken } from '@/lib/claim/handler';
import {
  createRazorpayClient,
  getRazorpayClient,
  isRazorpayId,
  RazorpayApiError,
  razorpayConfigFromEnv,
  readPaymentEntity,
  verifyWebhookSignature,
  type RazorpayClient,
} from '@/lib/razorpayClient';
import { adminFirestore } from '@/lib/server/firebase-admin';
import { error, gate, json, log } from '@/lib/server/json-route';
import { CLAIM_ADD_ONS, type ClaimAddOn } from '@/types/payments';

import {
  createClaimCheckout,
  getCheckoutStatus,
  reconcileOpenCheckouts,
  refundOutstanding,
  settleCapturedPayment,
  type SettleOutcome,
} from './escrow';
import { isClaimAddOn, PricingConfigError, pricingFromEnv } from './pricing';

const SIGNED_IN = { kind: 'signed-in' } as const;

/** Razorpay's payloads are a few KB; anything far larger is not from Razorpay. */
export const MAX_WEBHOOK_BYTES = 64 * 1024;
/**
 * Razorpay waits 5 s for the webhook's answer. A refund attempted inside it makes up to two calls
 * (refund, then a status check), each capped at this; if it runs out, the refund stays
 * outstanding for the status poll and the sweep.
 */
const WEBHOOK_PROVIDER_TIMEOUT_MS = 2_000;

function readAddOns(body: unknown): ClaimAddOn[] | null {
  const addOns = (body as { addOns?: unknown } | null)?.addOns;
  if (addOns === undefined) return [];
  if (!Array.isArray(addOns) || addOns.length > CLAIM_ADD_ONS.length) return null;
  return addOns.every(isClaimAddOn) ? addOns : null;
}

function providerFailure(cause: unknown, operation: string): Response {
  if (cause instanceof PricingConfigError) {
    log('ERROR', 'pricing misconfigured', { cause: cause.message });
    return error(503, 'PAYMENTS_NOT_CONFIGURED', 'Payments are not available right now.');
  }
  if (cause instanceof RazorpayApiError) {
    log('ERROR', `${operation}: Razorpay error`, {
      status: cause.status,
      code: cause.code,
      cause: cause.message,
    });
    return error(502, 'PAYMENT_PROVIDER_ERROR', 'The payment service did not respond. Try again.');
  }
  return claimFailure(cause, operation);
}

// ── POST /api/checkout ──────────────────────────────────────────────────────────────────────────

export async function handleCheckout(request: Request): Promise<Response> {
  const checked = await gate(request, SIGNED_IN, 'Sign in to pay.');
  if (!checked.ok) return checked.response;
  const token = readToken(checked.body);
  const addOns = readAddOns(checked.body);
  if (!token || !addOns) return error(400, 'INVALID_REQUEST', 'Malformed checkout request.');
  try {
    const checkout = await createClaimCheckout({
      db: adminFirestore(),
      client: getRazorpayClient(),
      pricing: pricingFromEnv(),
      user: checked.user,
      rawToken: token,
      addOns,
    });
    log('INFO', 'checkout created', {
      uid: checked.user.uid,
      orderId: checkout.orderId,
      amount: checkout.amount,
      addOns,
    });
    return json(200, checkout);
  } catch (cause) {
    return providerFailure(cause, 'checkout');
  }
}

// ── GET /api/checkout?orderId=… ─────────────────────────────────────────────────────────────────

export async function handleCheckoutStatus(request: Request): Promise<Response> {
  const orderId = new URL(request.url).searchParams.get('orderId');
  if (!isRazorpayId('order', orderId)) return error(400, 'INVALID_REQUEST', 'Malformed order id.');
  let user;
  try {
    const result = await authorize(SIGNED_IN);
    if (result.decision !== 'allow' || !result.user) {
      return error(401, 'UNAUTHENTICATED', 'Sign in first.');
    }
    user = result.user;
  } catch (cause) {
    log('ERROR', 'auth unavailable', { cause: String(cause) });
    return error(503, 'AUTH_UNAVAILABLE', 'Sign-in could not be checked. Try again shortly.');
  }
  try {
    return json(
      200,
      await getCheckoutStatus({ db: adminFirestore(), client: getRazorpayClient(), user, orderId }),
    );
  } catch (cause) {
    return providerFailure(cause, 'checkout status');
  }
}

// ── POST /api/webhooks/razorpay ─────────────────────────────────────────────────────────────────

export interface WebhookDependencies {
  /** `RAZORPAY_WEBHOOK_SECRET`; `null` = not configured. */
  webhookSecret: string | null;
  db: () => Firestore;
  /** For refunds made while answering; `null` when API keys are missing. */
  client: () => RazorpayClient | null;
}

function webhookDependencies(): WebhookDependencies {
  const config = razorpayConfigFromEnv();
  return {
    webhookSecret: config?.webhookSecret ?? process.env.RAZORPAY_WEBHOOK_SECRET?.trim() ?? null,
    db: adminFirestore,
    client: () =>
      config ? createRazorpayClient(config, { timeoutMs: WEBHOOK_PROVIDER_TIMEOUT_MS }) : null,
  };
}

const NEEDS_REFUND: ReadonlySet<SettleOutcome['result']> = new Set(['refund_due', 'stray_payment']);

/**
 * Razorpay's webhook. Order of checks: configured → size → EXACT signature over the raw bytes →
 * parse → event type. Nothing is read from or written to the database before the signature has
 * been verified. Answers 2xx once the event is durably recorded (or deliberately ignored), and
 * 5xx only when recording failed, so that Razorpay retries.
 */
export async function handleRazorpayWebhook(
  request: Request,
  deps: WebhookDependencies = webhookDependencies(),
): Promise<Response> {
  const eventId = request.headers.get('x-razorpay-event-id')?.slice(0, 64) ?? null;
  if (!deps.webhookSecret) {
    log('ERROR', 'razorpay webhook received but RAZORPAY_WEBHOOK_SECRET is not set', { eventId });
    return error(503, 'NOT_CONFIGURED', 'Webhook not configured.');
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_WEBHOOK_BYTES) return error(413, 'TOO_LARGE', 'Payload too large.');
  const raw = new Uint8Array(await request.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (raw.byteLength === 0) return error(400, 'EMPTY', 'Empty payload.');
  if (raw.byteLength > MAX_WEBHOOK_BYTES) return error(413, 'TOO_LARGE', 'Payload too large.');

  if (
    !verifyWebhookSignature(raw, request.headers.get('x-razorpay-signature'), deps.webhookSecret)
  ) {
    log('WARNING', 'razorpay webhook signature rejected', { eventId, bytes: raw.byteLength });
    return error(401, 'INVALID_SIGNATURE', 'Signature verification failed.');
  }

  let event: { event?: unknown; payload?: { payment?: { entity?: unknown } } };
  try {
    event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    log('ERROR', 'razorpay webhook: signed payload is not JSON', { eventId });
    return error(400, 'INVALID_JSON', 'Payload is not JSON.');
  }
  const type = typeof event?.event === 'string' ? event.event.slice(0, 64) : 'unknown';
  if (type !== 'payment.captured') return json(200, { received: true, ignored: type });

  const payment = readPaymentEntity(event.payload?.payment?.entity);
  if (!payment) {
    // Signed by Razorpay but not in the shape we expect: do not make Razorpay retry for a day
    // (it disables failing webhooks); the reconciliation sweep pulls the payment instead.
    log('ERROR', 'razorpay webhook: malformed payment entity', { eventId });
    return json(200, { received: true, ignored: 'malformed' });
  }
  if (!payment.order_id) return json(200, { received: true, ignored: 'no_order' });

  let outcome: SettleOutcome;
  const db = deps.db();
  try {
    outcome = await settleCapturedPayment({ db, payment, source: 'webhook' });
  } catch (cause) {
    log('ERROR', 'razorpay webhook: settlement failed', {
      eventId,
      orderId: payment.order_id,
      paymentId: payment.id,
      cause: String(cause),
    });
    return error(500, 'SETTLEMENT_FAILED', 'Could not record the payment; retry.');
  }
  log(outcome.result === 'unknown_order' ? 'WARNING' : 'INFO', 'razorpay payment captured', {
    eventId,
    paymentId: payment.id,
    ...outcome,
  });

  if (NEEDS_REFUND.has(outcome.result)) {
    // Recorded already; the refund is best effort here (time-boxed) and retried by the status
    // poll and the sweep.
    const client = deps.client();
    if (client) {
      await refundOutstanding({ db, client, orderId: payment.order_id }).catch((cause: unknown) =>
        log('ERROR', 'razorpay webhook: refund attempt failed', {
          orderId: payment.order_id,
          cause: String(cause),
        }),
      );
    }
  }
  return json(200, { received: true, outcome: outcome.result });
}

// ── POST /api/cron/reconcile-payments ───────────────────────────────────────────────────────────

/** Sweep for lost webhooks and outstanding refunds. Caller has checked the cron secret. */
export async function handleReconcileSweep(): Promise<Response> {
  const client = getRazorpayClient();
  if (!client) return error(503, 'PAYMENTS_NOT_CONFIGURED', 'Razorpay keys are not set.');
  try {
    const result = await reconcileOpenCheckouts({ db: adminFirestore(), client });
    log('INFO', 'payment reconciliation sweep', result);
    return json(200, result);
  } catch (cause) {
    log('ERROR', 'payment reconciliation sweep failed', { cause: String(cause) });
    return error(503, 'UNAVAILABLE', 'Sweep failed; it will run again.');
  }
}
