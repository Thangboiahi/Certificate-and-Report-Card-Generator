/**
 * Request handlers for `/api/requests` (Phase 12, ADR-033): the Kanban board's data.
 *
 *   GET   → 200 `{ requests: CredentialRequest[] }`              (the caller's board)
 *   POST  { recipientName, credential, email?, phone?, note? } → 201 `{ request }`
 *   PATCH { id, to, toIndex }                                      → 204
 *
 * Same-origin, session cookie, any signed-in user: the board shown is always the caller's own
 * (their institution's, or their personal one). Errors: `{ error: { code, message } }`.
 */
import 'server-only';

import { authorize } from '@/lib/auth/session';
import { adminFirestore, FirebaseConfigError } from '@/lib/server/firebase-admin';
import { error, gate, json, log } from '@/lib/server/json-route';

import {
  createRequest,
  listRequests,
  moveRequest,
  parseMove,
  parseNewRequest,
  RequestError,
} from './requests';

function failure(cause: unknown, what: string): Response {
  if (cause instanceof RequestError) {
    return error(cause.code === 'NOT_FOUND' ? 404 : 400, cause.code, cause.message);
  }
  log('ERROR', what, { cause: String(cause) });
  if (cause instanceof FirebaseConfigError) {
    return error(500, 'SERVER_MISCONFIGURED', 'The database is not configured on the server.');
  }
  return error(503, 'UNAVAILABLE', 'The board could not be reached. Try again shortly.');
}

export async function handleListRequests(): Promise<Response> {
  const { decision, user } = await authorize({ kind: 'signed-in' });
  if (decision === 'unauthenticated' || !user) {
    return error(401, 'UNAUTHENTICATED', 'Sign in first.');
  }
  try {
    return json(200, { requests: await listRequests(adminFirestore(), user) });
  } catch (cause) {
    return failure(cause, 'requests list');
  }
}

export async function handleCreateRequest(request: Request): Promise<Response> {
  const checked = await gate(request, { kind: 'signed-in' }, 'Sign in to add requests.');
  if (!checked.ok) return checked.response;
  try {
    const created = await createRequest(
      adminFirestore(),
      checked.user,
      parseNewRequest(checked.body),
    );
    return json(201, { request: created });
  } catch (cause) {
    return failure(cause, 'request create');
  }
}

export async function handleMoveRequest(request: Request): Promise<Response> {
  const checked = await gate(request, { kind: 'signed-in' }, 'Sign in to move requests.');
  if (!checked.ok) return checked.response;
  try {
    await moveRequest(adminFirestore(), checked.user, parseMove(checked.body));
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  } catch (cause) {
    return failure(cause, 'request move');
  }
}
