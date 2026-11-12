/**
 * POST /api/dispatch/whatsapp — sends claim links as WhatsApp Utility template messages (Meta
 * WhatsApp Cloud API) to up to 500 recipients, charging the caller's institution one credit per
 * recipient BEFORE sending and refunding failures afterwards.
 *
 * Request (same-origin, session cookie of an institution admin or staff member):
 *   { "idempotencyKey": "…", "targets": [{ "recipientName", "phone", "claimToken", "expiresAt" }] }
 * Success: 200 `{ dispatchId, replayed, sent, failed, creditsCharged, creditsRefunded,
 *                 creditBalance, results: [{ index, status, providerId?, error? }] }`
 * Errors:  `{ error: { code, message } }` — 400, 401, 402 (credits), 403, 409, 415, 503.
 *
 * Logic: `src/lib/dispatch/` (ADR-024).
 */
import { connection } from 'next/server';

import { handleDispatchRequest } from '@/lib/dispatch/handler';

export async function POST(request: Request): Promise<Response> {
  await connection();
  return handleDispatchRequest(request, 'whatsapp');
}
