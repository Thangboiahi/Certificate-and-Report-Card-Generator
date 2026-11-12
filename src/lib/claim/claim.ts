/**
 * Claiming a credential through its link (ADR-027, payments ADR-028):
 *
 *   1. The person signs in passwordlessly with the SAME contact the link was sent to (email link
 *      or phone OTP) — so a forwarded link is useless to anyone else.
 *   2. Free credential → `claimCredential` moves it into their vault at once.
 *      Paid credential → `src/lib/payments/escrow.ts`: a Razorpay order whose capture (webhook,
 *      or pull reconciliation) mints the vault item. Nothing here takes a payment.
 *
 * Both paths mint through `mintVaultItem`, inside a transaction that marks the token claimed,
 * creates `vault_items/{tokenId}` and counts the claim on the batch. Claiming twice is harmless:
 * the second call returns the same vault item.
 */
import 'server-only';

import {
  FieldValue,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';

import { isRazorpayId } from '@/lib/razorpayClient';
import { hashClaimToken, isTokenExpired } from '@/lib/utils/tokenManager';
import type { ClaimTokenDocument, IssuedBatchDocument } from '@/types/audit';
import type { ClaimAddOn } from '@/types/payments';
import {
  COLLECTIONS,
  type InstitutionDocument,
  type SessionUser,
  type VaultItemDocument,
} from '@/types/roles';

import { contactMatches, maskContact, type ContactChannel } from './contact';

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{16,128}$/;

/** Stored claim-token fields beyond the Phase 6 schema. */
export type StoredClaimToken = ClaimTokenDocument & {
  /** Claim fee (the cart's Base Fee) in paise; 0 or absent = free. */
  feePaise?: number;
  claimedByUid?: string;
  /** The Razorpay order that paid for it (paid claims only). */
  orderId?: string;
};

export type ClaimErrorCode =
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'ALREADY_CLAIMED'
  | 'CONTACT_MISMATCH'
  | 'PAYMENT_REQUIRED'
  | 'NOT_PAYABLE'
  | 'ISSUER_NOT_PAYABLE'
  | 'ADD_ON_UNAVAILABLE'
  | 'PAYMENTS_NOT_CONFIGURED';

export const CLAIM_ERROR_STATUS: Record<ClaimErrorCode, number> = {
  NOT_FOUND: 404,
  EXPIRED: 410,
  ALREADY_CLAIMED: 409,
  CONTACT_MISMATCH: 403,
  PAYMENT_REQUIRED: 402,
  NOT_PAYABLE: 409,
  ISSUER_NOT_PAYABLE: 409,
  ADD_ON_UNAVAILABLE: 400,
  PAYMENTS_NOT_CONFIGURED: 503,
};

export class ClaimError extends Error {
  constructor(
    readonly code: ClaimErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ClaimError';
  }
}

/** What the claim page shows. Contains no contact details beyond a masked hint. */
export interface ClaimView {
  status: 'valid' | 'expired' | 'claimed' | 'not_found';
  credentialName?: string;
  issuerName?: string;
  channel?: ContactChannel;
  maskedContact?: string;
  feePaise?: number;
  /** For a fee: whether the issuer can receive payments (has a Razorpay Linked Account). */
  payable?: boolean;
  expiresAt?: number;
  /** For a signed-in visitor: whether their account matches the contact. */
  matchesUser?: boolean;
  /** Only when the matching user is signed in. */
  recipientName?: string;
  /** Set when the signed-in user has already claimed it. */
  claimedByUser?: boolean;
}

/** The issuer behind a token, as payments and the claim page need it. */
export interface ClaimIssuer {
  name: string;
  /** Route Linked Account (`acc_…`) that receives the issuer's share, or `null`. */
  payoutAccount: string | null;
}

export interface LoadedClaim {
  tokenId: string;
  token: StoredClaimToken;
  batch: IssuedBatchDocument | undefined;
  issuer: ClaimIssuer;
}

async function issuerFor(db: Firestore, token: StoredClaimToken): Promise<ClaimIssuer> {
  // Micro-Issuers cannot dispatch yet (ADR-024), so every token has an institution today.
  if (!token.institutionId) return { name: 'Your issuer', payoutAccount: null };
  const snap = await db.collection(COLLECTIONS.institutions).doc(token.institutionId).get();
  const institution = snap.data() as InstitutionDocument | undefined;
  return {
    name: institution?.name ?? 'Your issuer',
    payoutAccount: isRazorpayId('account', institution?.razorpayAccountId)
      ? institution.razorpayAccountId
      : null,
  };
}

/** Finds a raw token's record, its batch and its issuer; `null` for an unknown token. */
export async function loadClaim(db: Firestore, rawToken: string): Promise<LoadedClaim | null> {
  if (!TOKEN_FORMAT.test(rawToken)) return null;
  const tokenId = await hashClaimToken(rawToken);
  const snap = await db.collection(COLLECTIONS.claimTokens).doc(tokenId).get();
  if (!snap.exists) return null;
  const token = snap.data() as StoredClaimToken;
  const [batchSnap, issuer] = await Promise.all([
    db.collection(COLLECTIONS.issuedBatches).doc(token.batchId).get(),
    issuerFor(db, token),
  ]);
  return {
    tokenId,
    token,
    batch: batchSnap.data() as IssuedBatchDocument | undefined,
    issuer,
  };
}

export const credentialNameOf = (loaded: Pick<LoadedClaim, 'batch'>) =>
  loaded.batch?.templateName ?? 'Credential';

/** Everything the public claim page needs, for a visitor who may or may not be signed in. */
export async function loadClaimView(
  db: Firestore,
  rawToken: string,
  user: SessionUser | null,
  now = Date.now(),
): Promise<ClaimView> {
  const loaded = await loadClaim(db, rawToken);
  if (!loaded) return { status: 'not_found' };
  const { token, issuer } = loaded;
  const matches = user ? contactMatches(token.channel, token.contact, user) : undefined;
  const fee = token.feePaise ?? 0;
  const view: ClaimView = {
    status: token.claimedAt
      ? 'claimed'
      : isTokenExpired(token.expiresAt, now)
        ? 'expired'
        : 'valid',
    credentialName: credentialNameOf(loaded),
    issuerName: issuer.name,
    channel: token.channel,
    maskedContact: maskContact(token.channel, token.contact),
    feePaise: fee,
    payable: fee > 0 && issuer.payoutAccount !== null,
    expiresAt: token.expiresAt.toMillis(),
    matchesUser: matches,
    claimedByUser: Boolean(user && token.claimedByUid === user.uid),
  };
  if (matches) view.recipientName = token.recipientName;
  return view;
}

/**
 * Refuses a claim (or a checkout) by anyone but the person the link was sent to, and for
 * expired links or ones someone else claimed. A link the same user already claimed passes.
 */
export function checkClaimable(
  loaded: LoadedClaim | null,
  user: SessionUser,
  now: number,
): LoadedClaim {
  if (!loaded) throw new ClaimError('NOT_FOUND', 'This claim link is not valid.');
  const { token } = loaded;
  if (token.claimedAt && token.claimedByUid !== user.uid) {
    throw new ClaimError('ALREADY_CLAIMED', 'This credential has already been claimed.');
  }
  if (!token.claimedAt && isTokenExpired(token.expiresAt, now)) {
    throw new ClaimError('EXPIRED', 'This claim link has expired. Ask the issuer for a new one.');
  }
  if (!contactMatches(token.channel, token.contact, user)) {
    throw new ClaimError(
      'CONTACT_MISMATCH',
      `Sign in with the ${token.channel === 'whatsapp' ? 'number' : 'email address'} this link was sent to (${maskContact(token.channel, token.contact)}).`,
    );
  }
  return loaded;
}

/**
 * Inside a transaction: creates `vault_items/{tokenId}` for `ownerUid`, marks the token
 * claimed and counts the claim on its batch. The caller has read `batchSnap` in the same
 * transaction and checked the token is unclaimed.
 */
export function mintVaultItem(
  transaction: Transaction,
  input: {
    db: Firestore;
    tokenId: string;
    token: StoredClaimToken;
    batchSnap: DocumentSnapshot;
    ownerUid: string;
    issuerName: string;
    payment?: { orderId: string; paymentId: string; addOns: ClaimAddOn[] };
  },
): DocumentReference {
  const { db, tokenId, token, batchSnap, payment } = input;
  const batch = batchSnap.data() as IssuedBatchDocument | undefined;
  const itemRef = db.collection(COLLECTIONS.vaultItems).doc(tokenId);
  transaction.create(itemRef, {
    ownerUid: input.ownerUid,
    templateId: batch?.templateId ?? 'unknown',
    issuerId: token.institutionId ?? token.issuerUid,
    issuerType: token.institutionId ? 'institution' : 'individual',
    issuedAt: FieldValue.serverTimestamp(),
    expiresAt: null,
    status: 'valid',
    revokedAt: null,
    credentialName: batch?.templateName ?? 'Credential',
    issuerName: input.issuerName,
    recipientName: token.recipientName,
    batchId: token.batchId,
    shareId: null,
    ...(payment
      ? { orderId: payment.orderId, paymentId: payment.paymentId, addOns: payment.addOns }
      : {}),
  } as unknown as VaultItemDocument);
  transaction.update(db.collection(COLLECTIONS.claimTokens).doc(tokenId), {
    claimedAt: FieldValue.serverTimestamp(),
    claimedByUid: input.ownerUid,
    ...(payment ? { orderId: payment.orderId } : {}),
  });
  if (batchSnap.exists) {
    transaction.update(batchSnap.ref, { claimedCount: FieldValue.increment(1) });
  }
  return itemRef;
}

export interface ClaimResult {
  vaultItemId: string;
  /** True when this user had already claimed it (nothing changed). */
  alreadyClaimed: boolean;
}

/** Claims a FREE credential. A credential with a fee goes through checkout instead. */
export async function claimCredential(input: {
  db: Firestore;
  user: SessionUser;
  rawToken: string;
  now?: number;
}): Promise<ClaimResult> {
  const { db, user } = input;
  const now = input.now ?? Date.now();
  const loaded = checkClaimable(await loadClaim(db, input.rawToken), user, now);
  const { tokenId } = loaded;
  if (loaded.token.claimedAt) return { vaultItemId: tokenId, alreadyClaimed: true };
  if ((loaded.token.feePaise ?? 0) > 0) {
    throw new ClaimError('PAYMENT_REQUIRED', 'This credential has a fee. Pay to claim it.');
  }

  const tokenRef = db.collection(COLLECTIONS.claimTokens).doc(tokenId);
  const batchRef = db.collection(COLLECTIONS.issuedBatches).doc(loaded.token.batchId);
  return db.runTransaction(async (transaction) => {
    const [tokenSnap, batchSnap] = (await transaction.getAll(tokenRef, batchRef)) as [
      DocumentSnapshot,
      DocumentSnapshot,
    ];
    const token = tokenSnap.data() as StoredClaimToken | undefined;
    if (!token) throw new ClaimError('NOT_FOUND', 'This claim link is not valid.');
    if (token.claimedAt) {
      if (token.claimedByUid === user.uid) return { vaultItemId: tokenId, alreadyClaimed: true };
      throw new ClaimError('ALREADY_CLAIMED', 'This credential has already been claimed.');
    }
    if (isTokenExpired(token.expiresAt, now)) {
      throw new ClaimError('EXPIRED', 'This claim link has expired. Ask the issuer for a new one.');
    }
    if ((token.feePaise ?? 0) > 0) {
      throw new ClaimError('PAYMENT_REQUIRED', 'This credential has a fee. Pay to claim it.');
    }
    mintVaultItem(transaction, {
      db,
      tokenId,
      token,
      batchSnap,
      ownerUid: user.uid,
      issuerName: loaded.issuer.name,
    });
    return { vaultItemId: tokenId, alreadyClaimed: false };
  });
}
