/**
 * POST /api/cron/purge-claim-tokens — deletes claim tokens 30 days past their expiry (with the
 * recipient names and contacts they hold) and marks fully purged batches. Meant for Cloud
 * Scheduler, daily:
 *
 *     Authorization: Bearer $CRON_SECRET
 *
 * 503 until `CRON_SECRET` is set; 401 for a wrong secret. Success: 200 `{ deleted, batchesPurged }`.
 */
import { connection } from 'next/server';

import { refuseUnlessCron } from '@/lib/server/cron-auth';
import { adminFirestore } from '@/lib/server/firebase-admin';
import { purgeExpiredClaimTokens } from '@/lib/utils/tokenManager';

export async function POST(request: Request): Promise<Response> {
  await connection();
  const refused = refuseUnlessCron(request);
  if (refused) return refused;
  const result = await purgeExpiredClaimTokens(adminFirestore());
  console.info(JSON.stringify({ severity: 'INFO', message: 'claim token purge', ...result }));
  return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
