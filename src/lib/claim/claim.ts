/**
 * Claiming a credential through its link (ADR-027):
 *
 *   1. The person signs in passwordlessly with the SAME contact the link was sent to (email link
 *      or phone OTP) — so a forwarded link is useless to anyone else.
 *   2. Free credential → `claimCredential` moves it into their vault at once.
 *      Paid credential → `createClaimOrder` opens a Razorpay order; after Checkout,
 *      `claimCredential` verifies the payment signature and the order, then claims.
 *
 * One transaction marks the token claimed, creates `vault_items/{tokenId}` and counts the claim on
 * the batch. Claiming twice is harmless: the second call returns the same vault item.
 */
import 'server-only';

import { FieldValue, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';

import { hashClaimToken, isTokenExpired } from '@/lib/utils/tokenManager';
import type { ClaimTokenDocument, IssuedBatchDocument } from '@/types/audit';
import { COLLECTIONS, type SessionUser, type VaultItemDocument } from '@/types/roles';

import { contactMatches, maskContact, type ContactChannel } from './contact';
import { createRazorpayOrder, verifyPaymentSignature, type RazorpayConfig } from './razorpay';

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{16,128}$/;

/** Stored claim-token fields beyond the Phase 6 schema. */
export type StoredClaimToken = ClaimTokenDocument & {
  /** Claim fee in paise; 0 or absent = free. */
  feePaise?: number;
  claimedByUid?: string;
};

export type ClaimErrorCode =
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'ALREADY_CLAIMED'
  | 'CONTACT_MISMATCH'
  | 'PAYMENT_REQUIRED'
  | 'PAYMENT_INVALID'
  | 'NOT_PAYABLE'
  | 'PAYMENTS_NOT_CONFIGURED';

export const CLAIM_ERROR_STATUS: Record<ClaimErrorCode, number> = {
  NOT_FOUND: 404,
  EXPIRED: 410,
  ALREADY_CLAIMED: 409,
  CONTACT_MISMATCH: 403,
  PAYMENT_REQUIRED: 402,
  PAYMENT_INVALID: 402,
  NOT_PAYABLE: 409,
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
  expiresAt?: number;
  /** For a signed-in visitor: whether their account matches the contact. */
  matchesUser?: boolean;
  /** Only when the matching user is signed in. */
  recipientName?: string;
  /** Set when the signed-in user has already claimed it. */
  claimedByUser?: boolean;
}

interface Loaded {
  tokenId: string;
  token: StoredClaimToken;
  batch: IssuedBatchDocument | undefined;
  issuerName: string;
}

async function issuerNameFor(db: Firestore, token: StoredClaimToken): Promise<string> {
  if (!token.institutionId) return 'Your issuer';
  const snap = await db.collection(COLLECTIONS.institutions).doc(token.institutionId).get();
  return (snap.get('name') as string | undefined) ?? 'Your issuer';
}

async function load(db: Firestore, rawToken: string): Promise<Loaded | null> {
  if (!TOKEN_FORMAT.test(rawToken)) return null;
  const tokenId = await hashClaimToken(rawToken);
  const snap = await db.collection(COLLECTIONS.claimTokens).doc(tokenId).get();
  if (!snap.exists) return null;
  const token = snap.data() as StoredClaimToken;
  const batchSnap = await db.collection(COLLECTIONS.issuedBatches).doc(token.batchId).get();
  return {
    tokenId,
    token,
    batch: batchSnap.data() as IssuedBatchDocument | undefined,
    issuerName: await issuerNameFor(db, token),
  };
}

/** Everything the public claim page needs, for a visitor who may or may not be signed in. */
export async function loadClaimView(
  db: Firestore,
  rawToken: string,
  user: SessionUser | null,
  now = Date.now(),
): Promise<ClaimView> {
  const loaded = await load(db, rawToken);
  if (!loaded) return { status: 'not_found' };
  const { token, batch, issuerName } = loaded;
  const matches = user ? contactMatches(token.channel, token.contact, user) : undefined;
  const base: ClaimView = {
    status: token.claimedAt
      ? 'claimed'
      : isTokenExpired(token.expiresAt, now)
        ? 'expired'
        : 'valid',
    credentialName: batch?.templateName ?? 'Credential',
    issuerName,
    channel: token.channel,
    maskedContact: maskContact(token.channel, token.contact),
    feePaise: token.feePaise ?? 0,
    expiresAt: token.expiresAt.toMillis(),
    matchesUser: matches,
    claimedByUser: Boolean(user && token.claimedByUid === user.uid),
  };
  if (matches) base.recipientName = token.recipientName;
  return base;
}

function checkClaimable(loaded: Loaded | null, user: SessionUser, now: number): Loaded {
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

export interface ClaimOrder {
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
  issuerName: string;
  credentialName: string;
}

/** Opens a Razorpay order for a paid credential. Only the matching recipient may. */
export async function createClaimOrder(input: {
  db: Firestore;
  user: SessionUser;
  rawToken: string;
  razorpay: RazorpayConfig | null;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<ClaimOrder> {
  const { db, user, razorpay } = input;
  const loaded = checkClaimable(await load(db, input.rawToken), user, input.now ?? Date.now());
  const fee = loaded.token.feePaise ?? 0;
  if (fee <= 0 || loaded.token.claimedAt) {
    throw new ClaimError('NOT_PAYABLE', 'Nothing to pay for this credential.');
  }
  if (!razorpay) {
    throw new ClaimError('PAYMENTS_NOT_CONFIGURED', 'Payments are not available right now.');
  }
  const order = await createRazorpayOrder(
    razorpay,
    {
      amount: fee,
      receipt: `claim-${loaded.tokenId.slice(0, 32)}`,
      notes: { tokenId: loaded.tokenId, uid: user.uid },
    },
    input.fetchImpl,
  );
  await db.collection(COLLECTIONS.claimOrders).doc(order.id).set({
    tokenId: loaded.tokenId,
    uid: user.uid,
    amount: order.amount,
    currency: order.currency,
    status: 'created',
    paymentId: null,
    createdAt: FieldValue.serverTimestamp(),
  });
  return {
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    keyId: razorpay.keyId,
    issuerName: loaded.issuerName,
    credentialName: loaded.batch?.templateName ?? 'Credential',
  };
}

export interface PaymentProof {
  orderId: string;
  paymentId: string;
  signature: string;
}

export interface ClaimResult {
  vaultItemId: string;
  /** True when this user had already claimed it (nothing changed). */
  alreadyClaimed: boolean;
}

export async function claimCredential(input: {
  db: Firestore;
  user: SessionUser;
  rawToken: string;
  payment?: PaymentProof;
  razorpay: RazorpayConfig | null;
  now?: number;
}): Promise<ClaimResult> {
  const { db, user, payment } = input;
  const now = input.now ?? Date.now();
  const loaded = checkClaimable(await load(db, input.rawToken), user, now);
  const { tokenId } = loaded;
  if (loaded.token.claimedAt) return { vaultItemId: tokenId, alreadyClaimed: true };

  const fee = loaded.token.feePaise ?? 0;
  if (fee > 0) {
    if (!payment) throw new ClaimError('PAYMENT_REQUIRED', 'This credential has a fee.');
    if (!input.razorpay) {
      throw new ClaimError('PAYMENTS_NOT_CONFIGURED', 'Payments are not available right now.');
    }
    const valid = verifyPaymentSignature(
      input.razorpay.keySecret,
      payment.orderId,
      payment.paymentId,
      payment.signature,
    );
    if (!valid) throw new ClaimError('PAYMENT_INVALID', 'The payment could not be verified.');
  }

  const tokenRef = db.collection(COLLECTIONS.claimTokens).doc(tokenId);
  const batchRef = db.collection(COLLECTIONS.issuedBatches).doc(loaded.token.batchId);
  const itemRef = db.collection(COLLECTIONS.vaultItems).doc(tokenId);
  const orderRef = payment ? db.collection(COLLECTIONS.claimOrders).doc(payment.orderId) : null;

  return db.runTransaction(async (transaction) => {
    const reads = [tokenRef, batchRef, ...(orderRef ? [orderRef] : [])];
    const [tokenSnap, batchSnap, orderSnap] = (await transaction.getAll(...reads)) as [
      DocumentSnapshot,
      DocumentSnapshot,
      DocumentSnapshot | undefined,
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
    if (fee > 0) {
      const order = orderSnap?.data();
      if (
        !order ||
        order.tokenId !== tokenId ||
        order.uid !== user.uid ||
        order.amount !== fee ||
        order.status !== 'created'
      ) {
        throw new ClaimError('PAYMENT_INVALID', 'The payment does not match this credential.');
      }
      transaction.update(orderRef!, {
        status: 'paid',
        paymentId: payment!.paymentId,
        paidAt: FieldValue.serverTimestamp(),
      });
    }
    const batch = batchSnap.data() as IssuedBatchDocument | undefined;
    transaction.create(itemRef, {
      ownerUid: user.uid,
      templateId: batch?.templateId ?? 'unknown',
      issuerId: token.institutionId ?? token.issuerUid,
      issuerType: token.institutionId ? 'institution' : 'individual',
      issuedAt: FieldValue.serverTimestamp(),
      expiresAt: null,
      status: 'valid',
      revokedAt: null,
      credentialName: batch?.templateName ?? 'Credential',
      issuerName: loaded.issuerName,
      recipientName: token.recipientName,
      batchId: token.batchId,
      shareId: null,
    } as unknown as VaultItemDocument);
    transaction.update(tokenRef, {
      claimedAt: FieldValue.serverTimestamp(),
      claimedByUid: user.uid,
    });
    if (batchSnap.exists) transaction.update(batchRef, { claimedCount: FieldValue.increment(1) });
    return { vaultItemId: tokenId, alreadyClaimed: false };
  });
}
