import { describe, expect, it, vi } from 'vitest';

import { claimEmail, emailConfigFromEnv, sendEmails } from './email';
import type { EmailTarget, WhatsAppTarget } from './request';
import { sendWhatsApp, whatsAppConfigFromEnv, whatsAppPayload } from './whatsapp';

const CONTEXT = { issuerName: 'Sunrise <Public> School', appOrigin: 'https://app.example.in' };
const EXPIRES = '2026-12-31T12:00:00Z';
const wa = (i: number): WhatsAppTarget => ({
  recipientName: `Student ${i}`,
  phone: `9198765432${String(i).padStart(2, '0')}`,
  claimToken: `token-${String(i).padStart(12, '0')}`,
  expiresAt: EXPIRES,
});
const mail = (i: number): EmailTarget => ({
  recipientName: `Student <${i}>`,
  email: `s${i}@example.in`,
  claimToken: `token-${String(i).padStart(12, '0')}`,
  expiresAt: EXPIRES,
});

const WA_CONFIG = whatsAppConfigFromEnv({
  WHATSAPP_ACCESS_TOKEN: 'secret',
  WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  WHATSAPP_CLAIM_TEMPLATE: 'credential_claim',
  WHATSAPP_API_BASE_URL: 'https://graph.test/v23.0/',
})!;

describe('WhatsApp', () => {
  it('needs a token, a numeric phone number id and a template', () => {
    expect(whatsAppConfigFromEnv({})).toBeNull();
    expect(
      whatsAppConfigFromEnv({
        WHATSAPP_ACCESS_TOKEN: 'x',
        WHATSAPP_PHONE_NUMBER_ID: 'abc',
        WHATSAPP_CLAIM_TEMPLATE: 't',
      }),
    ).toBeNull();
    expect(WA_CONFIG).toMatchObject({ languageCode: 'en', apiBaseUrl: 'https://graph.test/v23.0' });
  });

  it('sends a Utility template with name, issuer, claim link and expiry', () => {
    expect(whatsAppPayload(wa(1), CONTEXT, WA_CONFIG)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919876543201',
      type: 'template',
      template: {
        name: 'credential_claim',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Student 1' },
              { type: 'text', text: 'Sunrise <Public> School' },
              { type: 'text', text: 'https://app.example.in/claim/token-000000000001' },
              { type: 'text', text: '31 Dec 2026' },
            ],
          },
        ],
      },
    });
  });

  it('reports each recipient, never throws, and limits concurrency', async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      expect(String(url)).toBe('https://graph.test/v23.0/1234567890/messages');
      expect((init!.headers as Record<string, string>).authorization).toBe('Bearer secret');
      const to = JSON.parse(String(init!.body)).to as string;
      if (to.endsWith('03')) throw new TypeError('network');
      if (to.endsWith('04'))
        return Response.json(
          { error: { code: 131026, message: 'undeliverable' } },
          { status: 400 },
        );
      return Response.json({ messages: [{ id: `wamid.${to}` }] });
    });
    const targets = Array.from({ length: 20 }, (_, i) => wa(i));
    const results = await sendWhatsApp(targets, CONTEXT, WA_CONFIG, fetchImpl as typeof fetch);
    expect(results).toHaveLength(20);
    expect(peak).toBeLessThanOrEqual(8);
    expect(results[0]).toEqual({ index: 0, status: 'sent', providerId: 'wamid.919876543200' });
    expect(results[3]).toEqual({ index: 3, status: 'failed', error: 'WhatsApp unreachable' });
    expect(results[4]).toEqual({ index: 4, status: 'failed', error: 'WhatsApp 400 (code 131026)' });
    expect(results.filter((r) => r.status === 'sent')).toHaveLength(18);
  });
});

describe('Email (Resend)', () => {
  const config = emailConfigFromEnv({ RESEND_API_KEY: 're_test', RESEND_FROM: 'Claims <c@x.in>' })!;

  it('escapes names in HTML and warns about expiry', () => {
    const email = claimEmail(mail(1), CONTEXT);
    expect(email.subject).toBe('Sunrise <Public> School has issued you a credential');
    expect(email.html).toContain('Hello Student &lt;1&gt;');
    expect(email.html).not.toContain('<Public>');
    expect(email.html).toContain('expires on 31 Dec 2026');
    expect(email.text).toContain('https://app.example.in/claim/token-000000000001');
  });

  it('batches by 100 with idempotency keys and maps failures per batch', async () => {
    const calls: { size: number; key?: string }[] = [];
    const client = {
      batch: {
        send: vi.fn(async (payload: { to: string[] }[], options?: { idempotencyKey?: string }) => {
          calls.push({ size: payload.length, key: options?.idempotencyKey });
          if (calls.length === 2)
            return {
              data: null,
              error: { name: 'rate_limit_exceeded', statusCode: 429, message: '' },
            };
          return {
            data: { data: payload.map((_, i) => ({ id: `em_${calls.length}_${i}` })) },
            error: null,
          };
        }),
      },
    };
    const targets = Array.from({ length: 230 }, (_, i) => mail(i));
    const results = await sendEmails(targets, CONTEXT, config, client as never, 'dispatch-1');
    expect(calls).toEqual([
      { size: 100, key: 'dispatch-1-0' },
      { size: 100, key: 'dispatch-1-1' },
      { size: 30, key: 'dispatch-1-2' },
    ]);
    expect(results[0]).toEqual({ index: 0, status: 'sent', providerId: 'em_1_0' });
    expect(results[150]).toEqual({
      index: 150,
      status: 'failed',
      error: 'Resend 429 rate_limit_exceeded',
    });
    expect(results[229]).toEqual({ index: 229, status: 'sent', providerId: 'em_3_29' });
  });
});
