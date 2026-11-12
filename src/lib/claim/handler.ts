/**
 * HTTP handling of the claim and vault routes. Each acts for the signed-in recipient (session
 * cookie, same-origin, JSON):
 *
 *   POST   /api/claim         { token, payment? }    → 200 { vaultItemId, alreadyClaimed }
 *   POST   /api/claim/order   { token }              → 200 { orderId, amount, currency, keyId, … }
 *   POST   /api/vault/share   { itemId, enabled }    → 200 { shareId, url }
 *
 * Errors: `{ error: { code, message } }`.
 */
import 'server-only';

import { adminFirestore } from '@/lib/server/firebase-admin';
import { error, gate, json, log } from '@/lib/server/json-route';
import { setSharing, VaultError } from '@/lib/vault/vault';

import {
  CLAIM_ERROR_STATUS,
  ClaimError,
  claimCredential,
  createClaimOrder,
  type PaymentProof,
} from './claim';
import { razorpayConfigFromEnv } from './razorpay';

const SIGNED_IN = { kind: 'signed-in' } as const;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

function claimFailure(cause: unknown, operation: string): Response {
  if (cause instanceof ClaimError) {
    return error(CLAIM_ERROR_STATUS[cause.code], cause.code, cause.message);
  }
  log('ERROR', `${operation} failed`, { cause: String(cause) });
  return error(503, 'UNAVAILABLE', 'This is temporarily unavailable. Try again shortly.');
}

function readToken(body: unknown): string | null {
  const token = (body as { token?: unknown } | null)?.token;
  return typeof token === 'string' && TOKEN.test(token) ? token : null;
}

function readPayment(body: unknown): PaymentProof | undefined | null {
  const payment = (body as { payment?: unknown } | null)?.payment;
  if (payment === undefined) return undefined;
  const p = payment as Record<string, unknown> | null;
  const ok =
    typeof p?.orderId === 'string' &&
    /^[A-Za-z0-9_]{1,64}$/.test(p.orderId) &&
    typeof p.paymentId === 'string' &&
    /^[A-Za-z0-9_]{1,64}$/.test(p.paymentId) &&
    typeof p.signature === 'string' &&
    /^[a-f0-9]{64}$/.test(p.signature);
  return ok ? (p as unknown as PaymentProof) : null;
}

export async function handleClaim(request: Request): Promise<Response> {
  const checked = await gate(request, SIGNED_IN, 'Sign in to claim.');
  if (!checked.ok) return checked.response;
  const token = readToken(checked.body);
  const payment = readPayment(checked.body);
  if (!token || payment === null) return error(400, 'INVALID_REQUEST', 'Malformed claim request.');
  try {
    const result = await claimCredential({
      db: adminFirestore(),
      user: checked.user,
      rawToken: token,
      payment,
      razorpay: razorpayConfigFromEnv(),
    });
    log('INFO', 'claim', { uid: checked.user.uid, ...result, paid: Boolean(payment) });
    return json(200, result);
  } catch (cause) {
    return claimFailure(cause, 'claim');
  }
}

export async function handleClaimOrder(request: Request): Promise<Response> {
  const checked = await gate(request, SIGNED_IN, 'Sign in to pay.');
  if (!checked.ok) return checked.response;
  const token = readToken(checked.body);
  if (!token) return error(400, 'INVALID_REQUEST', 'Malformed request.');
  try {
    const order = await createClaimOrder({
      db: adminFirestore(),
      user: checked.user,
      rawToken: token,
      razorpay: razorpayConfigFromEnv(),
    });
    return json(200, order);
  } catch (cause) {
    return claimFailure(cause, 'claim order');
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
