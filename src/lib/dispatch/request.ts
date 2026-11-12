/**
 * The body accepted by `POST /api/dispatch/whatsapp` and `POST /api/dispatch/email`, and the pure
 * helpers that turn it into messages. Framework-free: unit-tested in Node.
 *
 *     {
 *       "idempotencyKey": "batch-2026-03-15-class-10",   // same key = same dispatch, never re-sent or re-charged
 *       "templateId": "tpl-certificate",                  // a template of the caller's institution
 *       "tokenExpiry": "2026-12-31T18:29:59Z",            // when the claim links stop working (≤ 90 days)
 *       "targets": [{ "recipientName": "Aarav Sharma", "phone": "98765 43210" }]
 *     }
 *
 * The server mints one claim token per recipient (ADR-026) and builds each link from `APP_ORIGIN`
 * + token; the request can supply neither, so a compromised staff account cannot use our WhatsApp
 * number or email domain to send links to other sites.
 */
import { z } from 'zod';

import { normalizePhone } from '@/lib/claim/contact';
import { MAX_CLAIM_TTL_DAYS } from '@/types/audit';

export { normalizePhone };

export type DispatchChannel = 'whatsapp' | 'email';

/** Credits charged per recipient. One message = one credit until pricing is decided (PLAN E12). */
export const DISPATCH_CREDIT_COST: Record<DispatchChannel, number> = { whatsapp: 1, email: 1 };

/** Claim fee limits in paise: Razorpay's minimum (₹1) to ₹10,000. */
export const MIN_CLAIM_FEE_PAISE = 100;
export const MAX_CLAIM_FEE_PAISE = 1_000_000;

/** Largest number of recipients in one request (kept within one HTTP request's time budget). */
export const MAX_DISPATCH_TARGETS = 500;

/** A name as it may appear inside a WhatsApp template parameter: one line, no runs of spaces. */
const recipientName = z
  .string()
  .transform((value) => value.replace(/[\s\u0000-\u001F\u007F]+/g, ' ').trim())
  .pipe(z.string().min(1, 'is empty').max(100, 'is longer than 100 characters'));

const isoDate = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO 8601 date-time');

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

const schemas = {
  whatsapp: z.object({ recipientName, phone }).strict(),
  email: z.object({ recipientName, email }).strict(),
};

/** A recipient as requested. */
export type WhatsAppRecipient = z.output<typeof schemas.whatsapp>;
export type EmailRecipient = z.output<typeof schemas.email>;
export type DispatchRecipient<C extends DispatchChannel> = C extends 'whatsapp'
  ? WhatsAppRecipient
  : EmailRecipient;

/** What a sender gets: the recipient plus their freshly minted claim token and its expiry. */
export interface ClaimFields {
  claimToken: string;
  /** ISO 8601. */
  expiresAt: string;
}
export type WhatsAppTarget = WhatsAppRecipient & ClaimFields;
export type EmailTarget = EmailRecipient & ClaimFields;
export type DispatchTarget<C extends DispatchChannel> = DispatchRecipient<C> & ClaimFields;

export interface DispatchRequest<C extends DispatchChannel = DispatchChannel> {
  idempotencyKey: string;
  templateId: string;
  /** ISO 8601; validated to be in the future and within `MAX_CLAIM_TTL_DAYS`. */
  tokenExpiry: string;
  /** Fee the recipient pays to claim, in paise (0 = free; else ₹1–₹10,000). */
  claimFeePaise: number;
  targets: DispatchRecipient<C>[];
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
 * Validates a dispatch body. Rejects an expiry in the past or too far ahead, and duplicate
 * recipients (each would be charged and messaged twice). `now` is injectable for tests.
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
      templateId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'is not a template id'),
      tokenExpiry: isoDate,
      claimFeePaise: z
        .number()
        .int('must be whole paise')
        .refine((n) => n === 0 || (n >= MIN_CLAIM_FEE_PAISE && n <= MAX_CLAIM_FEE_PAISE), {
          message: `must be 0 or between ${MIN_CLAIM_FEE_PAISE} and ${MAX_CLAIM_FEE_PAISE} paise`,
        })
        .optional(),
      targets: z
        .array(schemas[channel])
        .min(1, 'must list at least one recipient')
        .max(MAX_DISPATCH_TARGETS, `may list at most ${MAX_DISPATCH_TARGETS} recipients`),
    })
    .strict();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, message: describe(parsed.error.issues[0]!) };

  const expiry = Date.parse(parsed.data.tokenExpiry);
  if (expiry <= now) return { ok: false, message: 'tokenExpiry is already in the past.' };
  if (expiry - now > MAX_CLAIM_TTL_DAYS * 86_400_000) {
    return { ok: false, message: `tokenExpiry may be at most ${MAX_CLAIM_TTL_DAYS} days ahead.` };
  }
  const targets = parsed.data.targets as DispatchRecipient<C>[];
  const seen = new Map<string, number>();
  for (const [index, target] of targets.entries()) {
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
  return {
    ok: true,
    value: {
      idempotencyKey: parsed.data.idempotencyKey,
      templateId: parsed.data.templateId,
      tokenExpiry: new Date(expiry).toISOString(),
      claimFeePaise: parsed.data.claimFeePaise ?? 0,
      targets,
    },
  };
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
