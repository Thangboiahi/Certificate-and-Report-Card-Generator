/**
 * Authorisation of Cloud Scheduler calls to `/api/cron/*`: `Authorization: Bearer $CRON_SECRET`,
 * compared in constant time. 503 until `CRON_SECRET` (32+ characters) is set; 401 otherwise.
 */
import 'server-only';

import { timingSafeEqual } from 'node:crypto';

function secretMatches(header: string | null, secret: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** `null` when the request carries the cron secret; otherwise the response to send. */
export function refuseUnlessCron(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): Response | null {
  const headers = { 'Cache-Control': 'no-store' };
  const secret = env.CRON_SECRET?.trim();
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
  return null;
}
