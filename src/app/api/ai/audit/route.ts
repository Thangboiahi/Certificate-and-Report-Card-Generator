/**
 * POST /api/ai/audit — turns a plain-language command into a validated JSON patch.
 * Same-origin, session cookie of a signed-in person. Logic and responses: `src/lib/ai/handler.ts`.
 */
import { connection } from 'next/server';

import { handleAudit } from '@/lib/ai/handler';

export async function POST(request: Request): Promise<Response> {
  await connection();
  return handleAudit(request);
}
