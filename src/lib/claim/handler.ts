/**
 * HTTP handling of the claim and vault routes. Each acts for the signed-in recipient (session
 * cookie, same-origin, JSON):
 *
 *   POST   /api/claim         { token }              → 200 { vaultItemId, alreadyClaimed }
 *   POST   /api/vault/share   { itemId, enabled }    → 200 { shareId, url }
 *
 * A credential with a fee answers 402 PAYMENT_REQUIRED here; it is paid for through
 * `/api/checkout` (ADR-028). Errors: `{ error: { code, message } }`.
 */
import 'server-only';

import { adminFirestore } from '@/lib/server/firebase-admin';
import { error, gate, json, log } from '@/lib/server/json-route';
import { setSharing, VaultError } from '@/lib/vault/vault';

import { CLAIM_ERROR_STATUS, ClaimError, claimCredential } from './claim';

const SIGNED_IN = { kind: 'signed-in' } as const;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

/** Maps a claim or checkout failure to a response; unexpected failures are logged as 503. */
export function claimFailure(cause: unknown, operation: string): Response {
  if (cause instanceof ClaimError) {
    return error(CLAIM_ERROR_STATUS[cause.code], cause.code, cause.message);
  }
  log('ERROR', `${operation} failed`, { cause: String(cause) });
  return error(503, 'UNAVAILABLE', 'This is temporarily unavailable. Try again shortly.');
}

/** The raw claim token in a JSON body, or `null` when missing or malformed. */
export function readToken(body: unknown): string | null {
  const token = (body as { token?: unknown } | null)?.token;
  return typeof token === 'string' && TOKEN.test(token) ? token : null;
}

export async function handleClaim(request: Request): Promise<Response> {
  const checked = await gate(request, SIGNED_IN, 'Sign in to claim.');
  if (!checked.ok) return checked.response;
  const token = readToken(checked.body);
  if (!token) return error(400, 'INVALID_REQUEST', 'Malformed claim request.');
  try {
    const result = await claimCredential({
      db: adminFirestore(),
      user: checked.user,
      rawToken: token,
    });
    log('INFO', 'claim', { uid: checked.user.uid, ...result });
    return json(200, result);
  } catch (cause) {
    return claimFailure(cause, 'claim');
  }
}

export async function handleShare(request: Request): Promise<Response> {
  const checked = await gate(request, SIGNED_IN, 'Sign in first.');
  if (!checked.ok) return checked.response;
  const body = checked.body as { itemId?: unknown; enabled?: unknown } | null;
  if (
    typeof body?.itemId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(body.itemId) ||
    typeof body.enabled !== 'boolean'
  ) {
    return error(400, 'INVALID_REQUEST', 'Malformed request.');
  }
  try {
    const { shareId } = await setSharing(adminFirestore(), checked.user, body.itemId, body.enabled);
    const origin = process.env.APP_ORIGIN?.trim() || new URL(request.url).origin;
    return json(200, {
      shareId,
      url: shareId ? new URL(`/v/${shareId}`, origin).toString() : null,
    });
  } catch (cause) {
    if (cause instanceof VaultError) return error(404, cause.code, cause.message);
    log('ERROR', 'share failed', { cause: String(cause) });
    return error(503, 'UNAVAILABLE', 'This is temporarily unavailable. Try again shortly.');
  }
}
