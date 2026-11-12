/**
 * POST /api/dispatch/reissue — "1-Click Re-Issue" of a past batch from the audit ledger.
 *
 * Sends every unclaimed recipient of the batch a fresh claim link through the batch's original
 * channel. Old links stop working; the new ones are valid for the batch's original duration.
 * Charges NO credits; limited to 3 re-issues per batch, 10 minutes apart (ADR-026).
 *
 * Request (same-origin, session cookie of a member of the batch's institution, or the issuer of a
 * personal batch): `{ "batchId": "<64 hex>" }`
 * Success: 200 `{ batch, recipients, sent, failed, creditsCharged: 0 }`
 * Errors:  `{ error: { code, message, details? } }` — 400, 401, 403, 404, 409 (blocked: purged,
 *          limit, cooldown, busy; or nothing to re-issue), 415, 503.
 */
import { connection } from 'next/server';

import { handleReissueRequest } from '@/lib/dispatch/handler';

export async function POST(request: Request): Promise<Response> {
  await connection();
  return handleReissueRequest(request);
}
