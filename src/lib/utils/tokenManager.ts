/**
 * Claim tokens: minting, hashing, expiry checks and the sweep that purges expired ones (ADR-026).
 *
 * A claim link is `APP_ORIGIN/claim/{token}`. The token is 32 random bytes (base64url, 43
 * characters); Firestore stores only its SHA-256 as the document id of `claim_tokens/{hash}`.
 * Every token carries its batch's `expiresAt` and a `purgeAfter` date (`expiresAt` + retention);
 * `purgeExpiredClaimTokens` deletes tokens past `purgeAfter` — and with them the recipient's name
 * and contact — and marks a batch as purged when none of its tokens remain.
 *
 * Uses only Web Crypto and type imports, so the pure helpers also run in the browser.
 */
import type { Firestore } from 'firebase-admin/firestore';

import { CLAIM_RETENTION_DAYS, type ClaimTokenDocument } from '@/types/audit';
import { COLLECTIONS, type TimestampLike } from '@/types/roles';

const DAY_MS = 86_400_000;

/** A new unguessable claim token (256 bits, base64url). */
export function mintClaimToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** The document id of a token: lower-case hex SHA-256 of the token text. */
export async function hashClaimToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const millis = (value: TimestampLike | Date | number): number =>
  typeof value === 'number' ? value : value instanceof Date ? value.getTime() : value.toMillis();

/** True once `now` has reached the expiry instant (a link is valid strictly before it). */
export function isTokenExpired(
  tokenExpiry: TimestampLike | Date | number,
  now = Date.now(),
): boolean {
  return now >= millis(tokenExpiry);
}

/** When an expired token and its recipient data are deleted. */
export function purgeAfterFor(tokenExpiry: TimestampLike | Date | number): Date {
  return new Date(millis(tokenExpiry) + CLAIM_RETENTION_DAYS * DAY_MS);
}

/** Whole days (rounded up) until expiry; 0 or less once expired. */
export function daysUntilExpiry(
  tokenExpiry: TimestampLike | Date | number,
  now = Date.now(),
): number {
  return Math.ceil((millis(tokenExpiry) - now) / DAY_MS);
}

export type ClaimTokenStatus = 'valid' | 'expired' | 'claimed' | 'not_found' | 'malformed';

export interface ClaimTokenCheck {
  status: ClaimTokenStatus;
  /** Present for `valid`, `expired` and `claimed`. */
  tokenId?: string;
  token?: ClaimTokenDocument;
}

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Looks a claim token up and says whether it can still be claimed. An expired token is refused
 * even before the sweep has deleted it.
 */
export async function verifyClaimToken(
  db: Firestore,
  token: string,
  now = Date.now(),
): Promise<ClaimTokenCheck> {
  if (!TOKEN_FORMAT.test(token)) return { status: 'malformed' };
  const tokenId = await hashClaimToken(token);
  const snapshot = await db.collection(COLLECTIONS.claimTokens).doc(tokenId).get();
  if (!snapshot.exists) return { status: 'not_found' };
  const record = snapshot.data() as ClaimTokenDocument;
  if (record.claimedAt) return { status: 'claimed', tokenId, token: record };
  if (isTokenExpired(record.expiresAt, now)) return { status: 'expired', tokenId, token: record };
  return { status: 'valid', tokenId, token: record };
}

export interface PurgeResult {
  /** Tokens deleted. */
  deleted: number;
  /** Batches newly marked as purged. */
  batchesPurged: number;
}

/**
 * Deletes every claim token whose `purgeAfter` has passed (claimed or not), in pages of
 * `pageSize`, and stamps `purgedAt` on the batches they belonged to. Safe to run repeatedly and
 * concurrently: deleting a deleted document is a no-op. Intended for a daily scheduler call
 * (`POST /api/cron/purge-claim-tokens`).
 */
export async function purgeExpiredClaimTokens(
  db: Firestore,
  { now = Date.now(), pageSize = 400 }: { now?: number; pageSize?: number } = {},
): Promise<PurgeResult> {
  const cutoff = new Date(now);
  const batchIds = new Set<string>();
  let deleted = 0;
  for (;;) {
    const page = await db
      .collection(COLLECTIONS.claimTokens)
      .where('purgeAfter', '<=', cutoff)
      .limit(pageSize)
      .get();
    if (page.empty) break;
    const writes = db.batch();
    for (const doc of page.docs) {
      writes.delete(doc.ref);
      batchIds.add(doc.get('batchId') as string);
    }
    await writes.commit();
    deleted += page.size;
    if (page.size < pageSize) break;
  }

  // A batch counts as purged once none of its tokens remain (claimed tokens can keep an older
  // expiry than tokens renewed by a re-issue, so they may go first).
  let batchesPurged = 0;
  for (const batchId of batchIds) {
    const ref = db.collection(COLLECTIONS.issuedBatches).doc(batchId);
    const remaining = db
      .collection(COLLECTIONS.claimTokens)
      .where('batchId', '==', batchId)
      .limit(1);
    const marked = await db.runTransaction(async (transaction) => {
      const [snapshot, left] = await Promise.all([
        transaction.get(ref),
        transaction.get(remaining),
      ]);
      if (!snapshot.exists || snapshot.get('purgedAt') || !left.empty) return false;
      transaction.update(ref, { purgedAt: cutoff });
      return true;
    });
    if (marked) batchesPurged++;
  }
  return { deleted, batchesPurged };
}
