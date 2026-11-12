/**
 * Shared HTTP handling of `POST /api/dispatch/{whatsapp,email}`:
 *
 *   same-origin → JSON → institution member (session cookie, revocation checked) → provider
 *   configured → valid body → runDispatch (credits deducted BEFORE the provider is called)
 *
 * Responses are JSON. Success: 200 with `DispatchOutcome`. Errors: `{ error: { code, message } }`
 * with 400 / 401 / 402 (credits) / 403 / 409 / 415 / 503.
 */
import 'server-only';

import { Resend } from 'resend';

import { authorize } from '@/lib/auth/session';
import { FirebaseConfigError, adminFirestore } from '@/lib/server/firebase-admin';
import { isSameOrigin } from '@/lib/server/same-origin';

import { emailConfigFromEnv, sendEmails } from './email';
import {
  parseDispatchRequest,
  type DispatchChannel,
  type EmailTarget,
  type WhatsAppTarget,
} from './request';
import { DispatchError, runDispatch, type DispatchErrorCode, type DispatchSender } from './run';
import { sendWhatsApp, whatsAppConfigFromEnv } from './whatsapp';

const MAX_BODY_BYTES = 512 * 1024;

const STATUS: Record<DispatchErrorCode, number> = {
  NOT_INSTITUTION_MEMBER: 403,
  INSTITUTION_NOT_FOUND: 403,
  INSTITUTION_NOT_VERIFIED: 403,
  INSUFFICIENT_CREDITS: 402,
  DISPATCH_IN_PROGRESS: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
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
function senderFor(
  channel: DispatchChannel,
  origin: string,
): DispatchSender<DispatchChannel> | null {
  if (channel === 'whatsapp') {
    const config = whatsAppConfigFromEnv();
    if (!config) return null;
    return (request, { issuerName }) =>
      sendWhatsApp(request.targets as WhatsAppTarget[], { issuerName, appOrigin: origin }, config);
  }
  const config = emailConfigFromEnv();
  if (!config) return null;
  const client = new Resend(config.apiKey);
  return (request, { issuerName, dispatchId }) =>
    sendEmails(
      request.targets as EmailTarget[],
      { issuerName, appOrigin: origin },
      config,
      client,
      dispatchId,
    );
}

export async function handleDispatchRequest(
  request: Request,
  channel: DispatchChannel,
): Promise<Response> {
  if (!isSameOrigin(request)) return error(403, 'CROSS_ORIGIN', 'Request refused.');
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return error(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON.');
  }

  let user;
  try {
    const result = await authorize({ kind: 'roles', roles: ['inst_admin', 'inst_staff'] });
    if (result.decision === 'unauthenticated') {
      return error(401, 'UNAUTHENTICATED', 'Sign in to send messages.');
    }
    if (result.decision === 'forbidden' || !result.user) {
      return error(403, 'FORBIDDEN', 'Only institution admins and staff can send messages.');
    }
    user = result.user;
  } catch (cause) {
    console.error(
      JSON.stringify({
        severity: 'ERROR',
        message: 'dispatch auth unavailable',
        cause: String(cause),
      }),
    );
    return error(503, 'AUTH_UNAVAILABLE', 'Sign-in could not be checked. Try again shortly.');
  }

  const origin = appOrigin();
  const send = origin ? senderFor(channel, origin) : null;
  if (!origin || !send) {
    return error(
      503,
      'DISPATCH_NOT_CONFIGURED',
      `${channel === 'whatsapp' ? 'WhatsApp' : 'Email'} sending is not configured on this server.`,
    );
  }

  const text = await request.text().catch(() => '');
  if (text.length > MAX_BODY_BYTES) return error(413, 'TOO_LARGE', 'The request is too large.');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return error(400, 'INVALID_JSON', 'The body is not valid JSON.');
  }
  const parsed = parseDispatchRequest(channel, body);
  if (!parsed.ok) return error(400, 'INVALID_REQUEST', parsed.message);

  try {
    const outcome = await runDispatch({
      db: adminFirestore(),
      user,
      channel,
      request: parsed.value,
      send,
    });
    console.info(
      JSON.stringify({
        severity: 'INFO',
        message: 'dispatch',
        channel,
        institutionId: user.institutionId,
        dispatchId: outcome.dispatchId,
        replayed: outcome.replayed,
        sent: outcome.sent,
        failed: outcome.failed,
      }),
    );
    return json(200, outcome);
  } catch (cause) {
    if (cause instanceof DispatchError) {
      return error(STATUS[cause.code], cause.code, cause.message, cause.details);
    }
    console.error(
      JSON.stringify({ severity: 'ERROR', message: 'dispatch failed', cause: String(cause) }),
    );
    return cause instanceof FirebaseConfigError
      ? error(500, 'SERVER_MISCONFIGURED', 'The server is not configured.')
      : error(
          503,
          'DISPATCH_UNAVAILABLE',
          'Sending is temporarily unavailable. Try again with the same idempotency key.',
        );
  }
}
