import { describe, expect, it } from 'vitest';

import { linkedInAddUrl } from './linkedin';

const CERT_URL = 'https://app.example.in/verify/abc_DEF-123';

describe('linkedInAddUrl', () => {
  it('fills the certification form from the credential', () => {
    const url = new URL(
      linkedInAddUrl({
        name: 'Class 10 certificate',
        organizationName: 'Sunrise Public School',
        issuedAt: Date.UTC(2026, 2, 15, 6, 0),
        certUrl: CERT_URL,
      }),
    );
    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/profile/add');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      startTask: 'CERTIFICATION_NAME',
      name: 'Class 10 certificate',
      organizationName: 'Sunrise Public School',
      issueYear: '2026',
      issueMonth: '3',
      certUrl: CERT_URL,
    });
  });

  it('reads the month in India time, not UTC', () => {
    // 20:00 UTC on 31 Jan is already 1 Feb in India.
    const url = new URL(
      linkedInAddUrl({
        name: 'A',
        organizationName: 'B',
        issuedAt: Date.UTC(2026, 0, 31, 20, 0),
        certUrl: CERT_URL,
      }),
    );
    expect(url.searchParams.get('issueMonth')).toBe('2');
    expect(url.searchParams.get('issueYear')).toBe('2026');
  });

  it('adds the expiry only when there is one', () => {
    const base = {
      name: 'A',
      organizationName: 'B',
      issuedAt: Date.UTC(2026, 5, 1),
      certUrl: CERT_URL,
    };
    expect(
      new URL(linkedInAddUrl({ ...base, expiresAt: null })).searchParams.has('expirationYear'),
    ).toBe(false);
    const withExpiry = new URL(linkedInAddUrl({ ...base, expiresAt: Date.UTC(2028, 11, 10) }));
    expect(withExpiry.searchParams.get('expirationYear')).toBe('2028');
    expect(withExpiry.searchParams.get('expirationMonth')).toBe('12');
  });

  it('encodes awkward characters and trims over-long names', () => {
    const url = linkedInAddUrl({
      name: 'Merit & Honours "A+" ' + 'x'.repeat(200),
      organizationName: 'St. Mary’s / Co.',
      issuedAt: Date.UTC(2026, 5, 1),
      certUrl: CERT_URL,
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('name')!.length).toBe(100);
    expect(parsed.searchParams.get('name')!.startsWith('Merit & Honours "A+" ')).toBe(true);
    expect(parsed.searchParams.get('organizationName')).toBe('St. Mary’s / Co.');
    expect(url).not.toContain('"');
    expect(url).not.toMatch(/ /);
  });
});
