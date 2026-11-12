/**
 * POST /api/claim/order — opens a Razorpay order for a paid credential. Body { token }.
 * Same-origin, session cookie. Logic and responses: `src/lib/claim/handler.ts` (ADR-027).
 */
import { connection } from 'next/server';

import { handleClaimOrder } from '@/lib/claim/handler';

export async function POST(request: Request): Promise<Response> {
  await connection();
  return handleClaimOrder(request);
}
