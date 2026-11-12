import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  createRazorpayClient,
  getRazorpayClient,
  isRazorpayId,
  RazorpayApiError,
  razorpayConfigFromEnv,
  readPaymentEntity,
  verifyWebhookSignature,
} from './razorpayClient';

const CONFIG = {
  keyId: 'rzp_test_key',
  keySecret: 'key-secret',
  apiBaseUrl: 'https://rzp.test/v1',
};

/** A fetch that records each call and answers with `reply(url, init)`. */
function recordingFetch(reply: (url: string, init: RequestInit) => [number, unknown]) {
  const calls: { url: string; init: RequestInit; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init!, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const [status, body] = reply(url, init!);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const payment = (overrides: Record<string, unknown> = {}) => ({
  id: 'pay_JJCqynf4fQS0N1',
  entity: 'payment',
  order_id: 'order_JJCYnu3hipocHz',
  amount: 2000,
  currency: 'INR',
  status: 'captured',
  amount_refunded: 0,
  ...overrides,
});

describe('razorpayConfigFromEnv', () => {
  it('is null until both API keys are set', () => {
    expect(razorpayConfigFromEnv({})).toBeNull();
    expect(razorpayConfigFromEnv({ RAZORPAY_KEY_ID: 'rzp_test_x' })).toBeNull();
    expect(razorpayConfigFromEnv({ RAZORPAY_KEY_ID: ' ', RAZORPAY_KEY_SECRET: 's' })).toBeNull();
  });

  it('reads keys, the webhook secret and an optional API root', () => {
    expect(
      razorpayConfigFromEnv({
        RAZORPAY_KEY_ID: ' rzp_test_x ',
        RAZORPAY_KEY_SECRET: 'secret',
        RAZORPAY_WEBHOOK_SECRET: 'whsec',
        RAZORPAY_API_BASE_URL: 'http://127.0.0.1:9/v1//',
      }),
    ).toEqual({
      keyId: 'rzp_test_x',
      keySecret: 'secret',
      webhookSecret: 'whsec',
      apiBaseUrl: 'http://127.0.0.1:9/v1',
    });
    expect(razorpayConfigFromEnv({ RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's' })).toMatchObject(
      { webhookSecret: null, apiBaseUrl: 'https://api.razorpay.com/v1' },
    );
  });
});

describe('isRazorpayId', () => {
  it('accepts ids of the right kind only', () => {
    expect(isRazorpayId('order', 'order_JJCYnu3hipocHz')).toBe(true);
    expect(isRazorpayId('account', 'acc_IRQWUleX4BqvYn')).toBe(true);
    expect(isRazorpayId('payment', 'order_JJCYnu3hipocHz')).toBe(false);
    expect(isRazorpayId('account', 'acc_')).toBe(false);
    expect(isRazorpayId('account', 'acc_IRQWUleX4BqvYn/../x')).toBe(false);
    expect(isRazorpayId('order', undefined)).toBe(false);
    expect(isRazorpayId('order', 42)).toBe(false);
  });
});

describe('createRazorpayClient', () => {
  it('creates an order with Route transfers, authenticated with the key pair', async () => {
    const { fetchImpl, calls } = recordingFetch(() => [
      200,
      { id: 'order_JJCYnu3hipocHz', amount: 2000, currency: 'INR', status: 'created' },
    ]);
    const client = createRazorpayClient(CONFIG, { fetchImpl });
    const transfers = [
      {
        account: 'acc_IRQWUleX4BqvYn',
        amount: 1800,
        currency: 'INR' as const,
        on_hold: true,
        on_hold_until: 1_900_000_000,
      },
    ];
    const order = await client.orders.create({
      amount: 2000,
      currency: 'INR',
      receipt: 'claim_abc',
      transfers,
    });
    expect(order).toEqual({
      id: 'order_JJCYnu3hipocHz',
      amount: 2000,
      currency: 'INR',
      status: 'created',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://rzp.test/v1/orders');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('rzp_test_key:key-secret').toString('base64')}`,
    );
    expect(calls[0]!.body).toEqual({
      amount: 2000,
      currency: 'INR',
      receipt: 'claim_abc',
      transfers,
    });
    expect(client.keyId).toBe('rzp_test_key');
  });

  it('refuses an order reply with the wrong amount or no id', async () => {
    for (const reply of [
      { id: 'order_JJCYnu3hipocHz', amount: 1 },
      { amount: 2000 },
      { id: 'not-an-order', amount: 2000 },
    ]) {
      const { fetchImpl } = recordingFetch(() => [200, reply]);
      await expect(
        createRazorpayClient(CONFIG, { fetchImpl }).orders.create({
          amount: 2000,
          currency: 'INR',
        }),
      ).rejects.toBeInstanceOf(RazorpayApiError);
    }
  });

  it('turns API errors and network failures into RazorpayApiError', async () => {
    const { fetchImpl } = recordingFetch(() => [
      400,
      { error: { code: 'BAD_REQUEST_ERROR', description: 'The amount must be at least INR 1.00' } },
    ]);
    const failure = await createRazorpayClient(CONFIG, { fetchImpl })
      .orders.create({ amount: 1, currency: 'INR' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RazorpayApiError);
    expect(failure).toMatchObject({ status: 400, code: 'BAD_REQUEST_ERROR' });
    expect(String((failure as Error).message)).toContain('at least INR 1.00');

    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(
      createRazorpayClient(CONFIG, { fetchImpl: offline }).payments.fetch('pay_JJCqynf4fQS0N1'),
    ).rejects.toMatchObject({ status: 0 });
  });

  it("lists an order's payments and reads only well-formed ones", async () => {
    const { fetchImpl, calls } = recordingFetch(() => [
      200,
      { entity: 'collection', count: 1, items: [payment()] },
    ]);
    const client = createRazorpayClient(CONFIG, { fetchImpl });
    expect(await client.orders.fetchPayments('order_JJCYnu3hipocHz')).toEqual([
      {
        id: 'pay_JJCqynf4fQS0N1',
        order_id: 'order_JJCYnu3hipocHz',
        amount: 2000,
        currency: 'INR',
        status: 'captured',
        amount_refunded: 0,
      },
    ]);
    expect(calls[0]!.url).toBe('https://rzp.test/v1/orders/order_JJCYnu3hipocHz/payments');
    expect(calls[0]!.init.method).toBe('GET');

    const bad = recordingFetch(() => [200, { items: [payment({ amount: '2000' })] }]);
    await expect(
      createRazorpayClient(CONFIG, { fetchImpl: bad.fetchImpl }).orders.fetchPayments(
        'order_JJCYnu3hipocHz',
      ),
    ).rejects.toBeInstanceOf(RazorpayApiError);
  });

  it('refunds with reverse_all so the Linked Account transfer is taken back', async () => {
    const { fetchImpl, calls } = recordingFetch(() => [
      200,
      {
        id: 'rfnd_JJFNlNXPHY640A',
        amount: 2000,
        payment_id: 'pay_JJCqynf4fQS0N1',
        status: 'processed',
      },
    ]);
    const refund = await createRazorpayClient(CONFIG, { fetchImpl }).payments.refund(
      'pay_JJCqynf4fQS0N1',
      { amount: 2000, reverse_all: true, notes: { reason: 'already_claimed' } },
    );
    expect(refund).toEqual({
      id: 'rfnd_JJFNlNXPHY640A',
      payment_id: 'pay_JJCqynf4fQS0N1',
      amount: 2000,
      status: 'processed',
    });
    expect(calls[0]!.url).toBe('https://rzp.test/v1/payments/pay_JJCqynf4fQS0N1/refund');
    expect(calls[0]!.body).toEqual({
      amount: 2000,
      reverse_all: true,
      notes: { reason: 'already_claimed' },
    });
  });

  it('never puts a malformed id into a URL', async () => {
    const { fetchImpl } = recordingFetch(() => [200, {}]);
    const client = createRazorpayClient(CONFIG, { fetchImpl });
    await expect(client.payments.fetch('pay_x/../../orders')).rejects.toBeInstanceOf(TypeError);
    await expect(client.orders.fetchPayments('../admin')).rejects.toBeInstanceOf(TypeError);
    await expect(
      client.payments.refund('order_JJCYnu3hipocHz', { amount: 1 }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('getRazorpayClient', () => {
  it('is null without keys, initialised once, and re-created when the keys change', () => {
    expect(getRazorpayClient({})).toBeNull();
    const env = { RAZORPAY_KEY_ID: 'rzp_test_a', RAZORPAY_KEY_SECRET: 's1' };
    const first = getRazorpayClient(env);
    expect(first?.keyId).toBe('rzp_test_a');
    expect(getRazorpayClient({ ...env })).toBe(first);
    expect(getRazorpayClient({ ...env, RAZORPAY_KEY_SECRET: 's2' })).not.toBe(first);
  });
});

describe('readPaymentEntity', () => {
  it('keeps only the fields the engine uses', () => {
    expect(readPaymentEntity(payment({ email: 'x@example.in', contact: '+91…' }))).toEqual({
      id: 'pay_JJCqynf4fQS0N1',
      order_id: 'order_JJCYnu3hipocHz',
      amount: 2000,
      currency: 'INR',
      status: 'captured',
      amount_refunded: 0,
    });
    expect(readPaymentEntity(payment({ order_id: null }))?.order_id).toBeNull();
  });

  it('rejects anything malformed', () => {
    for (const bad of [
      null,
      'pay_JJCqynf4fQS0N1',
      payment({ id: 'order_JJCYnu3hipocHz' }),
      payment({ order_id: 'nope' }),
      payment({ amount: 0 }),
      payment({ amount: 20.5 }),
      payment({ currency: undefined }),
      payment({ amount_refunded: -1 }),
    ]) {
      expect(readPaymentEntity(bad)).toBeNull();
    }
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'whsec_test_0123456789';
  const body = JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: payment() } },
  });
  const sign = (data: string | Uint8Array, key = secret) =>
    createHmac('sha256', key).update(data).digest('hex');

  it('matches an independent HMAC-SHA256 (RFC 4231, test case 2)', () => {
    expect(
      verifyWebhookSignature(
        'what do ya want for nothing?',
        '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
        'Jefe',
      ),
    ).toBe(true);
  });

  it('accepts the exact raw body, as a string or as bytes', () => {
    expect(verifyWebhookSignature(body, sign(body), secret)).toBe(true);
    expect(verifyWebhookSignature(new TextEncoder().encode(body), sign(body), secret)).toBe(true);
    expect(verifyWebhookSignature(body, sign(body).toUpperCase(), secret)).toBe(true);
  });

  it('rejects a body changed by even one byte, or re-serialised', () => {
    const signature = sign(body);
    expect(verifyWebhookSignature(body.replace('2000', '2001'), signature, secret)).toBe(false);
    expect(verifyWebhookSignature(`${body} `, signature, secret)).toBe(false);
    expect(
      verifyWebhookSignature(JSON.stringify(JSON.parse(body), null, 1), signature, secret),
    ).toBe(false);
  });

  it('rejects the wrong secret and missing, short, long or non-hex signatures', () => {
    expect(verifyWebhookSignature(body, sign(body, 'other-secret'), secret)).toBe(false);
    expect(verifyWebhookSignature(body, sign(body), '')).toBe(false);
    for (const bad of [
      null,
      undefined,
      '',
      sign(body).slice(0, 63),
      `${sign(body)}00`,
      'z'.repeat(64),
    ]) {
      expect(verifyWebhookSignature(body, bad, secret)).toBe(false);
    }
  });
});
