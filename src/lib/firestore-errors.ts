/**
 * Recognises Firestore's "this query needs a composite index" failure and pulls out the link
 * Firebase puts in the message, so an admin can click it and build the index in one step.
 *
 * Firestore reports it as gRPC code 9 (`FAILED_PRECONDITION`) with a message like
 * "9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console…".
 */

export interface IndexError {
  /** The exact Firebase Console link from the error, or `null` if the message carried none. */
  link: string | null;
}

const CONSOLE_LINK = /https:\/\/console\.firebase\.google\.com\/[^\s"'<>)]+/;

/** Firebase prints the link at the end of a sentence; drop trailing punctuation that is not part of it. */
function trimLink(link: string): string {
  return link.replace(/[.,;:]+$/, '');
}

export function indexErrorOf(cause: unknown): IndexError | null {
  const message =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : String(cause);
  const code = (cause as { code?: unknown } | null)?.code;
  const failedPrecondition =
    code === 9 || code === 'failed-precondition' || /FAILED_PRECONDITION/.test(message);
  if (!failedPrecondition || !/index/i.test(message)) return null;
  const link = CONSOLE_LINK.exec(message)?.[0];
  return { link: link ? trimLink(link) : null };
}
