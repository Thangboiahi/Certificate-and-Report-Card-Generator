import { describe, expect, it } from 'vitest';

import {
  buildClaimCart,
  CartError,
  cartTotal,
  DEFAULT_ESCROW_HOLD_DAYS,
  DEFAULT_PLATFORM_FEE_BPS,
  MIN_TRANSFER_PAISE,
  PricingConfigError,
  pricingFromEnv,
  splitClaimCart,
  type PricingPolicy,
} from './pricing';

const POLICY: PricingPolicy = {
  platformFeeBps: 1_000,
  aiEnrichmentPaise: 4_900,
  escrowHoldDays: 7,
};
const base = (feePaise: number) => ({ feePaise, credentialName: 'Class 10 certificate' });

describe('pricingFromEnv', () => {
  it('defaults: 10 % platform fee, AI add-on not offered, 7-day escrow hold', () => {
    expect(pricingFromEnv({})).toEqual({
      platformFeeBps: DEFAULT_PLATFORM_FEE_BPS,
      aiEnrichmentPaise: null,
      escrowHoldDays: DEFAULT_ESCROW_HOLD_DAYS,
    });
    expect(DEFAULT_PLATFORM_FEE_BPS).toBe(1_000);
  });

  it('reads overrides', () => {
    expect(
      pricingFromEnv({
        PLATFORM_FEE_BPS: '250',
        AI_ENRICHMENT_FEE_PAISE: '4900',
        ESCROW_HOLD_DAYS: '0',
      }),
    ).toEqual({ platformFeeBps: 250, aiEnrichmentPaise: 4_900, escrowHoldDays: 0 });
  });

  it('refuses malformed or out-of-range values instead of charging something else', () => {
    for (const env of [
      { PLATFORM_FEE_BPS: '10%' },
      { PLATFORM_FEE_BPS: '5001' },
      { PLATFORM_FEE_BPS: '-1' },
      { PLATFORM_FEE_BPS: '1e3' },
      { AI_ENRICHMENT_FEE_PAISE: '49.00' },
      { AI_ENRICHMENT_FEE_PAISE: '99' },
      { AI_ENRICHMENT_FEE_PAISE: '100001' },
      { ESCROW_HOLD_DAYS: '31' },
    ]) {
      expect(() => pricingFromEnv(env)).toThrow(PricingConfigError);
    }
  });
});

describe('buildClaimCart', () => {
  it('is the Base Fee alone, or the Base Fee plus the AI add-on', () => {
    expect(buildClaimCart(base(10_000), [], POLICY)).toEqual([
      { kind: 'base', label: 'Class 10 certificate', amountPaise: 10_000 },
    ]);
    const cart = buildClaimCart(base(10_000), ['ai_enrichment'], POLICY);
    expect(cart).toEqual([
      { kind: 'base', label: 'Class 10 certificate', amountPaise: 10_000 },
      { kind: 'ai_enrichment', label: 'AI enrichment', amountPaise: 4_900 },
    ]);
    expect(cartTotal(cart)).toBe(14_900);
  });

  it('refuses an add-on that is not offered, twice the same add-on, and a missing fee', () => {
    expect(() =>
      buildClaimCart(base(10_000), ['ai_enrichment'], { ...POLICY, aiEnrichmentPaise: null }),
    ).toThrow(expect.objectContaining({ code: 'ADD_ON_UNAVAILABLE' }));
    expect(() => buildClaimCart(base(10_000), ['ai_enrichment', 'ai_enrichment'], POLICY)).toThrow(
      CartError,
    );
    expect(() => buildClaimCart(base(0), [], POLICY)).toThrow(CartError);
    expect(() => buildClaimCart(base(99), [], POLICY)).toThrow(CartError);
    expect(() => buildClaimCart(base(150.5), [], POLICY)).toThrow(CartError);
  });
});

describe('splitClaimCart', () => {
  it('sends the Base Fee minus the platform fee to the issuer; add-ons stay with the platform', () => {
    expect(splitClaimCart(buildClaimCart(base(10_000), [], POLICY), POLICY)).toEqual({
      platformPaise: 1_000,
      issuerPaise: 9_000,
    });
    expect(splitClaimCart(buildClaimCart(base(10_000), ['ai_enrichment'], POLICY), POLICY)).toEqual(
      { platformPaise: 5_900, issuerPaise: 9_000 },
    );
  });

  it('rounds the platform fee to the nearest paisa', () => {
    expect(splitClaimCart(buildClaimCart(base(12_345), [], POLICY), POLICY)).toEqual({
      platformPaise: 1_235,
      issuerPaise: 11_110,
    });
  });

  it('never lets the issuer transfer fall below Razorpay’s ₹1 minimum', () => {
    expect(splitClaimCart(buildClaimCart(base(100), [], POLICY), POLICY)).toEqual({
      platformPaise: 0,
      issuerPaise: 100,
    });
    expect(splitClaimCart(buildClaimCart(base(105), [], POLICY), POLICY)).toEqual({
      platformPaise: 5,
      issuerPaise: 100,
    });
  });

  it('holds its invariants for every fee and policy', () => {
    for (const bps of [0, 1, 250, 1_000, 3_333, 5_000]) {
      const policy = { ...POLICY, platformFeeBps: bps };
      for (let fee = 100; fee <= 1_000_000; fee = Math.ceil(fee * 1.37) + 1) {
        for (const addOns of [[], ['ai_enrichment']] as const) {
          const cart = buildClaimCart(base(fee), addOns, policy);
          const split = splitClaimCart(cart, policy);
          expect(split.platformPaise + split.issuerPaise).toBe(cartTotal(cart));
          expect(split.issuerPaise).toBeGreaterThanOrEqual(MIN_TRANSFER_PAISE);
          expect(split.issuerPaise).toBeLessThanOrEqual(fee);
          expect(split.platformPaise).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(split.platformPaise)).toBe(true);
          // The issuer keeps at least (100 % − fee rate) of the Base Fee, give or take a paisa.
          expect(split.issuerPaise).toBeGreaterThanOrEqual(
            Math.floor((fee * (10_000 - bps)) / 10_000),
          );
        }
      }
    }
  });

  it('refuses a cart without exactly one Base Fee', () => {
    expect(() => splitClaimCart([], POLICY)).toThrow(CartError);
    expect(() =>
      splitClaimCart([{ kind: 'ai_enrichment', label: 'AI', amountPaise: 4_900 }], POLICY),
    ).toThrow(CartError);
  });
});
