/**
 * The Razorpay webhook's gatekeeping, without a database: nothing may be read or written before
 * the signature over the exact raw body has been verified. Settlement itself is tested against
 * the Firestore emulator (`escrow.emulator.test.ts`).
 */
import { createHmac } from 'node:crypto';

import type { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it, vi } from 'vitest';

import { handleRazorpayWebhook, MAX_WEBHOOK_BYTES, type WebhookDependencies } from './handler';

const SECRET = 'whsec_unit_test_0123456789abcdef';
const sign = (body: string | Uint8Array, secret = SECRET) =>
  createHmac('sha256', secret).update(body).digest('hex');

const entity = (overrides: Record<string, unknown> = {}) => ({
  id: 'pay_JJCqynf4fQS0N1',
  entity: 'payment',
  order_id: 'order_JJCYnu3hipocHz',
  amount: 2000,
  currency: 'INR',
  status: 'captured',
  amount_refunded: 0,
  ...overrides,
});

const captured = (paymentEntity: unknown = entity()) =>
  JSON.stringify({
    entity: 'event',
    account_id: 'acc_BFQ7uQEaa7j2z7',
    event: 'payment.captured',
    contains: ['payment'],
    payload: { payment: { entity: paymentEntity } },
    created_at: 1_700_000_000,
  });

function webhook(body: string | Uint8Array, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/webhooks/razorpay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-razorpay-event-id': 'evt_1', ...headers },
    body: body as BodyInit,
  });
}

/** Dependencies whose database explodes if touched. */
function untouchable(secret: string | null = SECRET) {
  const db = vi.fn(() => {
    throw new Error('the database must not be touched');
  });
  const deps: WebhookDependencies = {
    webhookSecret: secret,
    db: db as unknown as () => Firestore,
    client: () => null,
  };
  return { deps, db };
}

async function errorCode(response: Response) {
  return ((await response.json()) as { error?: { code: string } }).error?.code;
}

describe('POST /api/webhooks/razorpay — before the database', () => {
  it('answers 503 when no webhook secret is configured', async () => {
    const { deps, db } = untouchable(null);
    const body = captured();
    const response = await handleRazorpayWebhook(
      webhook(body, { 'x-razorpay-signature': sign(body) }),
      deps,
    );
    expect(response.status).toBe(503);
    expect(db).not.toHaveBeenCalled();
  });

  it('rejects a missing, wrong, or wrong-secret signature with 401', async () => {
    const body = captured();
    for (const signature of [undefined, '', 'f'.repeat(64), sign(body, 'another-secret')]) {
      const { deps, db } = untouchable();
      const response = await handleRazorpayWebhook(
        webhook(body, signature === undefined ? {} : { 'x-razorpay-signature': signature }),
        deps,
      );
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe('INVALID_SIGNATURE');
      expect(db).not.toHaveBeenCalled();
    }
  });

  it('rejects a captured event whose amount was altered after signing', async () => {
    const { deps, db } = untouchable();
    const original = captured();
    const forged = captured(entity({ amount: 1 }));
    const response = await handleRazorpayWebhook(
      webhook(forged, { 'x-razorpay-signature': sign(original) }),
      deps,
    );
    expect(response.status).toBe(401);
    expect(db).not.toHaveBeenCalled();
  });

  it('verifies the raw bytes, not a re-encoding of them', async () => {
    const { deps, db } = untouchable();
    // Invalid UTF-8: a text decode-and-re-encode would change these bytes.
    const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    const response = await handleRazorpayWebhook(
      webhook(bytes, { 'x-razorpay-signature': sign(new TextEncoder().encode('{��}')) }),
      deps,
    );
    expect(response.status).toBe(401);
    // Correctly signed, but not UTF-8 JSON: 400, still without touching the database.
    const signed = await handleRazorpayWebhook(
      webhook(bytes, { 'x-razorpay-signature': sign(bytes) }),
      deps,
    );
    expect(signed.status).toBe(400);
    expect(db).not.toHaveBeenCalled();
  });

  it('refuses oversized and empty payloads', async () => {
    const { deps, db } = untouchable();
    const big = 'x'.repeat(MAX_WEBHOOK_BYTES + 1);
    expect(
      (await handleRazorpayWebhook(webhook(big, { 'x-razorpay-signature': sign(big) }), deps))
        .status,
    ).toBe(413);
    expect(
      (await handleRazorpayWebhook(webhook('', { 'x-razorpay-signature': sign('') }), deps)).status,
    ).toBe(400);
    expect(db).not.toHaveBeenCalled();
  });

  it('acknowledges, without acting on, events other than payment.captured', async () => {
    const { deps, db } = untouchable();
    for (const event of [
      'payment.authorized',
      'payment.failed',
      'order.paid',
      'refund.processed',
    ]) {
      const body = JSON.stringify({ event, payload: { payment: { entity: entity() } } });
      const response = await handleRazorpayWebhook(
        webhook(body, { 'x-razorpay-signature': sign(body) }),
        deps,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true, ignored: event });
    }
    expect(db).not.toHaveBeenCalled();
  });

  it('acknowledges signed captures it cannot use (so Razorpay does not retry for a day)', async () => {
    const { deps, db } = untouchable();
    for (const [paymentEntity, reason] of [
      [entity({ amount: '2000' }), 'malformed'],
      [entity({ id: 'evil' }), 'malformed'],
      [entity({ order_id: null }), 'no_order'],
    ] as const) {
      const body = captured(paymentEntity);
      const response = await handleRazorpayWebhook(
        webhook(body, { 'x-razorpay-signature': sign(body) }),
        deps,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true, ignored: reason });
    }
    expect(db).not.toHaveBeenCalled();
  });

  it('answers 500 (Razorpay retries) when a verified capture cannot be recorded', async () => {
    const runTransaction = vi.fn(async () => {
      throw new Error('Firestore unavailable');
    });
    const deps: WebhookDependencies = {
      webhookSecret: SECRET,
      db: () =>
        ({ runTransaction, collection: () => ({ doc: () => ({}) }) }) as unknown as Firestore,
      client: () => null,
    };
    const body = captured();
    const response = await handleRazorpayWebhook(
      webhook(body, { 'x-razorpay-signature': sign(body) }),
      deps,
    );
    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe('SETTLEMENT_FAILED');
    expect(runTransaction).toHaveBeenCalledOnce();
  });
});
