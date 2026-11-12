/**
 * Pay-to-claim checkout records (Phase 8, ADR-028). Server-only in the Firestore rules.
 *
 *   claim_orders/{razorpayOrderId}   one per checkout: the cart, how it is split between the
 *                                    platform and the issuer's Route Linked Account, and what
 *                                    became of the payment (escrow ledger)
 */
import type { IssuerType, TimestampLike } from './roles';

/** Optional extras a recipient can add to the cart. */
export const CLAIM_ADD_ONS = ['ai_enrichment'] as const;
export type ClaimAddOn = (typeof CLAIM_ADD_ONS)[number];

export type CartLineKind = 'base' | ClaimAddOn;

/** One line of the cart, priced by the server. */
export interface CartLine {
  kind: CartLineKind;
  label: string;
  amountPaise: number;
}

/** How a cart's total is divided. `platformPaise + issuerPaise` = the total. */
export interface CartSplit {
  /** Stays in the platform's (main) Razorpay account: platform fee + add-ons. */
  platformPaise: number;
  /** Transferred to the issuer's Linked Account (Route), held in escrow until `holdUntil`. */
  issuerPaise: number;
}

/**
 * `created`    order open; nobody has paid yet (or Razorpay has not told us)
 * `paid`       captured, credential minted into the payer's vault, token consumed
 * `refund_due` captured but cannot be honoured (see `refund.reason`); refund not confirmed yet
 * `refunded`   refunded to the payer, with the issuer's transfer reversed
 */
export type ClaimOrderStatus = 'created' | 'paid' | 'refund_due' | 'refunded';

export type RefundReason =
  /** The same person had already claimed it (paid twice, e.g. two tabs). */
  | 'already_claimed'
  /** Someone else claimed it first. */
  | 'claimed_by_other'
  /** The claim link was purged before the payment arrived. */
  | 'token_gone'
  /** Razorpay reported a different amount or currency than the order (should never happen). */
  | 'amount_mismatch'
  /** A second captured payment on an order that was already settled. */
  | 'duplicate_payment';

export interface ClaimOrderRefund {
  reason: RefundReason;
  paymentId: string;
  /** What is refunded: the amount Razorpay actually captured (may differ from the order). */
  amount: number;
  /** `null` while outstanding, or when the refund was confirmed only by the payment's record. */
  refundId: string | null;
  requestedAt: TimestampLike;
  refundedAt: TimestampLike | null;
  /** Last failure to refund, for the operator. */
  lastError: string | null;
}

export type SettledBy = 'webhook' | 'reconcile';

export interface ClaimOrderDocument {
  /** `claim_tokens` id (the token's SHA-256); also the id of the vault item it mints. */
  tokenId: string;
  batchId: string;
  /** Who is paying (and whose vault receives the credential). */
  uid: string;
  issuerType: IssuerType;
  /** Institution id (or a Micro-Issuer's uid, once they can take payments). */
  issuerId: string;
  /** Display names at checkout time, copied onto the vault item when it is minted. */
  issuerName: string;
  credentialName: string;
  addOns: ClaimAddOn[];
  cart: CartLine[];
  /** Total in paise (= sum of the cart = the Razorpay order amount). */
  amount: number;
  currency: 'INR';
  split: CartSplit & {
    /** The issuer's Razorpay Linked Account. */
    account: string;
    /** End of the escrow hold on the issuer's transfer; `null` = released on Razorpay's schedule. */
    holdUntil: TimestampLike | null;
  };
  status: ClaimOrderStatus;
  /** The payment that settled (or must be refunded for) this order. */
  paymentId: string | null;
  createdAt: TimestampLike;
  paidAt: TimestampLike | null;
  settledBy: SettledBy | null;
  refund: ClaimOrderRefund | null;
  /**
   * Further captured payments on an order that was already settled (Razorpay can capture a late
   * second attempt). Each is refunded; keyed by payment id.
   */
  strayPayments?: Record<string, StrayPayment>;
  /** True while any refund of this order is outstanding: the reconciliation sweep's queue. */
  refundPending: boolean;
  /** Throttles pull reconciliation (status polls and the sweep). */
  lastReconciledAt?: TimestampLike | null;
}

export interface StrayPayment {
  amount: number;
  refunded: boolean;
  /** `null` while outstanding, or when the refund was confirmed only by the payment's record. */
  refundId: string | null;
  lastError: string | null;
}

/** What the browser learns about its own checkout. */
export interface CheckoutStatus {
  orderId: string;
  status: ClaimOrderStatus;
  /** Set once paid: the new vault item. */
  vaultItemId: string | null;
  refundReason: RefundReason | null;
}
