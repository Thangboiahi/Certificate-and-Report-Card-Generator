/**
 * Pay-to-claim checkout (Phase 8, ADR-028). Session cookie; POST is same-origin JSON.
 *
 *   POST /api/checkout { token, addOns? }  → opens a Razorpay order for the cart (Base Fee + AI
 *        add-on). The issuer's share goes to their Route Linked Account as an on-hold transfer;
 *        the platform fee and add-ons stay in the main account.
 *   GET  /api/checkout?orderId=order_…    → the order's state (created / paid / refund_due /
 *        refunded) for its own payer, reconciling with Razorpay if the webhook is late.
 *
 * Logic and responses: `src/lib/payments/handler.ts`, `src/lib/payments/escrow.ts`.
 */
import { connection } from 'next/server';

import { handleCheckout, handleCheckoutStatus } from '@/lib/payments/handler';

export async function POST(request: Request): Promise<Response> {
  await connection();
  return handleCheckout(request);
}

export async function GET(request: Request): Promise<Response> {
  await connection();
  return handleCheckoutStatus(request);
}
