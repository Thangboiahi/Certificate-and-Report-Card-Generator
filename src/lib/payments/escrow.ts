/**
 * The escrow payment engine for pay-to-claim credentials (Phase 8, ADR-028).
 *
 *   createClaimCheckout     the recipient (signed in with the contact the link was sent to) asks
 *                           to pay: the server prices the cart, splits it, and opens a Razorpay
 *                           order whose Route transfer sends the issuer's share to their Linked
 *                           Account ON HOLD (escrow); `claim_orders/{orderId}` records it all.
 *   settleCapturedPayment   a captured payment, from a SIGNATURE-VERIFIED webhook or fetched from
 *                           Razorpay's API by us — never from the browser. One transaction mints
 *                           the vault item, consumes the claim token and marks the order paid; or,
 *                           if the claim can no longer be honoured, marks a refund as due.
 *   refundOutstanding       refunds what is due with `reverse_all`, which also takes back the
 *                           issuer's (still held) transfer. Safe to repeat.
 *   reconcileOrder          pull reconciliation: asks Razorpay for the order's payments and settles
 *                           any capture we have not heard about (late or lost webhooks).
 *
 * Every step is idempotent: Razorpay delivers webhooks at least once and in any order, and the
 * webhook, the status poll and the sweep may race on the same order.
 */
import 'server-only';

import {
  FieldValue,
  Timestamp,
  type DocumentSnapshot,
  type Firestore,
} from 'firebase-admin/firestore';

import {
  checkClaimable,
  ClaimError,
  credentialNameOf,
  loadClaim,
  mintVaultItem,
} from '@/lib/claim/claim';
import type { StoredClaimToken } from '@/lib/claim/claim';
import type { RazorpayClient, RazorpayPayment } from '@/lib/razorpayClient';
import type {
  CartLine,
  CheckoutStatus,
  ClaimAddOn,
  ClaimOrderDocument,
  RefundReason,
  SettledBy,
} from '@/types/payments';
import { COLLECTIONS, type SessionUser } from '@/types/roles';

import {
  buildClaimCart,
  CartError,
  cartTotal,
  splitClaimCart,
  type PricingPolicy,
} from './pricing';

const DAY_MS = 86_400_000;
/** At most one pull reconciliation per order in this interval (status polls are frequent). */
export const RECONCILE_INTERVAL_MS = 5_000;

const ordersOf = (db: Firestore) => db.collection(COLLECTIONS.claimOrders);

// ── Checkout ────────────────────────────────────────────────────────────────────────────────────

export interface ClaimCheckout {
  orderId: string;
  /** Public key for Razorpay Checkout. */
  keyId: string;
  amount: number;
  currency: 'INR';
  cart: CartLine[];
  issuerName: string;
  credentialName: string;
}

export async function createClaimCheckout(input: {
  db: Firestore;
  client: RazorpayClient | null;
  pricing: PricingPolicy;
  user: SessionUser;
  rawToken: string;
  addOns: readonly ClaimAddOn[];
  now?: number;
}): Promise<ClaimCheckout> {
  const { db, client, pricing, user } = input;
  const now = input.now ?? Date.now();
  const loaded = checkClaimable(await loadClaim(db, input.rawToken), user, now);
  if (loaded.token.claimedAt) {
    throw new ClaimError('NOT_PAYABLE', 'This credential is already in your vault.');
  }
  const fee = loaded.token.feePaise ?? 0;
  if (fee <= 0) throw new ClaimError('NOT_PAYABLE', 'This credential is free. Claim it directly.');
  if (!client) {
    throw new ClaimError('PAYMENTS_NOT_CONFIGURED', 'Payments are not available right now.');
  }
  const account = loaded.issuer.payoutAccount;
  if (!account || !loaded.token.institutionId) {
    throw new ClaimError(
      'ISSUER_NOT_PAYABLE',
      `${loaded.issuer.name} cannot receive payments yet. Please contact them.`,
    );
  }

  const credentialName = credentialNameOf(loaded);
  let cart: CartLine[];
  let split: ReturnType<typeof splitClaimCart>;
  try {
    cart = buildClaimCart({ feePaise: fee, credentialName }, input.addOns, pricing);
    split = splitClaimCart(cart, pricing);
  } catch (cause) {
    if (cause instanceof CartError) {
      throw new ClaimError(
        cause.code === 'ADD_ON_UNAVAILABLE' ? 'ADD_ON_UNAVAILABLE' : 'NOT_PAYABLE',
        cause.message,
      );
    }
    throw cause;
  }
  const amount = cartTotal(cart);
  const holdUntil = pricing.escrowHoldDays > 0 ? now + pricing.escrowHoldDays * DAY_MS : null;

  const order = await client.orders.create({
    amount,
    currency: 'INR',
    receipt: `claim_${loaded.tokenId.slice(0, 32)}`,
    // No personal data in Razorpay's records: ids and the credential's name only.
    notes: { purpose: 'credential_claim', batch: loaded.token.batchId.slice(0, 128) },
    transfers: [
      {
        account,
        amount: split.issuerPaise,
        currency: 'INR',
        notes: { purpose: 'credential_claim', credential: credentialName.slice(0, 200) },
        linked_account_notes: ['credential'],
        on_hold: holdUntil !== null,
        ...(holdUntil !== null ? { on_hold_until: Math.floor(holdUntil / 1000) } : {}),
      },
    ],
  });

  await ordersOf(db)
    .doc(order.id)
    .create({
      tokenId: loaded.tokenId,
      batchId: loaded.token.batchId,
      uid: user.uid,
      issuerType: 'institution',
      issuerId: loaded.token.institutionId,
      issuerName: loaded.issuer.name,
      credentialName,
      addOns: [...input.addOns],
      cart,
      amount,
      currency: 'INR',
      split: {
        ...split,
        account,
        holdUntil: holdUntil === null ? null : Timestamp.fromMillis(holdUntil),
      },
      status: 'created',
      paymentId: null,
      createdAt: FieldValue.serverTimestamp(),
      paidAt: null,
      settledBy: null,
      refund: null,
      refundPending: false,
      lastReconciledAt: null,
    });

  return {
    orderId: order.id,
    keyId: client.keyId,
    amount,
    currency: 'INR',
    cart,
    issuerName: loaded.issuer.name,
    credentialName,
  };
}

// ── Settlement ──────────────────────────────────────────────────────────────────────────────────

export type SettleOutcome =
  /** Not a capture against an order (nothing to do). */
  | { result: 'ignored' }
  /** Not one of our orders (another product on the same Razorpay account). */
  | { result: 'unknown_order'; orderId: string }
  | { result: 'minted'; orderId: string; vaultItemId: string }
  /** This payment was settled before (duplicate delivery, or webhook and poll racing). */
  | { result: 'already_settled'; orderId: string }
  /** Captured but cannot be honoured: a refund is now due. */
  | { result: 'refund_due'; orderId: string; reason: RefundReason }
  /** A further capture on an order that another payment already settled: refund due. */
  | { result: 'stray_payment'; orderId: string };

/**
 * Applies one captured payment. `payment` MUST come from a source Razorpay vouches for: a
 * webhook whose signature was verified, or our own authenticated API call.
 */
export async function settleCapturedPayment(input: {
  db: Firestore;
  payment: RazorpayPayment;
  source: SettledBy;
}): Promise<SettleOutcome> {
  const { db, payment, source } = input;
  if (payment.status !== 'captured' || !payment.order_id) return { result: 'ignored' };
  const orderId = payment.order_id;
  const orderRef = ordersOf(db).doc(orderId);

  return db.runTransaction(async (transaction): Promise<SettleOutcome> => {
    const orderSnap = await transaction.get(orderRef);
    const order = orderSnap.data() as ClaimOrderDocument | undefined;
    if (!order) return { result: 'unknown_order', orderId };
    if (order.paymentId === payment.id || order.strayPayments?.[payment.id]) {
      return { result: 'already_settled', orderId };
    }
    if (order.paymentId !== null) {
      transaction.update(orderRef, {
        [`strayPayments.${payment.id}`]: {
          amount: payment.amount,
          refunded: false,
          refundId: null,
          lastError: null,
        },
        refundPending: true,
      });
      return { result: 'stray_payment', orderId };
    }

    const refundDue = (reason: RefundReason): SettleOutcome => {
      transaction.update(orderRef, {
        status: 'refund_due',
        paymentId: payment.id,
        settledBy: source,
        refund: {
          reason,
          paymentId: payment.id,
          amount: payment.amount,
          refundId: null,
          requestedAt: FieldValue.serverTimestamp(),
          refundedAt: null,
          lastError: null,
        },
        refundPending: true,
      });
      return { result: 'refund_due', orderId, reason };
    };

    const tokenRef = db.collection(COLLECTIONS.claimTokens).doc(order.tokenId);
    const batchRef = db.collection(COLLECTIONS.issuedBatches).doc(order.batchId);
    const [tokenSnap, batchSnap] = (await transaction.getAll(tokenRef, batchRef)) as [
      DocumentSnapshot,
      DocumentSnapshot,
    ];
    if (payment.amount !== order.amount || payment.currency !== order.currency) {
      return refundDue('amount_mismatch');
    }
    const token = tokenSnap.data() as StoredClaimToken | undefined;
    if (!token) return refundDue('token_gone');
    if (token.claimedAt) {
      return refundDue(token.claimedByUid === order.uid ? 'already_claimed' : 'claimed_by_other');
    }
    // The link's expiry was checked when the order was opened; a payment that completes after it
    // is still honoured (the recipient started paying in time).
    mintVaultItem(transaction, {
      db,
      tokenId: order.tokenId,
      token,
      batchSnap,
      ownerUid: order.uid,
      issuerName: order.issuerName,
      payment: { orderId, paymentId: payment.id, addOns: order.addOns },
    });
    transaction.update(orderRef, {
      status: 'paid',
      paymentId: payment.id,
      paidAt: FieldValue.serverTimestamp(),
      settledBy: source,
    });
    return { result: 'minted', orderId, vaultItemId: order.tokenId };
  });
}

// ── Refunds ─────────────────────────────────────────────────────────────────────────────────────

type RefundAttempt = { ok: true; refundId: string | null } | { ok: false; error: string };

/**
 * Refunds a payment in full and reverses its transfers. If Razorpay refuses because an earlier
 * attempt already went through (e.g. it timed out on our side), the payment's own record says
 * so and that counts as done.
 */
async function refundPayment(
  client: RazorpayClient,
  paymentId: string,
  amount: number,
  reason: RefundReason,
): Promise<RefundAttempt> {
  try {
    const refund = await client.payments.refund(paymentId, {
      amount,
      reverse_all: true,
      notes: { reason },
    });
    return { ok: true, refundId: refund.id };
  } catch (cause) {
    try {
      const payment = await client.payments.fetch(paymentId);
      if (payment.amount_refunded >= payment.amount) return { ok: true, refundId: null };
    } catch {
      // Fall through with the refund's own error.
    }
    return { ok: false, error: String(cause).slice(0, 500) };
  }
}

/**
 * Refunds everything outstanding on an order (the payment it could not honour, and any stray
 * payments). Does nothing when no refund is due. Returns how many refunds are still outstanding.
 */
export async function refundOutstanding(input: {
  db: Firestore;
  client: RazorpayClient;
  orderId: string;
}): Promise<number> {
  const { db, client, orderId } = input;
  const orderRef = ordersOf(db).doc(orderId);
  const order = (await orderRef.get()).data() as ClaimOrderDocument | undefined;
  if (!order?.refundPending) return 0;

  const main =
    order.status === 'refund_due' && order.refund
      ? await refundPayment(
          client,
          order.refund.paymentId,
          order.refund.amount,
          order.refund.reason,
        )
      : null;
  const strays = new Map<string, RefundAttempt>();
  for (const [paymentId, stray] of Object.entries(order.strayPayments ?? {})) {
    if (stray.refunded) continue;
    strays.set(
      paymentId,
      await refundPayment(client, paymentId, stray.amount, 'duplicate_payment'),
    );
  }

  // Record the attempts against the CURRENT state: a concurrent attempt may have finished first,
  // and its refund id must not be overwritten.
  return db.runTransaction(async (transaction) => {
    const current = (await transaction.get(orderRef)).data() as ClaimOrderDocument;
    const updates: Record<string, unknown> = {};
    let outstanding = 0;
    if (current.status === 'refund_due') {
      if (main?.ok) {
        updates.status = 'refunded';
        updates['refund.refundId'] = main.refundId;
        updates['refund.refundedAt'] = FieldValue.serverTimestamp();
        updates['refund.lastError'] = null;
      } else {
        outstanding++;
        if (main) updates['refund.lastError'] = main.error;
      }
    }
    for (const [paymentId, stray] of Object.entries(current.strayPayments ?? {})) {
      if (stray.refunded) continue;
      const attempt = strays.get(paymentId);
      if (attempt?.ok) {
        updates[`strayPayments.${paymentId}.refunded`] = true;
        updates[`strayPayments.${paymentId}.refundId`] = attempt.refundId;
        updates[`strayPayments.${paymentId}.lastError`] = null;
      } else {
        outstanding++;
        if (attempt) updates[`strayPayments.${paymentId}.lastError`] = attempt.error;
      }
    }
    updates.refundPending = outstanding > 0;
    transaction.update(orderRef, updates);
    return outstanding;
  });
}

// ── Reconciliation ──────────────────────────────────────────────────────────────────────────────

/**
 * Brings an order up to date with Razorpay: settles captured payments we were not told about,
 * then retries outstanding refunds.
 */
export async function reconcileOrder(input: {
  db: Firestore;
  client: RazorpayClient;
  orderId: string;
}): Promise<void> {
  const { db, client, orderId } = input;
  const order = (await ordersOf(db).doc(orderId).get()).data() as ClaimOrderDocument | undefined;
  if (!order) return;
  if (order.status === 'created') {
    const payments = await client.orders.fetchPayments(orderId);
    for (const payment of payments) {
      // Razorpay lists only this order's payments; still, never settle another order's.
      if (payment.status !== 'captured' || payment.order_id !== orderId) continue;
      await settleCapturedPayment({ db, payment, source: 'reconcile' });
    }
  }
  await refundOutstanding({ db, client, orderId });
}

/** The browser's view of its own checkout; reconciles with Razorpay at most every few seconds. */
export async function getCheckoutStatus(input: {
  db: Firestore;
  client: RazorpayClient | null;
  user: SessionUser;
  orderId: string;
  now?: number;
}): Promise<CheckoutStatus> {
  const { db, client, user, orderId } = input;
  const now = input.now ?? Date.now();
  const orderRef = ordersOf(db).doc(orderId);
  let order = (await orderRef.get()).data() as ClaimOrderDocument | undefined;
  if (!order || order.uid !== user.uid) {
    throw new ClaimError('NOT_FOUND', 'No such checkout.');
  }

  const unsettled = order.status === 'created' || order.refundPending;
  const last = (order.lastReconciledAt ?? order.createdAt)?.toMillis() ?? 0;
  if (client && unsettled && now - last >= RECONCILE_INTERVAL_MS) {
    await orderRef.update({ lastReconciledAt: Timestamp.fromMillis(now) });
    try {
      await reconcileOrder({ db, client, orderId });
    } catch (cause) {
      // The webhook may still arrive; the next poll or the sweep tries again.
      console.error(
        JSON.stringify({
          severity: 'ERROR',
          message: 'checkout reconcile failed',
          orderId,
          cause: String(cause),
        }),
      );
    }
    order = (await orderRef.get()).data() as ClaimOrderDocument;
  }

  return {
    orderId,
    status: order.status,
    vaultItemId: order.status === 'paid' ? order.tokenId : null,
    refundReason: order.refund?.reason ?? null,
  };
}

export interface SweepResult {
  /** Orders looked at. */
  checked: number;
  /** Open orders found captured and settled (minted, or refund due). */
  settled: number;
  /** Orders that still have a refund outstanding afterwards. */
  refundsOutstanding: number;
  /** Orders that could not be reconciled (Razorpay or Firestore failure). */
  errors: number;
}

/** How far back the sweep looks for open orders whose capture we may have missed. */
export const SWEEP_LOOKBACK_MS = 3 * DAY_MS;
/** Orders younger than this are left to the webhook. */
export const SWEEP_MIN_AGE_MS = 2 * 60_000;

/**
 * The reconciliation sweep (`POST /api/cron/reconcile-payments`): open orders of the last three
 * days whose webhook may have been lost, and every order with a refund still outstanding.
 */
export async function reconcileOpenCheckouts(input: {
  db: Firestore;
  client: RazorpayClient;
  now?: number;
  limit?: number;
}): Promise<SweepResult> {
  const { db, client } = input;
  const now = input.now ?? Date.now();
  const limit = input.limit ?? 100;
  const [open, refunds] = await Promise.all([
    ordersOf(db)
      .where('status', '==', 'created')
      .where('createdAt', '>=', Timestamp.fromMillis(now - SWEEP_LOOKBACK_MS))
      .where('createdAt', '<=', Timestamp.fromMillis(now - SWEEP_MIN_AGE_MS))
      .orderBy('createdAt')
      .limit(limit)
      .get(),
    ordersOf(db).where('refundPending', '==', true).limit(limit).get(),
  ]);
  const ids = new Set([...open.docs, ...refunds.docs].map((doc) => doc.id));
  const result: SweepResult = { checked: ids.size, settled: 0, refundsOutstanding: 0, errors: 0 };
  for (const orderId of ids) {
    const orderRef = ordersOf(db).doc(orderId);
    try {
      const before = (await orderRef.get()).get('status') as string;
      await reconcileOrder({ db, client, orderId });
      const after = (await orderRef.get()).data() as ClaimOrderDocument;
      if (before === 'created' && after.status !== 'created') result.settled++;
      if (after.refundPending) result.refundsOutstanding++;
    } catch (cause) {
      result.errors++;
      console.error(
        JSON.stringify({
          severity: 'ERROR',
          message: 'payment sweep failed for an order',
          orderId,
          cause: String(cause),
        }),
      );
    }
  }
  return result;
}
