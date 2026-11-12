/**
 * Prices a pay-to-claim cart and splits it between the platform and the issuer (ADR-028). Pure:
 * no I/O, shared by the server (which decides) and the claim page (which shows the total).
 *
 *   cart  = Base Fee (the issuer's claim fee)  +  optional add-ons (AI enrichment)
 *   split = issuer:   Base Fee − platform fee   → Route transfer to the issuer's Linked Account
 *           platform: platform fee + add-ons    → stays in the main account
 *
 * Every price here is a PLACEHOLDER until pricing is decided (PLAN E12).
 */
import { CLAIM_ADD_ONS, type CartLine, type CartSplit, type ClaimAddOn } from '@/types/payments';

/** Razorpay's smallest order and transfer: ₹1. */
export const MIN_TRANSFER_PAISE = 100;

/** Platform fee on the Base Fee, in basis points (1,000 = 10 %). Placeholder (E12). */
export const DEFAULT_PLATFORM_FEE_BPS = 1_000;
/** Most the platform may take of the Base Fee (50 %), so a typo cannot swallow issuers' money. */
export const MAX_PLATFORM_FEE_BPS = 5_000;
/**
 * Days the issuer's share stays on hold in Razorpay before it settles to their bank (escrow):
 * time to refund a payment that could not be honoured and reverse the transfer. Placeholder.
 */
export const DEFAULT_ESCROW_HOLD_DAYS = 7;
export const MAX_ESCROW_HOLD_DAYS = 30;
/** Bounds on the AI add-on's price when it is switched on. */
export const MIN_ADD_ON_PAISE = 100;
export const MAX_ADD_ON_PAISE = 100_000;

export interface PricingPolicy {
  platformFeeBps: number;
  /** Price of the AI enrichment add-on; `null` = not offered. */
  aiEnrichmentPaise: number | null;
  escrowHoldDays: number;
}

export class PricingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingConfigError';
  }
}

export class CartError extends Error {
  constructor(
    readonly code: 'ADD_ON_UNAVAILABLE' | 'INVALID_CART',
    message: string,
  ) {
    super(message);
    this.name = 'CartError';
  }
}

function integerFromEnv(
  env: Record<string, string | undefined>,
  name: string,
  { min, max }: { min: number; max: number },
): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new PricingConfigError(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

/**
 * The pricing in force. `PLATFORM_FEE_BPS`, `AI_ENRICHMENT_FEE_PAISE` (unset = add-on not
 * offered) and `ESCROW_HOLD_DAYS` override the defaults; a malformed value throws rather than
 * silently charging something else.
 */
export function pricingFromEnv(
  env: Record<string, string | undefined> = process.env,
): PricingPolicy {
  return {
    platformFeeBps:
      integerFromEnv(env, 'PLATFORM_FEE_BPS', { min: 0, max: MAX_PLATFORM_FEE_BPS }) ??
      DEFAULT_PLATFORM_FEE_BPS,
    aiEnrichmentPaise:
      integerFromEnv(env, 'AI_ENRICHMENT_FEE_PAISE', {
        min: MIN_ADD_ON_PAISE,
        max: MAX_ADD_ON_PAISE,
      }) ?? null,
    escrowHoldDays:
      integerFromEnv(env, 'ESCROW_HOLD_DAYS', { min: 0, max: MAX_ESCROW_HOLD_DAYS }) ??
      DEFAULT_ESCROW_HOLD_DAYS,
  };
}

export const ADD_ON_LABELS: Record<ClaimAddOn, string> = {
  ai_enrichment: 'AI enrichment',
};

export function isClaimAddOn(value: unknown): value is ClaimAddOn {
  return (CLAIM_ADD_ONS as readonly unknown[]).includes(value);
}

/** Price of an add-on under `policy`, or `null` when it is not offered. */
export function addOnPrice(addOn: ClaimAddOn, policy: PricingPolicy): number | null {
  switch (addOn) {
    case 'ai_enrichment':
      return policy.aiEnrichmentPaise;
  }
}

/**
 * The cart for claiming one credential. `addOns` must be distinct and offered; the Base Fee
 * comes from the claim token, never from the request.
 */
export function buildClaimCart(
  base: { feePaise: number; credentialName: string },
  addOns: readonly ClaimAddOn[],
  policy: PricingPolicy,
): CartLine[] {
  if (!Number.isSafeInteger(base.feePaise) || base.feePaise < MIN_TRANSFER_PAISE) {
    throw new CartError('INVALID_CART', 'This credential has no claim fee to pay.');
  }
  if (new Set(addOns).size !== addOns.length) {
    throw new CartError('INVALID_CART', 'Each add-on can be chosen once.');
  }
  const cart: CartLine[] = [
    {
      kind: 'base',
      label: base.credentialName.slice(0, 120) || 'Credential',
      amountPaise: base.feePaise,
    },
  ];
  for (const addOn of addOns) {
    const price = addOnPrice(addOn, policy);
    if (price === null) {
      throw new CartError('ADD_ON_UNAVAILABLE', `${ADD_ON_LABELS[addOn]} is not available.`);
    }
    cart.push({ kind: addOn, label: ADD_ON_LABELS[addOn], amountPaise: price });
  }
  return cart;
}

export function cartTotal(cart: readonly CartLine[]): number {
  return cart.reduce((sum, line) => sum + line.amountPaise, 0);
}

/**
 * Splits a cart. The platform fee is `platformFeeBps` of the Base Fee (rounded to the nearest
 * paisa), lowered if needed so the issuer's transfer is never below Razorpay's ₹1 minimum.
 * Add-ons are the platform's alone.
 */
export function splitClaimCart(cart: readonly CartLine[], policy: PricingPolicy): CartSplit {
  const base = cart.filter((line) => line.kind === 'base');
  if (base.length !== 1 || base[0]!.amountPaise < MIN_TRANSFER_PAISE) {
    throw new CartError('INVALID_CART', 'A cart has exactly one Base Fee of at least ₹1.');
  }
  const baseFee = base[0]!.amountPaise;
  const platformFee = Math.min(
    Math.round((baseFee * policy.platformFeeBps) / 10_000),
    baseFee - MIN_TRANSFER_PAISE,
  );
  const issuerPaise = baseFee - platformFee;
  return { platformPaise: cartTotal(cart) - issuerPaise, issuerPaise };
}
