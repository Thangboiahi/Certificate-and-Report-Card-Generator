/**
 * POST /api/webhooks/razorpay — Razorpay's server-to-server events (Phase 8, ADR-028).
 *
 * Every delivery is authenticated by `X-Razorpay-Signature` (HMAC-SHA256 of the raw body with
 * `RAZORPAY_WEBHOOK_SECRET`, constant-time) before anything is parsed or stored. On
 * `payment.captured` one transaction mints the vault item and consumes the claim token; replays
 * are no-ops. No session cookie or same-origin check: Razorpay is the caller.
 *
 * Logic and responses: `src/lib/payments/handler.ts`.
 */
import { connection } from 'next/server';

import { handleRazorpayWebhook } from '@/lib/payments/handler';

export async function POST(request: Request): Promise<Response> {
  await connection();
  return handleRazorpayWebhook(request);
}
