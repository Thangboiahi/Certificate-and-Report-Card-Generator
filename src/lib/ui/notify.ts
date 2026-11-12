/**
 * Toast notifications for the whole app. Components call `notifyError(cause, fallback)` from a
 * `catch` instead of letting a failed request crash or silently freeze the screen.
 *
 * The message shown is the one the backend sent (our API routes answer `{ error: { message } }`
 * with text meant for people), or the caller's fallback. Raw error text from the runtime
 * (stack traces, "Failed to fetch") is never shown.
 */
import { toast } from 'sonner';

export { toast };

/** Thrown by `readApiError` so callers can still look at the HTTP status. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Builds an `ApiError` from a failed `Response` (`{ error: { code, message } }`). */
export async function readApiError(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  const fallback =
    response.status === 403
      ? 'You do not have permission to do that.'
      : response.status === 401
        ? 'Your session has ended. Sign in again.'
        : 'The server could not complete that. Please try again.';
  return new ApiError(body?.error?.message || fallback, response.status, body?.error?.code);
}

/** Firebase errors carry a `code` such as `permission-denied`; map the common ones to plain words. */
const FIREBASE_MESSAGES: Record<string, string> = {
  'permission-denied': 'You do not have permission to do that.',
  'firestore/permission-denied': 'You do not have permission to do that.',
  unauthenticated: 'Your session has ended. Sign in again.',
  unavailable: 'The service is not reachable right now. Check your connection and try again.',
  'failed-precondition': 'This data is still being prepared. Please try again in a few minutes.',
  'resource-exhausted': 'Too many requests. Please wait a moment and try again.',
  'auth/network-request-failed': 'No connection. Check your internet and try again.',
};

/** Error classes whose `message` is already written for the person using the app. */
const PEOPLE_ERRORS = new Set(['AiError', 'ApiError']);

/** The text to show for any caught value. */
export function errorMessage(
  cause: unknown,
  fallback = 'Something went wrong. Try again.',
): string {
  if (cause instanceof ApiError) return cause.message;
  const code = (cause as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && FIREBASE_MESSAGES[code]) return FIREBASE_MESSAGES[code];
  // Errors our own code throws with a message written for people.
  if (cause instanceof Error && PEOPLE_ERRORS.has(cause.name)) return cause.message;
  return fallback;
}

/** Shows an error toast and returns the message shown. */
export function notifyError(cause: unknown, fallback?: string): string {
  const message = errorMessage(cause, fallback);
  toast.error(message);
  return message;
}

export function notifySuccess(message: string): void {
  toast.success(message);
}
