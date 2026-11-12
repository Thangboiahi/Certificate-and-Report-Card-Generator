/**
 * POST /api/ai/enrich — asks Gemini to fill one new column for a batch of rows (up to 40).
 * Same-origin, session cookie of a signed-in person. Logic and responses: `src/lib/ai/handler.ts`.
 */
import { connection } from 'next/server';

import { handleEnrich } from '@/lib/ai/handler';

export async function POST(request: Request): Promise<Response> {
  await connection();
  return handleEnrich(request);
}
