/**
 * The recipient's vault (Phase 7, ADR-027): listing their credentials and sharing one through an
 * unguessable public verification link (`/verify/{shareId}`). Server-only (Admin SDK); every function
 * checks ownership itself.
 */
import 'server-only';

import type { Firestore } from 'firebase-admin/firestore';

import { mintClaimToken } from '@/lib/utils/tokenManager';
import {
  COLLECTIONS,
  type IssuerType,
  type SessionUser,
  type VaultItemSchema,
  type VaultItemStatus,
} from '@/types/roles';

/** A vault item as sent to the browser (times in epoch milliseconds). */
export interface VaultItemRow {
  id: string;
  credentialName: string;
  issuerName: string;
  issuerType: IssuerType;
  recipientName: string | null;
  status: VaultItemStatus;
  issuedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  shareId: string | null;
}

function toRow(id: string, item: Omit<VaultItemSchema, 'id'>): VaultItemRow {
  return {
    id,
    credentialName: item.credentialName ?? 'Credential',
    issuerName: item.issuerName ?? (item.issuerType === 'institution' ? 'Institution' : 'Issuer'),
    issuerType: item.issuerType,
    recipientName: item.recipientName ?? null,
    status: item.status,
    issuedAt: item.issuedAt?.toMillis() ?? 0,
    expiresAt: item.expiresAt?.toMillis() ?? null,
    revokedAt: item.revokedAt?.toMillis() ?? null,
    shareId: item.shareId ?? null,
  };
}

/** Every vault item owned by `uid`, newest first. */
export async function listVaultItems(db: Firestore, uid: string): Promise<VaultItemRow[]> {
  const snapshot = await db
    .collection(COLLECTIONS.vaultItems)
    .where('ownerUid', '==', uid)
    .orderBy('issuedAt', 'desc')
    .limit(200)
    .get();
  return snapshot.docs.map((doc) => toRow(doc.id, doc.data() as Omit<VaultItemSchema, 'id'>));
}

export class VaultError extends Error {
  constructor(
    readonly code: 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

/**
 * Turns public sharing of an item on (returns its share id, creating one if needed) or off
 * (removes it: old links stop working). Only the owner may.
 */
export async function setSharing(
  db: Firestore,
  user: SessionUser,
  itemId: string,
  enabled: boolean,
): Promise<{ shareId: string | null }> {
  const ref = db.collection(COLLECTIONS.vaultItems).doc(itemId);
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists || snap.get('ownerUid') !== user.uid) {
      throw new VaultError('NOT_FOUND', 'No such credential in your vault.');
    }
    const current = (snap.get('shareId') as string | null | undefined) ?? null;
    if (!enabled) {
      if (current !== null) transaction.update(ref, { shareId: null });
      return { shareId: null };
    }
    if (current) return { shareId: current };
    // 256 bits, base64url — the same generator as claim tokens.
    const shareId = mintClaimToken();
    transaction.update(ref, { shareId });
    return { shareId };
  });
}

/** What a public verification page shows. */
export interface SharedCredential {
  credentialName: string;
  issuerName: string;
  issuerType: IssuerType;
  /** True when the issuing institution's identity was checked by the platform. */
  issuerVerified: boolean;
  recipientName: string | null;
  status: VaultItemStatus;
  issuedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

/** Looks a shared credential up by its public id, or `null` (unknown or no longer shared). */
export async function findSharedCredential(
  db: Firestore,
  shareId: string,
): Promise<SharedCredential | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(shareId)) return null;
  const snapshot = await db
    .collection(COLLECTIONS.vaultItems)
    .where('shareId', '==', shareId)
    .limit(1)
    .get();
  const doc = snapshot.docs[0];
  if (!doc) return null;
  const item = doc.data() as Omit<VaultItemSchema, 'id'>;
  let issuerVerified = false;
  if (item.issuerType === 'institution') {
    const institution = await db.collection(COLLECTIONS.institutions).doc(item.issuerId).get();
    issuerVerified = institution.get('verified') === true;
  }
  const row = toRow(doc.id, item);
  return {
    credentialName: row.credentialName,
    issuerName: row.issuerName,
    issuerType: row.issuerType,
    issuerVerified,
    recipientName: row.recipientName,
    status: row.status,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}
