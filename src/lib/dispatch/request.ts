/**
 * The body accepted by `POST /api/dispatch/whatsapp` and `POST /api/dispatch/email`, and the pure
 * helpers that turn it into messages. Framework-free: unit-tested in Node.
 *
 *     {
 *       "idempotencyKey": "batch-2026-03-15-class-10",          // same key = same dispatch, never re-sent or re-charged
 *       "targets": [
 *         { "recipientName": "Aarav Sharma", "phone": "98765 43210",
 *           "claimToken": "c1a2b3...", "expiresAt": "2026-12-31T18:29:59Z" }
 *       ]
 *     }
 *
 * The claim link is built on the server from `APP_ORIGIN` + the token, never taken from the
 * request: a compromised staff account cannot use our WhatsApp number or email domain to send
 * links to other sites.
 */
import { z } from 'zod';

export type DispatchChannel = 'whatsapp' | 'email';

/** Credits charged per recipient. One message = one credit until pricing is decided (PLAN E12). */
export const DISPATCH_CREDIT_COST: Record<DispatchChannel, number> = { whatsapp: 1, email: 1 };

/** Largest number of recipients in one request (kept within one HTTP request's time budget). */
export const MAX_DISPATCH_TARGETS = 500;

const CLAIM_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

/** A name as it may appear inside a WhatsApp template parameter: one line, no runs of spaces. */
const recipientName = z
  .string()
  .transform((value) => value.replace(/[\s\u0000-\u001F\u007F]+/g, ' ').trim())
  .pipe(z.string().min(1, 'is empty').max(100, 'is longer than 100 characters'));

const claimToken = z.string().regex(CLAIM_TOKEN, 'must be 16–128 letters, digits, - or _');

const expiresAt = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO 8601 date-time');

/**
 * Normalises an Indian or international mobile number to the digits WhatsApp expects (country
 * code, no `+`). A 10-digit Indian mobile number (starting 6–9) gets `91`. Returns `null` when the
 * value cannot be a mobile number.
 */
export function normalizePhone(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  let digits = trimmed.replace(/\D/g, '');
  if (!trimmed.startsWith('+')) {
    if (/^0[6-9]\d{9}$/.test(digits)) digits = digits.slice(1);
    if (/^[6-9]\d{9}$/.test(digits)) digits = `91${digits}`;
  }
  if (digits.startsWith('91') && !/^91[6-9]\d{9}$/.test(digits)) return null;
  // Country code + subscriber number: 11–15 digits (a bare 10-digit number must be Indian).
  return /^[1-9]\d{10,14}$/.test(digits) ? digits : null;
}

const phone = z.string().transform((value, context) => {
  const normalized = normalizePhone(value);
  if (!normalized) {
    context.addIssue({ code: 'custom', message: 'is not a valid mobile number' });
    return z.NEVER;
  }
  return normalized;
});

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('is not a valid email address').max(254));

const base = { recipientName, claimToken, expiresAt };

const schemas = {
  whatsapp: z.object({ ...base, phone }).strict(),
  email: z.object({ ...base, email }).strict(),
};

export type WhatsAppTarget = z.output<typeof schemas.whatsapp>;
export type EmailTarget = z.output<typeof schemas.email>;
export type DispatchTarget<C extends DispatchChannel> = C extends 'whatsapp'
  ? WhatsAppTarget
  : EmailTarget;

export interface DispatchRequest<C extends DispatchChannel = DispatchChannel> {
  idempotencyKey: string;
  targets: DispatchTarget<C>[];
}

export type ParseResult<C extends DispatchChannel> =
  { ok: true; value: DispatchRequest<C> } | { ok: false; message: string };

function describe(issue: z.core.$ZodIssue): string {
  const [, index, field] = issue.path;
  if (issue.path[0] === 'targets' && typeof index === 'number') {
    return `Recipient ${index + 1}${field ? ` (${String(field)})` : ''} ${issue.message}.`;
  }
  return `${issue.path.join('.') || 'Body'}: ${issue.message}.`;
}

/**
 * Validates a dispatch body. Rejects expired links and duplicate recipients (each would be charged
 * and messaged twice). `now` is injectable for tests.
 */
export function parseDispatchRequest<C extends DispatchChannel>(
  channel: C,
  body: unknown,
  now = Date.now(),
): ParseResult<C> {
  const schema = z
    .object({
      idempotencyKey: z
        .string()
        .regex(/^[A-Za-z0-9._:-]{8,128}$/, 'must be 8–128 letters, digits, . _ : or -'),
      targets: z
        .array(schemas[channel])
        .min(1, 'must list at least one recipient')
        .max(MAX_DISPATCH_TARGETS, `may list at most ${MAX_DISPATCH_TARGETS} recipients`),
    })
    .strict();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, message: describe(parsed.error.issues[0]!) };

  const targets = parsed.data.targets as DispatchTarget<C>[];
  const seen = new Map<string, number>();
  for (const [index, target] of targets.entries()) {
    if (Date.parse(target.expiresAt) <= now) {
      return { ok: false, message: `Recipient ${index + 1}: the claim link has already expired.` };
    }
    const contact = 'phone' in target ? target.phone : target.email;
    const earlier = seen.get(contact);
    if (earlier !== undefined) {
      return {
        ok: false,
        message: `Recipients ${earlier + 1} and ${index + 1} have the same ${channel === 'whatsapp' ? 'number' : 'address'}.`,
      };
    }
    seen.set(contact, index);
  }
  return { ok: true, value: { idempotencyKey: parsed.data.idempotencyKey, targets } };
}

/** The link a recipient opens to claim the credential (and whose QR the claim page shows). */
export function claimUrl(appOrigin: string, token: string): string {
  return new URL(`/claim/${encodeURIComponent(token)}`, appOrigin).toString();
}

/** "31 Dec 2026", in Indian time — the expiry as recipients read it. */
export function formatExpiry(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(iso));
}

/** One recipient's outcome, as stored and returned. No contact details (DPDP: data minimisation). */
export interface TargetResult {
  /** Position in the request's `targets`. */
  index: number;
  status: 'sent' | 'failed';
  /** The provider's message id, for support queries. */
  providerId?: string;
  /** Short reason when failed. */
  error?: string;
}

/** What a sender needs to know about the issuer and the links. */
export interface MessageContext {
  issuerName: string;
  appOrigin: string;
}
