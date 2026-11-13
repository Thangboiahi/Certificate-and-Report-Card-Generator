/**
 * Razorpay, server side (ADR-028): the REST calls the escrow engine needs and webhook signature
 * verification. A small typed client over `fetch` rather than the `razorpay` npm package: the
 * fetch is injectable (unit tests, and a local mock in the end-to-end run via
 * `RAZORPAY_API_BASE_URL`), webhook signatures are compared in constant time, and no HTTP
 * library is added to the server bundle.
 *
 *   orders.create          POST /orders                 cart total + Route `transfers` (escrow)
 *   orders.fetchPayments   GET  /orders/{id}/payments   pull reconciliation
 *   payments.fetch         GET  /payments/{id}          refund status
 *   payments.refund        POST /payments/{id}/refund   `reverse_all` takes back the transfer
 *
 * Amounts are integers in paise; Route only supports INR.
 */
import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  /** Secret of the webhook endpoint (Dashboard → Webhooks); `null` until configured. */
  webhookSecret: string | null;
  /** REST root, e.g. `https://api.razorpay.com/v1` (a local mock in end-to-end tests). */
  apiBaseUrl: string;
}

const DEFAULT_API_BASE_URL = 'https://api.razorpay.com/v1';
const DEFAULT_TIMEOUT_MS = 10_000;

/** API keys from the environment, or `null` when payments are not configured. */
export function razorpayConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): RazorpayConfig | null {
  const keyId = env.RAZORPAY_KEY_ID?.trim();
  const keySecret = env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) return null;
  return {
    keyId,
    keySecret,
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET?.trim() || null,
    apiBaseUrl: (env.RAZORPAY_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, ''),
  };
}

/**
 * Whether the configured key is Razorpay's test key (`rzp_test_…`) or a live one (`rzp_live_…`).
 * Anything else is treated as live, so an unrecognised key never shows a "no real money" notice.
 * The key id itself is public: Checkout needs it in the browser, and the server hands it over with
 * each order (`/api/checkout`), so the page and the order always use the same key pair.
 */
export function razorpayMode(keyId: string): 'test' | 'live' {
  return keyId.startsWith('rzp_test_') ? 'test' : 'live';
}

// ── Identifiers ─────────────────────────────────────────────────────────────────────────────────

const ID_PATTERNS = {
  order: /^order_[A-Za-z0-9]{6,40}$/,
  payment: /^pay_[A-Za-z0-9]{6,40}$/,
  refund: /^rfnd_[A-Za-z0-9]{6,40}$/,
  account: /^acc_[A-Za-z0-9]{6,40}$/,
} as const;

/** Whether `value` looks like a Razorpay id of that kind (`order_…`, `pay_…`, `acc_…`). */
export function isRazorpayId(kind: keyof typeof ID_PATTERNS, value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERNS[kind].test(value);
}

// ── Resources ───────────────────────────────────────────────────────────────────────────────────

/** A Route transfer to a Linked Account, created when the order's payment is captured. */
export interface RazorpayTransferRequest {
  /** Linked Account id, `acc_…`. */
  account: string;
  /** Paise; at least 100. */
  amount: number;
  currency: 'INR';
  /** At most 15 pairs, 256 characters per value. */
  notes?: Record<string, string>;
  /** Keys of `notes` shown on the Linked Account's dashboard. */
  linked_account_notes?: string[];
  /** Escrow: settlement to the Linked Account waits until released or `on_hold_until`. */
  on_hold?: boolean;
  /** Unix seconds. */
  on_hold_until?: number;
}

export interface RazorpayOrderRequest {
  /** Paise; at least 100. */
  amount: number;
  currency: 'INR';
  /** At most 40 characters. */
  receipt?: string;
  notes?: Record<string, string>;
  transfers?: RazorpayTransferRequest[];
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

export type RazorpayPaymentStatus = 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';

/** The fields of a payment entity the escrow engine relies on. */
export interface RazorpayPayment {
  id: string;
  /** `null` for payments not made against an order. */
  order_id: string | null;
  amount: number;
  currency: string;
  status: RazorpayPaymentStatus;
  amount_refunded: number;
}

export interface RazorpayRefundRequest {
  /** Paise. */
  amount: number;
  /** Route: also reverse every transfer made from this payment. */
  reverse_all?: boolean;
  notes?: Record<string, string>;
}

export interface RazorpayRefund {
  id: string;
  payment_id: string;
  amount: number;
  status: string;
}

/** A failed call. `status` is 0 when Razorpay could not be reached at all. */
export class RazorpayApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'RazorpayApiError';
  }
}

/**
 * Checks a payment entity from Razorpay (a webhook payload or an API response) and keeps only
 * the fields we use. Returns `null` when it is not a well-formed payment.
 */
export function readPaymentEntity(value: unknown): RazorpayPayment | null {
  const p = value as Record<string, unknown> | null;
  if (!p || typeof p !== 'object' || !isRazorpayId('payment', p.id)) return null;
  const orderId = p.order_id ?? null;
  if (orderId !== null && !isRazorpayId('order', orderId)) return null;
  if (!Number.isSafeInteger(p.amount) || (p.amount as number) <= 0) return null;
  if (typeof p.currency !== 'string' || typeof p.status !== 'string') return null;
  const refunded = p.amount_refunded ?? 0;
  if (!Number.isSafeInteger(refunded) || (refunded as number) < 0) return null;
  return {
    id: p.id,
    order_id: orderId,
    amount: p.amount as number,
    currency: p.currency,
    status: p.status as RazorpayPaymentStatus,
    amount_refunded: refunded as number,
  };
}

// ── Client ──────────────────────────────────────────────────────────────────────────────────────

export interface RazorpayClient {
  /** Public key id, handed to Razorpay Checkout in the browser. */
  readonly keyId: string;
  readonly orders: {
    create(order: RazorpayOrderRequest): Promise<RazorpayOrder>;
    fetchPayments(orderId: string): Promise<RazorpayPayment[]>;
  };
  readonly payments: {
    fetch(paymentId: string): Promise<RazorpayPayment>;
    refund(paymentId: string, refund: RazorpayRefundRequest): Promise<RazorpayRefund>;
  };
}

export interface RazorpayClientOptions {
  fetchImpl?: typeof fetch;
  /** Per call. The webhook uses a short one: Razorpay waits 5 s for its answer. */
  timeoutMs?: number;
}

export function createRazorpayClient(
  config: Pick<RazorpayConfig, 'keyId' | 'keySecret' | 'apiBaseUrl'>,
  { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }: RazorpayClientOptions = {},
): RazorpayClient {
  const authorization = `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64')}`;

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${config.apiBaseUrl}${path}`, {
        method,
        headers: {
          authorization,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (cause) {
      throw new RazorpayApiError(0, null, `Razorpay unreachable: ${String(cause)}`);
    }
    const json = (await response.json().catch(() => null)) as {
      error?: { code?: unknown; description?: unknown };
    } | null;
    if (!response.ok) {
      const code = typeof json?.error?.code === 'string' ? json.error.code : null;
      const description =
        typeof json?.error?.description === 'string' ? json.error.description : 'no description';
      throw new RazorpayApiError(
        response.status,
        code,
        `Razorpay ${method} ${path.replace(/\/[a-z]+_[A-Za-z0-9]+/g, '/:id')} failed (${response.status}): ${description}`,
      );
    }
    if (json === null) throw new RazorpayApiError(response.status, null, 'Razorpay sent no JSON.');
    return json;
  }

  function payment(value: unknown): RazorpayPayment {
    const parsed = readPaymentEntity(value);
    if (!parsed) throw new RazorpayApiError(200, null, 'Razorpay sent a malformed payment.');
    return parsed;
  }

  function requireId(kind: keyof typeof ID_PATTERNS, value: string): string {
    if (!isRazorpayId(kind, value)) throw new TypeError(`Not a Razorpay ${kind} id.`);
    return value;
  }

  return {
    keyId: config.keyId,
    orders: {
      async create(order) {
        const body = (await call('POST', '/orders', order)) as Partial<RazorpayOrder>;
        if (!isRazorpayId('order', body.id) || body.amount !== order.amount) {
          throw new RazorpayApiError(200, null, 'Razorpay returned an unexpected order.');
        }
        return {
          id: body.id,
          amount: body.amount,
          currency: body.currency ?? order.currency,
          status: body.status ?? 'created',
        };
      },
      async fetchPayments(orderId) {
        const body = (await call('GET', `/orders/${requireId('order', orderId)}/payments`)) as {
          items?: unknown;
        };
        if (!Array.isArray(body.items)) {
          throw new RazorpayApiError(200, null, 'Razorpay sent a malformed payment list.');
        }
        return body.items.map(payment);
      },
    },
    payments: {
      async fetch(paymentId) {
        return payment(await call('GET', `/payments/${requireId('payment', paymentId)}`));
      },
      async refund(paymentId, refund) {
        const body = (await call(
          'POST',
          `/payments/${requireId('payment', paymentId)}/refund`,
          refund,
        )) as Partial<RazorpayRefund>;
        if (!isRazorpayId('refund', body.id)) {
          throw new RazorpayApiError(200, null, 'Razorpay returned an unexpected refund.');
        }
        return {
          id: body.id,
          payment_id: paymentId,
          amount: typeof body.amount === 'number' ? body.amount : refund.amount,
          status: typeof body.status === 'string' ? body.status : 'pending',
        };
      },
    },
  };
}

let cached: { signature: string; client: RazorpayClient } | null = null;

/**
 * The server's Razorpay client, initialised from the environment on first use (`null` when
 * `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` are not set). Re-created if the keys change.
 */
export function getRazorpayClient(
  env: Record<string, string | undefined> = process.env,
): RazorpayClient | null {
  const config = razorpayConfigFromEnv(env);
  if (!config) return null;
  const signature = `${config.keyId}\u0000${config.keySecret}\u0000${config.apiBaseUrl}`;
  if (cached?.signature !== signature) cached = { signature, client: createRazorpayClient(config) };
  return cached.client;
}

// ── Webhooks ────────────────────────────────────────────────────────────────────────────────────

/**
 * Exact check of `X-Razorpay-Signature`: hex HMAC-SHA256 of the RAW request body, keyed with
 * the webhook secret, compared in constant time. The body must be the bytes as received — a
 * re-serialised JSON object would not match.
 */
export function verifyWebhookSignature(
  rawBody: Uint8Array | string,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!secret || typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
