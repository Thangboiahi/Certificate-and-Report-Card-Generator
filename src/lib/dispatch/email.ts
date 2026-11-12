/**
 * Sends claim links by email through Resend's batch endpoint (up to 100 emails per call). Each
 * batch carries an idempotency key derived from the dispatch, so a retried HTTP call cannot send
 * twice.
 */
import type { Resend } from 'resend';

import {
  claimUrl,
  formatExpiry,
  type EmailTarget,
  type MessageContext,
  type TargetResult,
} from './request';

export interface EmailConfig {
  apiKey: string;
  /** Sender, e.g. `Certificates <claims@example.in>` — the domain must be verified in Resend. */
  from: string;
}

export function emailConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): EmailConfig | null {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.RESEND_FROM?.trim();
  return apiKey && from ? { apiKey, from } : null;
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );

/** Subject, HTML and plain-text bodies for one recipient. */
export function claimEmail(target: EmailTarget, context: MessageContext) {
  const link = claimUrl(context.appOrigin, target.claimToken);
  const expiry = formatExpiry(target.expiresAt);
  const name = escapeHtml(target.recipientName);
  const issuer = escapeHtml(context.issuerName);
  return {
    subject: `${context.issuerName} has issued you a credential`,
    text: [
      `Hello ${target.recipientName},`,
      '',
      `${context.issuerName} has issued you a credential. Claim it here:`,
      link,
      '',
      `This link expires on ${expiry}. Claim it before then — after that, ask ${context.issuerName} for a new one.`,
    ].join('\n'),
    html: `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#26262e;line-height:1.5">
<p>Hello ${name},</p>
<p>${issuer} has issued you a credential.</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:bold">Claim your credential</a></p>
<p style="color:#b45309"><strong>This link expires on ${escapeHtml(expiry)}.</strong> Claim it before then — after that, ask ${issuer} for a new one.</p>
<p style="color:#6e6e7a;font-size:12px">If the button does not work, open this address: ${escapeHtml(link)}</p>
</body></html>`,
  };
}

const BATCH_SIZE = 100;

/** Sends to every target. Never throws: failures are reported per recipient. */
export async function sendEmails(
  targets: readonly EmailTarget[],
  context: MessageContext,
  config: EmailConfig,
  client: Pick<Resend, 'batch'>,
  idempotencyPrefix: string,
): Promise<TargetResult[]> {
  const results: TargetResult[] = [];
  for (let start = 0; start < targets.length; start += BATCH_SIZE) {
    const chunk = targets.slice(start, start + BATCH_SIZE);
    const payload = chunk.map((target) => ({
      from: config.from,
      to: [target.email],
      ...claimEmail(target, context),
    }));
    let ids: (string | undefined)[] = [];
    let failure: string | null = null;
    try {
      const { data, error } = await client.batch.send(payload, {
        idempotencyKey: `${idempotencyPrefix}-${start / BATCH_SIZE}`,
      });
      if (error) failure = `Resend ${error.statusCode ?? ''} ${error.name}`.replace(/\s+/g, ' ');
      else ids = (data?.data ?? []).map((entry) => entry.id);
    } catch {
      failure = 'Resend unreachable';
    }
    chunk.forEach((_target, offset) => {
      const index = start + offset;
      const providerId = ids[offset];
      results.push(
        !failure && providerId
          ? { index, status: 'sent', providerId }
          : { index, status: 'failed', error: failure ?? 'Resend returned no id' },
      );
    });
  }
  return results;
}
