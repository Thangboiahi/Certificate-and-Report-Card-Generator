import { describe, expect, it } from 'vitest';

import {
  CLAIM_RETENTION_DAYS,
  MAX_REISSUES,
  REISSUE_COOLDOWN_MS,
  reissueBlock,
} from '@/types/audit';

import {
  daysUntilExpiry,
  hashClaimToken,
  isTokenExpired,
  mintClaimToken,
  purgeAfterFor,
} from './tokenManager';

const DAY = 86_400_000;

describe('tokenManager', () => {
  it('mints unique 256-bit base64url tokens', () => {
    const tokens = new Set(Array.from({ length: 1000 }, mintClaimToken));
    expect(tokens.size).toBe(1000);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes with SHA-256 (hex)', async () => {
    expect(await hashClaimToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('treats the expiry instant itself as expired', () => {
    const expiry = Date.parse('2026-12-31T18:30:00Z');
    expect(isTokenExpired(expiry, expiry - 1)).toBe(false);
    expect(isTokenExpired(expiry, expiry)).toBe(true);
    expect(isTokenExpired(new Date(expiry), expiry + 1)).toBe(true);
    expect(isTokenExpired({ seconds: 0, nanoseconds: 0, toMillis: () => expiry }, expiry - 1)).toBe(
      false,
    );
  });

  it('schedules the purge after the retention period', () => {
    expect(purgeAfterFor(0).getTime()).toBe(CLAIM_RETENTION_DAYS * DAY);
  });

  it('counts whole days left, rounding up', () => {
    expect(daysUntilExpiry(10 * DAY, 0)).toBe(10);
    expect(daysUntilExpiry(10 * DAY, 1)).toBe(10);
    expect(daysUntilExpiry(10 * DAY, 9 * DAY + 1)).toBe(1);
    expect(daysUntilExpiry(10 * DAY, 10 * DAY)).toBe(0);
  });
});

describe('reissueBlock', () => {
  const ok = {
    status: 'completed' as const,
    purgedAt: null,
    reissueCount: 0,
    lastReissuedAt: null,
  };
  it.each([
    [ok, null],
    [{ ...ok, purgedAt: 1 }, 'purged'],
    [{ ...ok, status: 'failed' as const }, 'failed'],
    [{ ...ok, reissueCount: MAX_REISSUES }, 'limit'],
    [{ ...ok, status: 'sending' as const }, 'busy'],
    [{ ...ok, status: 'reissuing' as const }, 'busy'],
    [{ ...ok, lastReissuedAt: 1_000_000 - REISSUE_COOLDOWN_MS + 1 }, 'cooldown'],
    [{ ...ok, lastReissuedAt: 1_000_000 - REISSUE_COOLDOWN_MS }, null],
  ])('%j → %s', (batch, expected) => {
    expect(reissueBlock(batch, 1_000_000)).toBe(expected);
  });
});
