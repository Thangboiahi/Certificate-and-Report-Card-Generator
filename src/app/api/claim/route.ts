/**
 * POST /api/claim — claims a credential into the signed-in recipient's vault (free, or after a verified Razorpay payment). Body { token, payment? }.
 * Same-origin, session cookie. Logic and responses: `src/lib/claim/handler.ts` (ADR-027).
 */
import { connection } from 'next/server';

import { handleClaim } from '@/lib/claim/handler';

export async function POST(request: Request): Promise<Response> {
  await connection();
  return handleClaim(request);
}
