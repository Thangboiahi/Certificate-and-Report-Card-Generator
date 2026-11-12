/**
 * The escrow payment engine against the Firestore emulator, with an in-memory Razorpay:
 * checkout pricing and Route split, minting on capture, idempotency under replays and races,
 * refunds with transfer reversal, pull reconciliation and the sweep.
 *
 *     npm run test:emulator
 */
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { claimCredential, ClaimError } from '@/lib/claim/claim';
import {
  RazorpayApiError,
  type RazorpayClient,
  type RazorpayOrderRequest,
  type RazorpayPayment,
  type RazorpayRefundRequest,
} from '@/lib/razorpayClient';
import { adminFirestore } from '@/lib/server/firebase-admin';
import { hashClaimToken, mintClaimToken, purgeAfterFor } from '@/lib/utils/tokenManager';
import type { ClaimOrderDocument } from '@/types/payments';
import { COLLECTIONS, type InstitutionDocument, type SessionUser } from '@/types/roles';

import { clearFirestore, HAS_EMULATORS } from '../../../tests/support/firebase-emulator';
import {
  createClaimCheckout,
  getCheckoutStatus,
  reconcileOpenCheckouts,
  refundOutstanding,
  settleCapturedPayment,
} from './escrow';
import type { PricingPolicy } from './pricing';

const DAY = 86_400_000;
const ACCOUNT = 'acc_SchoolA0000001';
const PRICING: PricingPolicy = {
  platformFeeBps: 1_000,
  aiEnrichmentPaise: 4_900,
  escrowHoldDays: 7,
};
const RECIPIENT: SessionUser = {
  uid: 'recipient-1',
  email: 'asha@example.in',
  role: 'individual',
  institutionId: null,
  emailVerified: true,
};
const STRANGER: SessionUser = { ...RECIPIENT, uid: 'stranger', email: 'someone@example.in' };

const db = () => adminFirestore();

/** An in-memory Razorpay that records orders and refunds and lets tests capture payments. */
function fakeRazorpay() {
  const orders: (RazorpayOrderRequest & { id: string })[] = [];
  const payments = new Map<string, RazorpayPayment>();
  const refunds: { paymentId: string; request: RazorpayRefundRequest }[] = [];
  let refundFailures = 0;
  const client: RazorpayClient = {
    keyId: 'rzp_test_key',
    orders: {
      create: vi.fn(async (request: RazorpayOrderRequest) => {
        const id = `order_Test${String(orders.length + 1).padStart(10, '0')}`;
        orders.push({ ...request, id });
        return { id, amount: request.amount, currency: 'INR', status: 'created' };
      }),
      fetchPayments: vi.fn(async (orderId: string) =>
        [...payments.values()].filter((payment) => payment.order_id === orderId),
      ),
    },
    payments: {
      fetch: vi.fn(async (id: string) => {
        const payment = payments.get(id);
        if (!payment) throw new RazorpayApiError(400, 'BAD_REQUEST_ERROR', 'no such payment');
        return payment;
      }),
      refund: vi.fn(async (paymentId: string, request: RazorpayRefundRequest) => {
        if (refundFailures > 0) {
          refundFailures--;
          throw new RazorpayApiError(0, null, 'Razorpay unreachable');
        }
        const payment = payments.get(paymentId)!;
        if (payment.amount_refunded + request.amount > payment.amount) {
          throw new RazorpayApiError(400, 'BAD_REQUEST_ERROR', 'greater than available amount');
        }
        payment.amount_refunded += request.amount;
        refunds.push({ paymentId, request });
        return {
          id: `rfnd_Test${String(refunds.length).padStart(10, '0')}`,
          payment_id: paymentId,
          amount: request.amount,
          status: 'processed',
        };
      }),
    },
  };
  return {
    client,
    orders,
    refunds,
    /** Records a captured payment on Razorpay's side and returns it (as a webhook would carry). */
    capture(orderId: string, amount?: number): RazorpayPayment {
      const order = orders.find((o) => o.id === orderId)!;
      const payment: RazorpayPayment = {
        id: `pay_Test${String(payments.size + 1).padStart(10, '0')}`,
        order_id: orderId,
        amount: amount ?? order.amount,
        currency: 'INR',
        status: 'captured',
        amount_refunded: 0,
      };
      payments.set(payment.id, payment);
      return { ...payment };
    },
    failNextRefunds(count: number) {
      refundFailures = count;
    },
  };
}

async function institution(id: string, overrides: Partial<InstitutionDocument> = {}) {
  await db()
    .collection(COLLECTIONS.institutions)
    .doc(id)
    .set({
      name: id === 'school-a' ? 'Sunrise Public School' : 'Other School',
      adminUid: 'admin-1',
      staffUids: ['staff-1'],
      creditBalance: 10,
      verified: true,
      ...overrides,
    } satisfies InstitutionDocument);
}

/** A claim token sent by email to `contact`; returns the raw token and its id. */
async function claimToken({
  feePaise = 10_000,
  institutionId = 'school-a',
  contact = 'asha@example.in',
  expiresInMs = 7 * DAY,
}: { feePaise?: number; institutionId?: string; contact?: string; expiresInMs?: number } = {}) {
  const raw = mintClaimToken();
  const id = await hashClaimToken(raw);
  const expiresAt = new Date(Date.now() + expiresInMs);
  await db()
    .collection(COLLECTIONS.claimTokens)
    .doc(id)
    .set({
      batchId: 'batch-1',
      institutionId,
      issuerUid: 'staff-1',
      channel: 'email',
      recipientName: 'Asha Verma',
      contact,
      expiresAt: Timestamp.fromDate(expiresAt),
      purgeAfter: Timestamp.fromDate(purgeAfterFor(expiresAt)),
      claimedAt: null,
      feePaise,
    });
  return { raw, id };
}

const checkout = (
  razorpay: ReturnType<typeof fakeRazorpay>,
  raw: string,
  options: { user?: SessionUser; addOns?: 'ai_enrichment'[]; pricing?: PricingPolicy } = {},
) =>
  createClaimCheckout({
    db: db(),
    client: razorpay.client,
    pricing: options.pricing ?? PRICING,
    user: options.user ?? RECIPIENT,
    rawToken: raw,
    addOns: options.addOns ?? [],
  });

const orderDoc = async (id: string) =>
  (await db().collection(COLLECTIONS.claimOrders).doc(id).get()).data() as ClaimOrderDocument;
const tokenDoc = async (id: string) =>
  (await db().collection(COLLECTIONS.claimTokens).doc(id).get()).data();
const vaultItem = async (id: string) =>
  (await db().collection(COLLECTIONS.vaultItems).doc(id).get()).data();
const claimedCount = async () =>
  (await db().collection(COLLECTIONS.issuedBatches).doc('batch-1').get()).get(
    'claimedCount',
  ) as number;

const settle = (payment: RazorpayPayment, source: 'webhook' | 'reconcile' = 'webhook') =>
  settleCapturedPayment({ db: db(), payment, source });

describe.skipIf(!HAS_EMULATORS)('escrow payment engine (Firestore emulator)', () => {
  beforeEach(async () => {
    await clearFirestore();
    await institution('school-a', { razorpayAccountId: ACCOUNT });
    await institution('school-b');
    await db().collection(COLLECTIONS.issuedBatches).doc('batch-1').set({
      issuerUid: 'staff-1',
      institutionId: 'school-a',
      templateId: 'tpl-cert',
      templateName: 'Class 10 certificate',
      claimedCount: 0,
    });
  });

  describe('checkout', () => {
    it('prices the cart on the server and routes the issuer share to their account, on hold', async () => {
      const razorpay = fakeRazorpay();
      const { raw, id } = await claimToken({ feePaise: 10_000 });
      const before = Date.now();
      const result = await checkout(razorpay, raw, { addOns: ['ai_enrichment'] });

      expect(result).toMatchObject({
        keyId: 'rzp_test_key',
        amount: 14_900,
        currency: 'INR',
        issuerName: 'Sunrise Public School',
        credentialName: 'Class 10 certificate',
        cart: [
          { kind: 'base', label: 'Class 10 certificate', amountPaise: 10_000 },
          { kind: 'ai_enrichment', label: 'AI enrichment', amountPaise: 4_900 },
        ],
      });
      const [order] = razorpay.orders;
      expect(order).toMatchObject({ amount: 14_900, currency: 'INR' });
      expect(order!.receipt!.length).toBeLessThanOrEqual(40);
      expect(order!.transfers).toHaveLength(1);
      const transfer = order!.transfers![0]!;
      expect(transfer).toMatchObject({
        account: ACCOUNT,
        amount: 9_000, // 10,000 − 10 % platform fee; the AI add-on stays with the platform
        currency: 'INR',
        on_hold: true,
      });
      const holdUntil = transfer.on_hold_until! * 1000;
      expect(holdUntil).toBeGreaterThanOrEqual(before + 7 * DAY - 1000);
      expect(holdUntil).toBeLessThanOrEqual(Date.now() + 7 * DAY);
      // No personal data goes to Razorpay.
      expect(JSON.stringify(order)).not.toMatch(/asha|Asha|recipient-1/);

      const stored = await orderDoc(result.orderId);
      expect(stored).toMatchObject({
        tokenId: id,
        uid: RECIPIENT.uid,
        issuerType: 'institution',
        issuerId: 'school-a',
        amount: 14_900,
        addOns: ['ai_enrichment'],
        split: { platformPaise: 5_900, issuerPaise: 9_000, account: ACCOUNT },
        status: 'created',
        paymentId: null,
        refundPending: false,
      });
    });

    it('releases on Razorpay’s schedule when the escrow hold is 0 days', async () => {
      const razorpay = fakeRazorpay();
      const { raw } = await claimToken();
      const result = await checkout(razorpay, raw, { pricing: { ...PRICING, escrowHoldDays: 0 } });
      expect(razorpay.orders[0]!.transfers![0]).toMatchObject({ on_hold: false });
      expect(razorpay.orders[0]!.transfers![0]).not.toHaveProperty('on_hold_until');
      expect((await orderDoc(result.orderId)).split.holdUntil).toBeNull();
    });

    it('opens nothing at Razorpay for anyone but the recipient, or for an unpayable claim', async () => {
      const razorpay = fakeRazorpay();
      const paid = await claimToken();
      const free = await claimToken({ feePaise: 0 });
      const unpayable = await claimToken({ institutionId: 'school-b' });
      const expired = await claimToken({ expiresInMs: -1000 });
      const cases: [() => Promise<unknown>, string][] = [
        [() => checkout(razorpay, paid.raw, { user: STRANGER }), 'CONTACT_MISMATCH'],
        [
          () => checkout(razorpay, paid.raw, { user: { ...RECIPIENT, emailVerified: false } }),
          'CONTACT_MISMATCH',
        ],
        [() => checkout(razorpay, free.raw), 'NOT_PAYABLE'],
        [() => checkout(razorpay, unpayable.raw), 'ISSUER_NOT_PAYABLE'],
        [() => checkout(razorpay, expired.raw), 'EXPIRED'],
        [() => checkout(razorpay, mintClaimToken()), 'NOT_FOUND'],
        [
          () =>
            checkout(razorpay, paid.raw, {
              addOns: ['ai_enrichment'],
              pricing: { ...PRICING, aiEnrichmentPaise: null },
            }),
          'ADD_ON_UNAVAILABLE',
        ],
        [
          () =>
            createClaimCheckout({
              db: db(),
              client: null,
              pricing: PRICING,
              user: RECIPIENT,
              rawToken: paid.raw,
              addOns: [],
            }),
          'PAYMENTS_NOT_CONFIGURED',
        ],
      ];
      for (const [attempt, code] of cases) {
        await expect(attempt()).rejects.toMatchObject({ code });
      }
      expect(razorpay.orders).toHaveLength(0);
      expect((await db().collection(COLLECTIONS.claimOrders).get()).size).toBe(0);
    });

    it('a paid credential cannot be claimed through the free path', async () => {
      const { raw } = await claimToken();
      await expect(claimCredential({ db: db(), user: RECIPIENT, rawToken: raw })).rejects.toThrow(
        expect.objectContaining({ code: 'PAYMENT_REQUIRED' }),
      );
    });

    it('a free credential still claims instantly, once', async () => {
      const { raw, id } = await claimToken({ feePaise: 0 });
      expect(await claimCredential({ db: db(), user: RECIPIENT, rawToken: raw })).toEqual({
        vaultItemId: id,
        alreadyClaimed: false,
      });
      expect(await claimCredential({ db: db(), user: RECIPIENT, rawToken: raw })).toEqual({
        vaultItemId: id,
        alreadyClaimed: true,
      });
      expect(await claimedCount()).toBe(1);
    });
  });

  describe('settlement on capture', () => {
    it('mints the vault item, consumes the token and marks the order paid — once', async () => {
      const razorpay = fakeRazorpay();
      const { raw, id } = await claimToken();
      const { orderId } = await checkout(razorpay, raw, { addOns: ['ai_enrichment'] });
      const payment = razorpay.capture(orderId);

      expect(await settle(payment)).toEqual({ result: 'minted', orderId, vaultItemId: id });
      expect(await vaultItem(id)).toMatchObject({
        ownerUid: RECIPIENT.uid,
        issuerId: 'school-a',
        issuerType: 'institution',
        templateId: 'tpl-cert',
        credentialName: 'Class 10 certificate',
        issuerName: 'Sunrise Public School',
        recipientName: 'Asha Verma',
        status: 'valid',
        orderId,
        paymentId: payment.id,
        addOns: ['ai_enrichment'],
      });
      const token = await tokenDoc(id);
      expect(token?.claimedAt).toBeInstanceOf(Timestamp);
      expect(token).toMatchObject({ claimedByUid: RECIPIENT.uid, orderId });
      expect(await orderDoc(orderId)).toMatchObject({
        status: 'paid',
        paymentId: payment.id,
        settledBy: 'webhook',
      });
      expect(await claimedCount()).toBe(1);

      // Razorpay delivers at least once: a replay changes nothing.
      expect(await settle(payment)).toEqual({ result: 'already_settled', orderId });
      expect(await settle(payment, 'reconcile')).toEqual({ result: 'already_settled', orderId });
      expect(await claimedCount()).toBe(1);
      expect(razorpay.refunds).toHaveLength(0);
    });

    it('mints exactly once when deliveries race', async () => {
      const razorpay = fakeRazorpay();
      const { raw, id } = await claimToken();
      const { orderId } = await checkout(razorpay, raw);
      const payment = razorpay.capture(orderId);
      const outcomes = await Promise.all(
        Array.from({ length: 6 }, (_, i) => settle(payment, i % 2 ? 'webhook' : 'reconcile')),
      );
      expect(outcomes.filter((o) => o.result === 'minted')).toHaveLength(1);
      expect(outcomes.filter((o) => o.result === 'already_settled')).toHaveLength(5);
      expect(await claimedCount()).toBe(1);
      expect((await vaultItem(id))?.paymentId).toBe(payment.id);
    });

    it('ignores payments that are not captured, and orders that are not ours', async () => {
      const razorpay = fakeRazorpay();
      const { raw, id } = await claimToken();
      const { orderId } = await checkout(razorpay, raw);
      const payment = razorpay.capture(orderId);
      expect(await settle({ ...payment, status: 'authorized' })).toEqual({ result: 'ignored' });
      expect(await settle({ ...payment, order_id: null })).toEqual({ result: 'ignored' });
      expect(await settle({ ...payment, order_id: 'order_SomeoneElse01' })).toEqual({
        result: 'unknown_order',
        orderId: 'order_SomeoneElse01',
      });
      expect(await vaultItem(id)).toBeUndefined();
      expect((await orderDoc(orderId)).status).toBe('created');
    });

    it('refunds (with transfer reversal) a payment that does not match its order', async () => {
      const razorpay = fakeRazorpay();
      const { raw, id } = await claimToken();
      const { orderId } = await checkout(razorpay, raw);
      const payment = razorpay.capture(orderId, 500);
      expect(await settle(payment)).toEqual({
        result: 'refund_due',
        orderId,
        reason: 'amount_mismatch',
      });
      expect(await vaultItem(id)).toBeUndefined();
      expect((await tokenDoc(id))?.claimedAt).toBeNull();
      await refundOutstanding({ db: db(), client: razorpay.client, orderId });
      expect(razorpay.refunds).toEqual([
        {
          paymentId: payment.id,
          request: { amount: 500, reverse_all: true, notes: { reason: 'amount_mismatch' } },
        },
      ]);
    });

    it('refunds the second of two paid checkouts for the same credential', async () => {
      const razorpay = fakeRazorpay();
      const { raw, id } = await claimToken();
      const first = await checkout(razorpay, raw);
      const second = await checkout(razorpay, raw); // e.g. a second tab, before the first paid
      const p1 = razorpay.capture(first.orderId);
      const p2 = razorpay.capture(second.orderId);

      expect((await settle(p1)).result).toBe('minted');
      expect(await settle(p2)).toEqual({
        result: 'refund_due',
        orderId: second.orderId,
        reason: 'already_claimed',
      });
      expect(await orderDoc(second.orderId)).toMatchObject({
        status: 'refund_due',
        refundPending: true,
        refund: { reason: 'already_claimed', paymentId: p2.id, refundId: null },
      });

      expect(
        await refundOutstanding({ db: db(), client: razorpay.client, orderId: second.orderId }),
      ).toBe(0);
      expect(razorpay.refunds).toEqual([
        {
          paymentId: p2.id,
          request: { amount: 10_000, reverse_all: true, notes: { reason: 'already_claimed' } },
        },
      ]);
      expect(await orderDoc(second.orderId)).toMatchObject({
        status: 'refunded',
        refundPending: false,
        refund: { refundId: 'rfnd_Test0000000001', lastError: null },
      });
      // Refunding again does nothing.
      expect(
        await refundOutstanding({ db: db(), client: razorpay.client, orderId: second.orderId }),
      ).toBe(0);
      expect(razorpay.refunds).toHaveLength(1);
      expect(await claimedCount()).toBe(1);
      expect((await vaultItem(id))?.orderId).toBe(first.orderId);
    });

    it('refunds when the claim link was purged before the payment arrived', async () => {
      const razorpay = fakeRazorpay();
      const { raw, id } = await claimToken();
      const { orderId } = await checkout(razorpay, raw);
      await db().collection(COLLECTIONS.claimTokens).doc(id).delete();
      expect(await settle(razorpay.capture(orderId))).toMatchObject({
        result: 'refund_due',
        reason: 'token_gone',
      });
      expect(await vaultItem(id)).toBeUndefined();
    });

    it('honours a payment that completes after the link expired (checkout was in time)', async () => {
      const razorpay = fakeRazorpay();
      const { raw, id } = await claimToken({ expiresInMs: 60_000 });
      const { orderId } = await checkout(razorpay, raw);
      await db()
        .collection(COLLECTIONS.claimTokens)
        .doc(id)
        .update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
      expect((await settle(razorpay.capture(orderId))).result).toBe('minted');
    });

    it('refunds a stray second capture on an order already settled', async () => {
      const razorpay = fakeRazorpay();
      const { raw } = await claimToken();
      const { orderId } = await checkout(razorpay, raw);
      expect((await settle(razorpay.capture(orderId))).result).toBe('minted');
      const stray = razorpay.capture(orderId);
      expect(await settle(stray)).toEqual({ result: 'stray_payment', orderId });
      expect(await settle(stray)).toEqual({ result: 'already_settled', orderId });
      expect(await refundOutstanding({ db: db(), client: razorpay.client, orderId })).toBe(0);
      expect(razorpay.refunds.map((r) => r.paymentId)).toEqual([stray.id]);
      const order = await orderDoc(orderId);
      expect(order.status).toBe('paid');
      expect(order.refundPending).toBe(false);
      expect(order.strayPayments?.[stray.id]).toMatchObject({ refunded: true, lastError: null });
      expect(await claimedCount()).toBe(1);
    });

    it('keeps a failed refund outstanding, and treats one Razorpay already made as done', async () => {
      const razorpay = fakeRazorpay();
      const { raw } = await claimToken();
      const first = await checkout(razorpay, raw);
      const second = await checkout(razorpay, raw);
      await settle(razorpay.capture(first.orderId));
      const p2 = razorpay.capture(second.orderId);
      await settle(p2);

      razorpay.failNextRefunds(1);
      expect(
        await refundOutstanding({ db: db(), client: razorpay.client, orderId: second.orderId }),
      ).toBe(1);
      expect(await orderDoc(second.orderId)).toMatchObject({
        status: 'refund_due',
        refundPending: true,
        refund: { lastError: expect.stringContaining('unreachable') },
      });

      // Meanwhile the refund went through on Razorpay's side (our call had timed out): the next
      // attempt is refused as over-refunding, and the payment's record shows it is done.
      await razorpay.client.payments.refund(p2.id, { amount: 10_000, reverse_all: true });
      expect(
        await refundOutstanding({ db: db(), client: razorpay.client, orderId: second.orderId }),
      ).toBe(0);
      expect(await orderDoc(second.orderId)).toMatchObject({
        status: 'refunded',
        refundPending: false,
        refund: { refundId: null, lastError: null },
      });
    });
  });

  describe('status and reconciliation', () => {
    it('shows a checkout only to its payer', async () => {
      const razorpay = fakeRazorpay();
      const { raw } = await claimToken();
      const { orderId } = await checkout(razorpay, raw);
      await expect(
        getCheckoutStatus({ db: db(), client: razorpay.client, user: STRANGER, orderId }),
      ).rejects.toBeInstanceOf(ClaimError);
      await expect(
        getCheckoutStatus({
          db: db(),
          client: razorpay.client,
          user: RECIPIENT,
          orderId: 'order_Unknown000001',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('settles a capture whose webhook never came, at most once per interval', async () => {
      const razorpay = fakeRazorpay();
      const { raw, id } = await claimToken();
      const { orderId } = await checkout(razorpay, raw);
      const status = (now: number) =>
        getCheckoutStatus({ db: db(), client: razorpay.client, user: RECIPIENT, orderId, now });

      // Within the first seconds the webhook is given its chance: no call to Razorpay.
      expect(await status(Date.now())).toMatchObject({ status: 'created', vaultItemId: null });
      expect(razorpay.client.orders.fetchPayments).not.toHaveBeenCalled();

      const later = Date.now() + 6_000;
      expect(await status(later)).toMatchObject({ status: 'created' });
      expect(razorpay.client.orders.fetchPayments).toHaveBeenCalledTimes(1);
      razorpay.capture(orderId);
      expect(await status(later + 1_000)).toMatchObject({ status: 'created' }); // throttled
      expect(razorpay.client.orders.fetchPayments).toHaveBeenCalledTimes(1);

      expect(await status(later + 6_000)).toEqual({
        orderId,
        status: 'paid',
        vaultItemId: id,
        refundReason: null,
      });
      expect(await orderDoc(orderId)).toMatchObject({ settledBy: 'reconcile' });
      expect((await vaultItem(id))?.ownerUid).toBe(RECIPIENT.uid);
    });

    it('the sweep settles lost webhooks and retries refunds, leaving fresh orders alone', async () => {
      const razorpay = fakeRazorpay();
      const a = await claimToken();
      const b = await claimToken();
      const c = await claimToken();
      const orderA = (await checkout(razorpay, a.raw)).orderId;
      const orderC = (await checkout(razorpay, c.raw)).orderId; // opened, never paid
      const orderB1 = (await checkout(razorpay, b.raw)).orderId;
      const orderB2 = (await checkout(razorpay, b.raw)).orderId;
      razorpay.capture(orderA); // webhook lost
      await settle(razorpay.capture(orderB1));
      await settle(razorpay.capture(orderB2)); // refund due…
      razorpay.failNextRefunds(1);
      await refundOutstanding({ db: db(), client: razorpay.client, orderId: orderB2 }); // …and failed

      // Orders younger than two minutes are left to the webhook.
      expect(
        await reconcileOpenCheckouts({
          db: db(),
          client: razorpay.client,
          now: Date.now() + 30_000,
        }),
      ).toEqual({ checked: 1, settled: 0, refundsOutstanding: 0, errors: 0 });
      expect((await orderDoc(orderA)).status).toBe('created');
      expect((await orderDoc(orderB2)).status).toBe('refunded');

      expect(
        await reconcileOpenCheckouts({
          db: db(),
          client: razorpay.client,
          now: Date.now() + 10 * 60_000,
        }),
      ).toEqual({ checked: 2, settled: 1, refundsOutstanding: 0, errors: 0 });
      expect(await orderDoc(orderA)).toMatchObject({ status: 'paid', settledBy: 'reconcile' });
      expect((await vaultItem(a.id))?.ownerUid).toBe(RECIPIENT.uid);
      expect((await orderDoc(orderC)).status).toBe('created');
      expect(await claimedCount()).toBe(2);

      // Open orders older than three days are no longer swept.
      expect(
        await reconcileOpenCheckouts({
          db: db(),
          client: razorpay.client,
          now: Date.now() + 4 * DAY,
        }),
      ).toEqual({ checked: 0, settled: 0, refundsOutstanding: 0, errors: 0 });
    });
  });
});
