import { describe, expect, it } from 'vitest';

import { createTemplate, textBox } from '../../../tests/support/engine-fixtures';

import { VERIFY_QR_TEMPLATE } from './ids';
import {
  sampleVerificationRow,
  usesVerification,
  verificationQr,
  withVerificationQr,
} from './template';

const PAGES = [{ width: 842, height: 595 }];
const BOX = { x: 10, y: 10, width: 100, height: 20 };

describe('usesVerification', () => {
  it('is false for a template that never reads the verification columns', () => {
    expect(
      usesVerification(createTemplate(PAGES, [textBox({ id: 'a', box: BOX })]).placeholders),
    ).toBe(false);
  });

  it('is true when any field reads the id or address, by column or inside a template string', () => {
    const template = createTemplate(PAGES, []);
    const qr = verificationQr(template.pages[0]!, new Set());
    expect(usesVerification([qr])).toBe(true);
    expect(
      usesVerification([{ ...qr, binding: { kind: 'column', column: 'verification_id' } }]),
    ).toBe(true);
    expect(
      usesVerification([
        { ...qr, binding: { kind: 'template', template: 'https://x.in/{{verification_url}}?a=1' } },
      ]),
    ).toBe(true);
    expect(
      usesVerification([{ ...qr, binding: { kind: 'static', value: 'verification_url' } }]),
    ).toBe(false);
  });
});

describe('verificationQr', () => {
  it('sits inside the bottom-right of the first page and prints the verification address', () => {
    const [page] = createTemplate(PAGES, []).pages;
    const qr = verificationQr(page!, new Set());
    expect(qr).toMatchObject({
      type: 'qr',
      pageIndex: 0,
      binding: { kind: 'template', template: VERIFY_QR_TEMPLATE },
      foreground: '#000000',
      quietZone: 4,
    });
    expect(qr.box.x + qr.box.width).toBeLessThanOrEqual(page!.width);
    expect(qr.box.y + qr.box.height).toBeLessThanOrEqual(page!.height);
  });

  it('picks an id that is not taken', () => {
    const [page] = createTemplate(PAGES, []).pages;
    expect(verificationQr(page!, new Set(['verification-qr'])).id).toBe('verification-qr-2');
  });
});

describe('withVerificationQr', () => {
  it('adds one QR, and only one', () => {
    const template = createTemplate(PAGES, [textBox({ id: 'name', box: BOX })]);
    const once = withVerificationQr(template);
    expect(once.placeholders).toHaveLength(2);
    expect(withVerificationQr(once)).toBe(once);
  });
});

describe('sampleVerificationRow', () => {
  it('is a test address that clearly will not verify', () => {
    const row = sampleVerificationRow('https://app.example.in');
    expect(row.verification_url).toBe('https://app.example.in/verify/test-only');
    expect(row.verification_id).toBe('TEST-ONLY');
  });
});
