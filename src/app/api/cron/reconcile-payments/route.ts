/**
 * POST /api/cron/reconcile-payments — settles pay-to-claim orders whose webhook never arrived and
 * retries refunds still outstanding (ADR-028). Meant for Cloud Scheduler, every 15 minutes:
 *
 *     Authorization: Bearer $CRON_SECRET
 *
 * 503 until `CRON_SECRET` and the Razorpay keys are set; 401 for a wrong secret.
 * Success: 200 `{ checked, settled, refundsOutstanding, errors }`.
 */
import { connection } from 'next/server';

import { handleReconcileSweep } from '@/lib/payments/handler';
import { refuseUnlessCron } from '@/lib/server/cron-auth';

export async function POST(request: Request): Promise<Response> {
  await connection();
  return refuseUnlessCron(request) ?? handleReconcileSweep();
}
