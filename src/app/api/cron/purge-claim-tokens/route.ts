/**
 * POST /api/cron/purge-claim-tokens — deletes claim tokens 30 days past their expiry (with the
 * recipient names and contacts they hold) and marks fully purged batches. Meant for Cloud
 * Scheduler, daily:
 *
 *     Authorization: Bearer $CRON_SECRET
 *
 * 503 until `CRON_SECRET` is set; 401 for a wrong secret. Success: 200 `{ deleted, batchesPurged }`.
 */
import { timingSafeEqual } from 'node:crypto';

import { connection } from 'next/server';

import { adminFirestore } from '@/lib/server/firebase-admin';
import { purgeExpiredClaimTokens } from '@/lib/utils/tokenManager';

function secretMatches(header: string | null, secret: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function POST(request: Request): Promise<Response> {
  await connection();
  const headers = { 'Cache-Control': 'no-store' };
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 32) {
    return Response.json(
      { error: { code: 'NOT_CONFIGURED', message: 'CRON_SECRET (32+ characters) is not set.' } },
      { status: 503, headers },
    );
  }
  if (!secretMatches(request.headers.get('authorization'), secret)) {
    return Response.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Wrong or missing secret.' } },
      { status: 401, headers },
    );
  }
  const result = await purgeExpiredClaimTokens(adminFirestore());
  console.info(JSON.stringify({ severity: 'INFO', message: 'claim token purge', ...result }));
  return Response.json(result, { headers });
}
