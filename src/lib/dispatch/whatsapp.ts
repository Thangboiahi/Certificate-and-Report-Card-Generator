/**
 * Sends claim links as WhatsApp **Utility template** messages through Meta's WhatsApp Cloud API
 * (`POST /{phone-number-id}/messages`). Business-initiated messages must use a pre-approved
 * template; ours (`WHATSAPP_CLAIM_TEMPLATE`, category Utility) is expected to have four body
 * parameters:
 *
 *     {{1}} recipient name · {{2}} issuer name · {{3}} claim link · {{4}} expiry date
 *
 * e.g. "Hello {{1}}, {{2}} has issued you a credential. Claim it here: {{3}}
 *       This link expires on {{4}}; claim it before then."
 *
 * The Cloud API has no idempotency key, so each recipient is sent at most once per dispatch (the
 * dispatch record, not a retry loop, guarantees it).
 */
import {
  claimUrl,
  formatExpiry,
  type MessageContext,
  type TargetResult,
  type WhatsAppTarget,
} from './request';

export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  templateName: string;
  languageCode: string;
  /** Graph API root including the version, e.g. `https://graph.facebook.com/v23.0`. */
  apiBaseUrl: string;
}

export const DEFAULT_GRAPH_API = 'https://graph.facebook.com/v23.0';

/** Reads the configuration, or `null` when WhatsApp dispatch is not set up on this server. */
export function whatsAppConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): WhatsAppConfig | null {
  const accessToken = env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const templateName = env.WHATSAPP_CLAIM_TEMPLATE?.trim();
  if (!accessToken || !phoneNumberId || !templateName) return null;
  if (!/^\d+$/.test(phoneNumberId)) return null;
  return {
    accessToken,
    phoneNumberId,
    templateName,
    languageCode: env.WHATSAPP_TEMPLATE_LANGUAGE?.trim() || 'en',
    apiBaseUrl: (env.WHATSAPP_API_BASE_URL?.trim() || DEFAULT_GRAPH_API).replace(/\/+$/, ''),
  };
}

/** The Cloud API request body for one recipient. */
export function whatsAppPayload(
  target: WhatsAppTarget,
  context: MessageContext,
  config: Pick<WhatsAppConfig, 'templateName' | 'languageCode'>,
) {
  const text = (value: string) => ({ type: 'text' as const, text: value });
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: target.phone,
    type: 'template',
    template: {
      name: config.templateName,
      language: { code: config.languageCode },
      components: [
        {
          type: 'body',
          parameters: [
            text(target.recipientName),
            text(context.issuerName),
            text(claimUrl(context.appOrigin, target.claimToken)),
            text(formatExpiry(target.expiresAt)),
          ],
        },
      ],
    },
  };
}

const CONCURRENCY = 8;
const TIMEOUT_MS = 10_000;

/** Sends to every target (8 at a time). Never throws: failures are reported per recipient. */
export async function sendWhatsApp(
  targets: readonly WhatsAppTarget[],
  context: MessageContext,
  config: WhatsAppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<TargetResult[]> {
  const results: TargetResult[] = new Array(targets.length);
  const endpoint = `${config.apiBaseUrl}/${config.phoneNumberId}/messages`;
  let next = 0;

  async function sendOne(index: number): Promise<TargetResult> {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(whatsAppPayload(targets[index]!, context, config)),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => null)) as {
        messages?: { id?: string }[];
        error?: { code?: number; message?: string };
      } | null;
      const providerId = body?.messages?.[0]?.id;
      if (response.ok && providerId) return { index, status: 'sent', providerId };
      const code = body?.error?.code;
      return {
        index,
        status: 'failed',
        error: `WhatsApp ${response.status}${code ? ` (code ${code})` : ''}`,
      };
    } catch (error) {
      return {
        index,
        status: 'failed',
        error:
          error instanceof Error && error.name === 'TimeoutError'
            ? 'WhatsApp timeout'
            : 'WhatsApp unreachable',
      };
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
      while (next < targets.length) {
        const index = next++;
        results[index] = await sendOne(index);
      }
    }),
  );
  return results;
}
