import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { VerificationState } from '@/lib/vault/verification';
import type { SharedCredential } from '@/lib/vault/vault';

import { VerificationResult } from './VerificationResult';

const CREDENTIAL: SharedCredential = {
  claimed: true,
  credentialName: 'Class 10 certificate',
  issuerName: 'Sunrise Public School',
  issuerType: 'institution',
  issuerVerified: true,
  recipientName: 'Asha Rao',
  status: 'valid',
  issuedAt: Date.UTC(2026, 2, 15, 6),
  expiresAt: Date.UTC(2026, 5, 1),
  revokedAt: Date.UTC(2026, 6, 1),
};

const render = (state: VerificationState) =>
  renderToStaticMarkup(<VerificationResult credential={CREDENTIAL} state={state} />);

describe('VerificationResult', () => {
  it('valid: green Verified, details, and the LinkedIn button', () => {
    const html = render('valid');
    expect(html).toContain('Verified</p>');
    expect(html).toContain('add-to-linkedin');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(/>(Revoked|Expired)</);
  });

  it('unclaimed: says issued-not-claimed, no LinkedIn button, and no Expired or Revoked stamp', () => {
    const html = render('unclaimed');
    expect(html).toContain('Issued, not yet claimed');
    expect(html).toContain('Recorded');
    expect(html).not.toContain('add-to-linkedin');
    expect(html).not.toMatch(/>(Revoked|Expired)</);
    expect(html).not.toContain('INVALID');
  });

  it('revoked: a red alert telling people to contact the issuer, stamped, no LinkedIn button', () => {
    const html = render('revoked');
    expect(html).toContain('role="alert"');
    expect(html).toContain('INVALID / REVOKED');
    expect(html).toContain('Contact Sunrise Public School');
    expect(html).toContain('>Revoked<');
    expect(html).not.toContain('add-to-linkedin');
  });

  it('expired: an amber alert, stamped, no LinkedIn button', () => {
    const html = render('expired');
    expect(html).toContain('EXPIRED');
    expect(html).toContain('>Expired<');
    expect(html).not.toContain('add-to-linkedin');
    expect(html).not.toContain('INVALID');
  });
});
