/**
 * Shared plumbing of the JSON API routes that act on behalf of a signed-in user (dispatch, claim,
 * vault): same-origin check (CSRF), JSON only, session-cookie authorisation, size-limited body.
 */
import 'server-only';

import type { RouteAccess } from '@/lib/auth/access';
import { authorize } from '@/lib/auth/session';
import type { SessionUser } from '@/types/roles';

import { isSameOrigin } from './same-origin';

const MAX_BODY_BYTES = 512 * 1024;

export function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** `{ error: { code, message, details? } }` */
export function error(status: number, code: string, message: string, details?: object): Response {
  return json(status, { error: { code, message, ...(details ? { details } : {}) } });
}

export function log(severity: 'INFO' | 'ERROR', message: string, fields: object): void {
  console[severity === 'ERROR' ? 'error' : 'info'](
    JSON.stringify({ severity, message, ...fields }),
  );
}

export type Gate =
  { ok: true; user: SessionUser; body: unknown } | { ok: false; response: Response };

/** Same-origin, JSON, signed in with the required access, body within limits and parseable. */
export async function gate(
  request: Request,
  access: RouteAccess,
  forbidden: string,
): Promise<Gate> {
  if (!isSameOrigin(request)) {
    return { ok: false, response: error(403, 'CROSS_ORIGIN', 'Request refused.') };
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return { ok: false, response: error(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON.') };
  }
  let user: SessionUser;
  try {
    const result = await authorize(access);
    if (result.decision === 'unauthenticated') {
      return { ok: false, response: error(401, 'UNAUTHENTICATED', 'Sign in first.') };
    }
    if (result.decision === 'forbidden' || !result.user) {
      return { ok: false, response: error(403, 'FORBIDDEN', forbidden) };
    }
    user = result.user;
  } catch (cause) {
    log('ERROR', 'auth unavailable', { cause: String(cause) });
    return {
      ok: false,
      response: error(503, 'AUTH_UNAVAILABLE', 'Sign-in could not be checked. Try again shortly.'),
    };
  }
  const text = await request.text().catch(() => '');
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false, response: error(413, 'TOO_LARGE', 'The request is too large.') };
  }
  try {
    return { ok: true, user, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: error(400, 'INVALID_JSON', 'The body is not valid JSON.') };
  }
}
