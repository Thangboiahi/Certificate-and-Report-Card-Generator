import { IndexErrorAlert } from '@/components/dashboard/IndexErrorAlert';
import { LiveKanban } from '@/components/dashboard/LiveKanban';
import { listRequests } from '@/lib/crm/requests';
import { indexErrorOf } from '@/lib/firestore-errors';
import { adminFirestore } from '@/lib/server/firebase-admin';
import type { SessionUser } from '@/types/roles';

/**
 * The "Credential requests" board of a dashboard page: reads the caller's requests from Firestore
 * on the server and hands them to the live board. A failed read shows a plain message instead of
 * breaking the page; a missing index shows the link that builds it.
 */
export async function RequestsSection({
  user,
  renderedAt,
}: {
  user: SessionUser;
  renderedAt: number;
}) {
  let requests;
  try {
    requests = await listRequests(adminFirestore(), user);
  } catch (error) {
    const missingIndex = indexErrorOf(error);
    console.error(
      JSON.stringify({
        severity: 'ERROR',
        message: missingIndex ? 'requests list: missing Firestore index' : 'requests list',
        cause: String(error),
        ...(missingIndex?.link ? { indexLink: missingIndex.link } : {}),
      }),
    );
    if (missingIndex) return <IndexErrorAlert error={missingIndex} what="The request board" />;
    return (
      <p role="alert" className="text-sm text-red-700 dark:text-red-400">
        The request board could not be loaded just now. Please try again.
      </p>
    );
  }
  return (
    <>
      <h2 className="mt-4 text-sm font-medium text-neutral-500">Credential requests</h2>
      <LiveKanban initialRequests={requests} renderedAt={renderedAt} />
    </>
  );
}
