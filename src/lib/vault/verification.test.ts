import { describe, expect, it } from 'vitest';

import { verificationState } from './verification';

const NOW = Date.UTC(2026, 10, 12);

describe('verificationState', () => {
  it('is valid when it has not been revoked or expired', () => {
    expect(verificationState({ status: 'valid', expiresAt: null }, NOW)).toBe('valid');
    expect(verificationState({ status: 'valid', expiresAt: NOW + 1 }, NOW)).toBe('valid');
  });

  it('is expired once its date has passed', () => {
    expect(verificationState({ status: 'valid', expiresAt: NOW - 1 }, NOW)).toBe('expired');
  });

  it('is unclaimed for a pre-minted id nobody has claimed, unless revoked or expired', () => {
    expect(verificationState({ status: 'valid', expiresAt: null, claimed: false }, NOW)).toBe(
      'unclaimed',
    );
    expect(verificationState({ status: 'revoked', expiresAt: null, claimed: false }, NOW)).toBe(
      'revoked',
    );
    expect(verificationState({ status: 'valid', expiresAt: NOW - 1, claimed: false }, NOW)).toBe(
      'expired',
    );
    expect(verificationState({ status: 'valid', expiresAt: null, claimed: true }, NOW)).toBe(
      'valid',
    );
  });

  it('is revoked whatever its expiry says', () => {
    expect(verificationState({ status: 'revoked', expiresAt: null }, NOW)).toBe('revoked');
    expect(verificationState({ status: 'revoked', expiresAt: NOW - 1 }, NOW)).toBe('revoked');
  });
});
