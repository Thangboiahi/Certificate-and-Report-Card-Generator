import { describe, expect, it } from 'vitest';

import {
  MAX_DISPATCH_TARGETS,
  claimUrl,
  formatExpiry,
  normalizePhone,
  parseDispatchRequest,
} from './request';

const NOW = Date.parse('2026-11-12T00:00:00Z');
const FUTURE = '2026-12-31T18:29:59Z';
const TOKEN = 'tok_0123456789abcdef';

const whatsapp = (overrides: Record<string, unknown> = {}) => ({
  recipientName: 'Aarav Sharma',
  phone: '98765 43210',
  claimToken: TOKEN,
  expiresAt: FUTURE,
  ...overrides,
});

describe('normalizePhone', () => {
  it.each([
    ['98765 43210', '919876543210'],
    ['098765-43210', '919876543210'],
    ['+91 98765 43210', '919876543210'],
    ['919876543210', '919876543210'],
    ['+44 7700 900123', '447700900123'],
  ])('%s → %s', (input, expected) => expect(normalizePhone(input)).toBe(expected));

  it.each(['12345', '5876543210', '+91 12345 67890', 'call me', ''])('rejects %j', (input) =>
    expect(normalizePhone(input)).toBeNull(),
  );
});

describe('parseDispatchRequest', () => {
  it('accepts and normalises a WhatsApp request', () => {
    const result = parseDispatchRequest(
      'whatsapp',
      {
        idempotencyKey: 'batch-0001',
        targets: [whatsapp({ recipientName: '  Aarav\n  Sharma ' })],
      },
      NOW,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        idempotencyKey: 'batch-0001',
        targets: [{ ...whatsapp(), recipientName: 'Aarav Sharma', phone: '919876543210' }],
      },
    });
  });

  it('lower-cases email addresses', () => {
    const result = parseDispatchRequest(
      'email',
      {
        idempotencyKey: 'batch-0002',
        targets: [
          { recipientName: 'A', email: ' Asha@Example.IN ', claimToken: TOKEN, expiresAt: FUTURE },
        ],
      },
      NOW,
    );
    expect(result.ok && result.value.targets[0]!.email).toBe('asha@example.in');
  });

  it.each([
    [{ targets: [whatsapp()] }, /idempotencyKey/],
    [{ idempotencyKey: 'short', targets: [whatsapp()] }, /idempotencyKey/],
    [{ idempotencyKey: 'batch-0001', targets: [] }, /at least one/],
    [
      { idempotencyKey: 'batch-0001', targets: [whatsapp({ phone: '123' })] },
      /Recipient 1 \(phone\)/,
    ],
    [
      { idempotencyKey: 'batch-0001', targets: [whatsapp({ claimToken: 'bad token!' })] },
      /claimToken/,
    ],
    [
      { idempotencyKey: 'batch-0001', targets: [whatsapp({ claimUrl: 'https://evil.example' })] },
      /Recipient 1/,
    ],
    [
      { idempotencyKey: 'batch-0001', targets: [whatsapp({ expiresAt: '2026-01-01T00:00:00Z' })] },
      /expired/,
    ],
    [
      { idempotencyKey: 'batch-0001', targets: [whatsapp(), whatsapp({ phone: '+919876543210' })] },
      /Recipients 1 and 2/,
    ],
    [
      { idempotencyKey: 'batch-0001', targets: [whatsapp({ recipientName: ' ' })] },
      /recipientName/,
    ],
  ])('rejects %j', (body, message) => {
    const result = parseDispatchRequest('whatsapp', body, NOW);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(message);
  });

  it(`limits a request to ${MAX_DISPATCH_TARGETS} recipients`, () => {
    const targets = Array.from({ length: MAX_DISPATCH_TARGETS + 1 }, (_, i) =>
      whatsapp({ phone: `9${String(i).padStart(9, '0')}` }),
    );
    const result = parseDispatchRequest('whatsapp', { idempotencyKey: 'batch-0001', targets }, NOW);
    expect(!result.ok && result.message).toMatch(/at most 500/);
  });
});

describe('links and dates', () => {
  it('builds claim links on our own origin only', () => {
    expect(claimUrl('https://app.example.in', TOKEN)).toBe(`https://app.example.in/claim/${TOKEN}`);
  });

  it('formats the expiry in Indian time', () => {
    // 18:30 UTC on 31 Dec is already 1 Jan in India.
    expect(formatExpiry('2026-12-31T18:30:00Z')).toBe('1 Jan 2027');
  });
});
