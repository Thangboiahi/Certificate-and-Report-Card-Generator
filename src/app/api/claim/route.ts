/**
 * POST /api/claim — claims a FREE credential into the signed-in recipient's vault. Body { token }.
 * Paid credentials go through `/api/checkout` (ADR-028).
 * Same-origin, session cookie. Logic and responses: `src/lib/claim/handler.ts` (ADR-027).
 */
import { connection } from 'next/server';

import { handleClaim } from '@/lib/claim/handler';

export async function POST(request: Request): Promise<Response> {
  await connection();
  return handleClaim(request);
}
