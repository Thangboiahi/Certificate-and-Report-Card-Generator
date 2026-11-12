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
  ...overrides,
});
const body = (targets: unknown[], overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: 'batch-0001',
  templateId: 'tpl-cert',
  tokenExpiry: FUTURE,
  targets,
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
      body([whatsapp({ recipientName: '  Aarav\n  Sharma ' })]),
      NOW,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        idempotencyKey: 'batch-0001',
        templateId: 'tpl-cert',
        tokenExpiry: '2026-12-31T18:29:59.000Z',
        targets: [{ recipientName: 'Aarav Sharma', phone: '919876543210' }],
      },
    });
  });

  it('lower-cases email addresses', () => {
    const result = parseDispatchRequest(
      'email',
      body([{ recipientName: 'A', email: ' Asha@Example.IN ' }]),
      NOW,
    );
    expect(result.ok && result.value.targets[0]!.email).toBe('asha@example.in');
  });

  it.each([
    [{ ...body([whatsapp()]), idempotencyKey: undefined }, /idempotencyKey/],
    [body([whatsapp()], { idempotencyKey: 'short' }), /idempotencyKey/],
    [body([whatsapp()], { templateId: '../x' }), /templateId/],
    [body([]), /at least one/],
    [body([whatsapp({ phone: '123' })]), /Recipient 1 \(phone\)/],
    // The server mints tokens and builds links: the request may not supply them.
    [body([whatsapp({ claimToken: TOKEN })]), /Recipient 1/],
    [body([whatsapp({ claimUrl: 'https://evil.example' })]), /Recipient 1/],
    [body([whatsapp()], { tokenExpiry: '2026-01-01T00:00:00Z' }), /in the past/],
    [body([whatsapp()], { tokenExpiry: '2027-03-01T00:00:00Z' }), /at most 90 days/],
    [body([whatsapp()], { tokenExpiry: 'soon' }), /tokenExpiry/],
    [body([whatsapp(), whatsapp({ phone: '+919876543210' })]), /Recipients 1 and 2/],
    [body([whatsapp({ recipientName: ' ' })]), /recipientName/],
  ])('rejects %j', (input, message) => {
    const result = parseDispatchRequest('whatsapp', input, NOW);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(message);
  });

  it(`limits a request to ${MAX_DISPATCH_TARGETS} recipients`, () => {
    const targets = Array.from({ length: MAX_DISPATCH_TARGETS + 1 }, (_, i) =>
      whatsapp({ phone: `9${String(i).padStart(9, '0')}` }),
    );
    const result = parseDispatchRequest('whatsapp', body(targets), NOW);
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
