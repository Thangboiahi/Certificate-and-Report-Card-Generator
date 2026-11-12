/**
 * POST /api/verify/mint — pre-mints verification ids (and their unclaimed stubs) for a batch of
 * documents, so their QR codes can be drawn before anyone claims (ADR-035).
 * Logic and responses: `src/lib/verify/handler.ts`.
 */
import { connection } from 'next/server';

import { handleMint } from '@/lib/verify/handler';

export async function POST(request: Request): Promise<Response> {
  await connection();
  return handleMint(request);
}
