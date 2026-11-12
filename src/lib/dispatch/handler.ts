/**
 * Shared HTTP handling of the dispatch routes:
 *
 *   POST /api/dispatch/{whatsapp,email}   same-origin → JSON → institution member → provider
 *                                         configured → valid body → runDispatch (credits first)
 *   POST /api/dispatch/reissue            same-origin → JSON → signed in → runReissue (free)
 *
 * Responses are JSON. Errors: `{ error: { code, message, details? } }`.
 */
import 'server-only';

import { Resend } from 'resend';

import { authorize } from '@/lib/auth/session';
import { FirebaseConfigError, adminFirestore } from '@/lib/server/firebase-admin';
import { isSameOrigin } from '@/lib/server/same-origin';
import type { RouteAccess } from '@/lib/auth/access';
import type { SessionUser } from '@/types/roles';

import { emailConfigFromEnv, sendEmails } from './email';
import {
  parseDispatchRequest,
  type DispatchChannel,
  type EmailTarget,
  type WhatsAppTarget,
} from './request';
import {
  DispatchError,
  runDispatch,
  runReissue,
  type DispatchErrorCode,
  type DispatchSender,
} from './run';
import { sendWhatsApp, whatsAppConfigFromEnv } from './whatsapp';

const MAX_BODY_BYTES = 512 * 1024;

const STATUS: Record<DispatchErrorCode, number> = {
  NOT_INSTITUTION_MEMBER: 403,
  INSTITUTION_NOT_FOUND: 403,
  INSTITUTION_NOT_VERIFIED: 403,
  TEMPLATE_NOT_FOUND: 400,
  INSUFFICIENT_CREDITS: 402,
  DISPATCH_IN_PROGRESS: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  BATCH_NOT_FOUND: 404,
  REISSUE_BLOCKED: 409,
  NOTHING_TO_REISSUE: 409,
};

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function error(status: number, code: string, message: string, details?: object): Response {
  return json(status, { error: { code, message, ...(details ? { details } : {}) } });
}

/** `APP_ORIGIN` — claim links are built from it, never from request headers. */
function appOrigin(): string | null {
  const value = process.env.APP_ORIGIN?.trim();
  return value && URL.canParse(value) ? new URL(value).origin : null;
}

/** Builds the provider call for a channel, or `null` when the server is not configured for it. */
function senderFor(channel: DispatchChannel): DispatchSender<DispatchChannel> | null {
  const origin = appOrigin();
  if (!origin) return null;
  if (channel === 'whatsapp') {
    const config = whatsAppConfigFromEnv();
    if (!config) return null;
    return (targets, { issuerName }) =>
      sendWhatsApp(targets as WhatsAppTarget[], { issuerName, appOrigin: origin }, config);
  }
  const config = emailConfigFromEnv();
  if (!config) return null;
  const client = new Resend(config.apiKey);
  return (targets, { issuerName, dispatchId }) =>
    sendEmails(
      targets as EmailTarget[],
      { issuerName, appOrigin: origin },
      config,
      client,
      dispatchId,
    );
}

const log = (severity: string, message: string, fields: object) =>
  console[severity === 'ERROR' ? 'error' : 'info'](
    JSON.stringify({ severity, message, ...fields }),
  );

type Gate = { ok: true; user: SessionUser; body: unknown } | { ok: false; response: Response };

/** Same-origin, JSON, signed in with the required access, body within limits and parseable. */
async function gate(request: Request, access: RouteAccess, forbidden: string): Promise<Gate> {
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
    log('ERROR', 'dispatch auth unavailable', { cause: String(cause) });
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

function failure(cause: unknown, operation: string): Response {
  if (cause instanceof DispatchError) {
    return error(STATUS[cause.code], cause.code, cause.message, cause.details);
  }
  log('ERROR', `${operation} failed`, { cause: String(cause) });
  return cause instanceof FirebaseConfigError
    ? error(500, 'SERVER_MISCONFIGURED', 'The server is not configured.')
    : error(503, 'DISPATCH_UNAVAILABLE', 'Sending is temporarily unavailable. Try again shortly.');
}

export async function handleDispatchRequest(
  request: Request,
  channel: DispatchChannel,
): Promise<Response> {
  const checked = await gate(
    request,
    { kind: 'roles', roles: ['inst_admin', 'inst_staff'] },
    'Only institution admins and staff can send messages.',
  );
  if (!checked.ok) return checked.response;
  const send = senderFor(channel);
  if (!send) {
    return error(
      503,
      'DISPATCH_NOT_CONFIGURED',
      `${channel === 'whatsapp' ? 'WhatsApp' : 'Email'} sending is not configured on this server.`,
    );
  }
  const parsed = parseDispatchRequest(channel, checked.body);
  if (!parsed.ok) return error(400, 'INVALID_REQUEST', parsed.message);
  try {
    const outcome = await runDispatch({
      db: adminFirestore(),
      user: checked.user,
      channel,
      request: parsed.value,
      send,
    });
    log('INFO', 'dispatch', {
      channel,
      institutionId: checked.user.institutionId,
      dispatchId: outcome.dispatchId,
      replayed: outcome.replayed,
      sent: outcome.sent,
      failed: outcome.failed,
    });
    return json(200, outcome);
  } catch (cause) {
    return failure(cause, 'dispatch');
  }
}

/** Body: `{ "batchId": "<issued_batches id>" }`. Success: 200 `ReissueOutcome`. */
export async function handleReissueRequest(request: Request): Promise<Response> {
  const checked = await gate(request, { kind: 'signed-in' }, 'Sign in to re-issue.');
  if (!checked.ok) return checked.response;
  const batchId = (checked.body as { batchId?: unknown } | null)?.batchId;
  if (typeof batchId !== 'string' || !/^[a-f0-9]{64}$/.test(batchId)) {
    return error(400, 'INVALID_REQUEST', 'batchId is missing or malformed.');
  }
  try {
    const outcome = await runReissue({
      db: adminFirestore(),
      user: checked.user,
      batchId,
      senderFor,
    });
    log('INFO', 'reissue', {
      batchId,
      uid: checked.user.uid,
      recipients: outcome.recipients,
      sent: outcome.sent,
    });
    return json(200, outcome);
  } catch (cause) {
    if (cause instanceof Error && /not configured/.test(cause.message)) {
      return error(503, 'DISPATCH_NOT_CONFIGURED', 'Sending is not configured on this server.');
    }
    return failure(cause, 'reissue');
  }
}
