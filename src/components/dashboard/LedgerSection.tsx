import 'server-only';

import { listIssuedBatches } from '@/lib/dispatch/run';
import { adminFirestore } from '@/lib/server/firebase-admin';
import type { IssuedBatchRow } from '@/types/audit';
import type { SessionUser } from '@/types/roles';

import { AuditLedger } from './AuditLedger';

/** Server part of the audit ledger: loads the caller's batches with the Admin SDK. */
export async function LedgerSection({
  user,
  renderedAt,
}: {
  user: SessionUser;
  renderedAt: number;
}) {
  let batches: IssuedBatchRow[] | null = null;
  try {
    batches = await listIssuedBatches(adminFirestore(), user);
  } catch (error) {
    console.error(
      JSON.stringify({ severity: 'ERROR', message: 'ledger unavailable', cause: String(error) }),
    );
  }
  return (
    <section className="mt-6 flex flex-col gap-2" aria-labelledby="ledger-heading">
      <h2 id="ledger-heading" className="text-sm font-medium text-neutral-500">
        Issued batches
      </h2>
      {batches ? (
        <AuditLedger batches={batches} renderedAt={renderedAt} />
      ) : (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          The ledger could not be loaded. Refresh to try again.
        </p>
      )}
    </section>
  );
}
