/**
 * POST /api/vault/share — turns the public verification link of a vault item on or off. Body { itemId, enabled }.
 * Same-origin, session cookie. Logic and responses: `src/lib/claim/handler.ts` (ADR-027).
 */
import { connection } from 'next/server';

import { handleShare } from '@/lib/claim/handler';

export async function POST(request: Request): Promise<Response> {
  await connection();
  return handleShare(request);
}
