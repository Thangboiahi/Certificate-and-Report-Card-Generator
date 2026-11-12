/**
 * Razorpay for claim fees (Standard Checkout): the server creates an order, the browser opens
 * Razorpay Checkout for it, and the server verifies the returned signature before claiming
 * (ADR-027). No SDK: two REST/crypto operations.
 *
 * Signature: HMAC-SHA256(`${order_id}|${payment_id}`, key_secret), hex — Razorpay's documented
 * check for the Checkout success handler.
 */
import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  /** REST root, e.g. `https://api.razorpay.com/v1` (a local mock in tests). */
  apiBaseUrl: string;
}

export function razorpayConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): RazorpayConfig | null {
  const keyId = env.RAZORPAY_KEY_ID?.trim();
  const keySecret = env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) return null;
  return {
    keyId,
    keySecret,
    apiBaseUrl: (env.RAZORPAY_API_BASE_URL?.trim() || 'https://api.razorpay.com/v1').replace(
      /\/+$/,
      '',
    ),
  };
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
}

/** Creates an order for `amount` paise. Throws on any failure. */
export async function createRazorpayOrder(
  config: RazorpayConfig,
  order: { amount: number; receipt: string; notes: Record<string, string> },
  fetchImpl: typeof fetch = fetch,
): Promise<RazorpayOrder> {
  const response = await fetchImpl(`${config.apiBaseUrl}/orders`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ...order, currency: 'INR' }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => null)) as Partial<RazorpayOrder> | null;
  if (!response.ok || typeof body?.id !== 'string' || body.amount !== order.amount) {
    throw new Error(`Razorpay order failed (${response.status})`);
  }
  return { id: body.id, amount: body.amount, currency: body.currency ?? 'INR' };
}

/** Constant-time check of a Checkout success signature. */
export function verifyPaymentSignature(
  keySecret: string,
  orderId: string,
  paymentId: string,
  signature: string,
): boolean {
  const expected = createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
