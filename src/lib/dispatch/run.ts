/**
 * A dispatch, start to finish (ADR-024, ADR-026):
 *
 *   1. RESERVE (one Firestore transaction): if a dispatch with this idempotency key exists, return
 *      it — nothing is sent or charged again. Otherwise check the caller still belongs to the
 *      institution, that it is verified, owns the template and has enough credits; deduct
 *      `cost × recipients` from `institutions/{id}.creditBalance`, and create `dispatches/{id}`
 *      (credit ledger) and `issued_batches/{id}` (audit ledger), both `sending`.
 *   2. MINT one claim token per recipient and store their hashes (`claim_tokens`).
 *   3. SEND through the provider — only after the credits are taken.
 *   4. SETTLE (second transaction): refund one cost per failed recipient and record the results.
 *
 * `runReissue` re-sends a batch to its unclaimed recipients with fresh tokens and charges nothing;
 * it is bounded (MAX_REISSUES, REISSUE_COOLDOWN_MS) because it is free.
 *
 * If the process dies between 1 and 4, the records stay `sending` with the full charge; they can
 * be reconciled later. Nothing here touches Next.js, so it is tested against the emulator.
 */
import { createHash } from 'node:crypto';

import {
  FieldValue,
  type DocumentSnapshot,
  type Firestore,
  type Timestamp,
  type WriteBatch,
} from 'firebase-admin/firestore';

import type { TemplateRecordDocument } from '@/lib/template';
import { hashClaimToken, mintClaimToken, purgeAfterFor } from '@/lib/utils/tokenManager';
import {
  reissueBlock,
  toBatchRow,
  type ClaimTokenDocument,
  type IssuedBatchDocument,
  type IssuedBatchRow,
  type IssuedBatchSchema,
  type ReissueBlock,
} from '@/types/audit';
import { COLLECTIONS, type InstitutionDocument, type SessionUser } from '@/types/roles';

import {
  DISPATCH_CREDIT_COST,
  type DispatchChannel,
  type DispatchRecipient,
  type DispatchRequest,
  type DispatchTarget,
  type TargetResult,
} from './request';

export type DispatchStatus = 'sending' | 'completed';

/** `dispatches/{id}`. Holds no recipient contact details. */
export interface DispatchRecord {
  institutionId: string;
  channel: DispatchChannel;
  createdByUid: string;
  targetCount: number;
  creditsCharged: number;
  creditsRefunded: number;
  status: DispatchStatus;
  results: TargetResult[];
  createdAt: Timestamp | FieldValue;
  completedAt: Timestamp | FieldValue | null;
}

export type DispatchErrorCode =
  | 'NOT_INSTITUTION_MEMBER'
  | 'INSTITUTION_NOT_FOUND'
  | 'INSTITUTION_NOT_VERIFIED'
  | 'TEMPLATE_NOT_FOUND'
  | 'INSUFFICIENT_CREDITS'
  | 'DISPATCH_IN_PROGRESS'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'BATCH_NOT_FOUND'
  | 'REISSUE_BLOCKED'
  | 'NOTHING_TO_REISSUE';

export class DispatchError extends Error {
  constructor(
    readonly code: DispatchErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DispatchError';
  }
}

export interface DispatchOutcome {
  dispatchId: string;
  /** The audit-ledger entry (`issued_batches/{batchId}`); equals `dispatchId`. */
  batchId: string;
  channel: DispatchChannel;
  /** True when this key had already been dispatched: nothing was sent or charged this time. */
  replayed: boolean;
  sent: number;
  failed: number;
  creditsCharged: number;
  creditsRefunded: number;
  /** The institution's balance after this dispatch settled (current balance for a replay). */
  creditBalance: number;
  results: TargetResult[];
}

/** Stable per institution + channel + key, so the same key cannot be charged twice. */
export function dispatchId(institutionId: string, channel: DispatchChannel, key: string): string {
  return createHash('sha256').update(`${institutionId}\n${channel}\n${key}`).digest('hex');
}

/** Sends to the recipients; must report every index and never throw. */
export type DispatchSender<C extends DispatchChannel> = (
  targets: DispatchTarget<C>[],
  context: { issuerName: string; dispatchId: string },
) => Promise<TargetResult[]>;

function summarise(
  id: string,
  record: Pick<
    DispatchRecord,
    'channel' | 'creditsCharged' | 'creditsRefunded' | 'results' | 'targetCount'
  >,
  replayed: boolean,
  creditBalance: number,
): DispatchOutcome {
  const sent = record.results.filter((result) => result.status === 'sent').length;
  return {
    dispatchId: id,
    batchId: id,
    channel: record.channel,
    replayed,
    sent,
    failed: record.targetCount - sent,
    creditsCharged: record.creditsCharged,
    creditsRefunded: record.creditsRefunded,
    creditBalance,
    results: record.results,
  };
}

const WRITES_PER_BATCH = 450;

/** Commits writes in Firestore batches (max 500 operations each). */
async function commitInChunks(
  db: Firestore,
  operations: ((batch: WriteBatch) => void)[],
): Promise<void> {
  for (let start = 0; start < operations.length; start += WRITES_PER_BATCH) {
    const batch = db.batch();
    for (const operation of operations.slice(start, start + WRITES_PER_BATCH)) operation(batch);
    await batch.commit();
  }
}

function contactOf(recipient: DispatchRecipient<DispatchChannel>): string {
  return 'phone' in recipient ? recipient.phone : recipient.email;
}

function recipientFrom(channel: DispatchChannel, token: ClaimTokenDocument) {
  return channel === 'whatsapp'
    ? { recipientName: token.recipientName, phone: token.contact }
    : { recipientName: token.recipientName, email: token.contact };
}

/** Reads the institution and checks the caller is in its directory (claims can lag behind it). */
function requireMember(snapshot: DocumentSnapshot, user: SessionUser): InstitutionDocument {
  const institution = snapshot.data() as InstitutionDocument | undefined;
  if (!institution) {
    throw new DispatchError('INSTITUTION_NOT_FOUND', 'The institution does not exist.');
  }
  if (institution.adminUid !== user.uid && !institution.staffUids.includes(user.uid)) {
    throw new DispatchError('NOT_INSTITUTION_MEMBER', 'You are not a member of this institution.');
  }
  return institution;
}

export async function runDispatch<C extends DispatchChannel>(input: {
  db: Firestore;
  user: SessionUser;
  channel: C;
  request: DispatchRequest<C>;
  send: DispatchSender<C>;
}): Promise<DispatchOutcome> {
  const { db, user, channel, request, send } = input;
  const institutionId = user.institutionId;
  if (!institutionId || (user.role !== 'inst_admin' && user.role !== 'inst_staff')) {
    throw new DispatchError('NOT_INSTITUTION_MEMBER', 'Only institution members can dispatch.');
  }
  const id = dispatchId(institutionId, channel, request.idempotencyKey);
  const institutionRef = db.collection(COLLECTIONS.institutions).doc(institutionId);
  const dispatchRef = db.collection(COLLECTIONS.dispatches).doc(id);
  const batchRef = db.collection(COLLECTIONS.issuedBatches).doc(id);
  const templateRef = db.collection(COLLECTIONS.templates).doc(request.templateId);
  const cost = DISPATCH_CREDIT_COST[channel] * request.targets.length;
  const tokenExpiry = new Date(request.tokenExpiry);

  // 1. Reserve.
  const reserved = await db.runTransaction(async (transaction) => {
    const [institutionSnap, existingSnap, templateSnap] = (await transaction.getAll(
      institutionRef,
      dispatchRef,
      templateRef,
    )) as [DocumentSnapshot, DocumentSnapshot, DocumentSnapshot];
    const institution = requireMember(institutionSnap, user);
    if (existingSnap.exists) {
      const existing = existingSnap.data() as DispatchRecord;
      if (existing.targetCount !== request.targets.length) {
        throw new DispatchError(
          'IDEMPOTENCY_KEY_REUSED',
          'This idempotency key was already used for a different list of recipients.',
        );
      }
      if (existing.status === 'sending') {
        throw new DispatchError('DISPATCH_IN_PROGRESS', 'This dispatch is still being sent.');
      }
      return { replay: summarise(id, existing, true, institution.creditBalance) };
    }
    if (!institution.verified) {
      throw new DispatchError(
        'INSTITUTION_NOT_VERIFIED',
        'The institution must be verified before it can send messages.',
      );
    }
    const template = templateSnap.data() as TemplateRecordDocument | undefined;
    if (!template || template.institutionId !== institutionId) {
      throw new DispatchError('TEMPLATE_NOT_FOUND', 'Choose one of your institution’s templates.');
    }
    if (institution.creditBalance < cost) {
      throw new DispatchError('INSUFFICIENT_CREDITS', 'Not enough credits for this dispatch.', {
        required: cost,
        available: institution.creditBalance,
      });
    }
    transaction.update(institutionRef, { creditBalance: institution.creditBalance - cost });
    transaction.create(dispatchRef, {
      institutionId,
      channel,
      createdByUid: user.uid,
      targetCount: request.targets.length,
      creditsCharged: cost,
      creditsRefunded: 0,
      status: 'sending',
      results: [],
      createdAt: FieldValue.serverTimestamp(),
      completedAt: null,
    } satisfies DispatchRecord);
    transaction.create(batchRef, {
      issuerUid: user.uid,
      templateId: request.templateId,
      templateName: template.name,
      institutionId,
      channel,
      status: 'sending',
      recipientCount: request.targets.length,
      sentCount: 0,
      failedCount: 0,
      reissueCount: 0,
      dispatchedAt: FieldValue.serverTimestamp(),
      tokenExpiry,
      // The validity each re-issue grants again.
      tokenTtlMs: Math.max(tokenExpiry.getTime() - Date.now(), 60_000),
      lastReissuedAt: null,
      lastReissue: null,
      purgedAt: null,
    });
    return { replay: null, issuerName: institution.name };
  });
  if (reserved.replay) return reserved.replay;

  let results: TargetResult[];
  try {
    // 2. Mint claim tokens (only hashes are stored).
    const targets = await Promise.all(
      request.targets.map(async (recipient) => {
        const claimToken = mintClaimToken();
        return { recipient, claimToken, tokenId: await hashClaimToken(claimToken) };
      }),
    );
    await commitInChunks(
      db,
      targets.map(
        ({ recipient, tokenId }) =>
          (writes) =>
            writes.create(db.collection(COLLECTIONS.claimTokens).doc(tokenId), {
              batchId: id,
              institutionId,
              issuerUid: user.uid,
              channel,
              recipientName: recipient.recipientName,
              contact: contactOf(recipient),
              expiresAt: tokenExpiry,
              purgeAfter: purgeAfterFor(tokenExpiry),
              claimedAt: null,
            }),
      ),
    );
    // 3. Send — credits are already deducted.
    results = await send(
      targets.map(
        ({ recipient, claimToken }) =>
          ({ ...recipient, claimToken, expiresAt: request.tokenExpiry }) as DispatchTarget<C>,
      ),
      { issuerName: reserved.issuerName, dispatchId: id },
    );
  } catch (error) {
    console.error(
      JSON.stringify({ severity: 'ERROR', message: 'claim links failed', cause: String(error) }),
    );
    results = request.targets.map((_, index) => ({
      index,
      status: 'failed',
      error: 'Claim links could not be created',
    }));
  }
  const failed = results.filter((result) => result.status !== 'sent').length;
  const refund = DISPATCH_CREDIT_COST[channel] * failed;

  // 4. Settle.
  const creditBalance = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(institutionRef);
    const balance = (snap.get('creditBalance') as number) + refund;
    if (refund > 0) transaction.update(institutionRef, { creditBalance: balance });
    transaction.update(dispatchRef, {
      status: 'completed',
      results,
      creditsRefunded: refund,
      completedAt: FieldValue.serverTimestamp(),
    });
    transaction.update(batchRef, {
      status: failed === results.length ? 'failed' : 'completed',
      sentCount: results.length - failed,
      failedCount: failed,
    });
    return balance;
  });

  return summarise(
    id,
    {
      channel,
      creditsCharged: cost,
      creditsRefunded: refund,
      results,
      targetCount: request.targets.length,
    },
    false,
    creditBalance,
  );
}

// ── Re-issue ─────────────────────────────────────────────────────────────────────────────────────

export interface ReissueOutcome {
  batch: IssuedBatchRow;
  /** Unclaimed recipients who were sent a fresh link. */
  recipients: number;
  sent: number;
  failed: number;
  /** Always 0: re-issues are free. */
  creditsCharged: 0;
}

/** A `reissuing` batch whose worker vanished is taken over after this long. */
const STALE_REISSUE_MS = 15 * 60_000;

/** Stored batch fields beyond the public schema. */
type StoredBatch = IssuedBatchDocument & { tokenTtlMs: number };

const asSchema = (id: string, data: StoredBatch): IssuedBatchSchema => ({ id, ...data });

const REISSUE_MESSAGES: Record<NonNullable<ReissueBlock>, string> = {
  purged: 'The recipients of this batch were deleted after the links expired.',
  failed: 'Nothing from this batch was delivered; send it again as a new dispatch.',
  limit: 'This batch has been re-issued the maximum number of times.',
  busy: 'This batch is being sent right now.',
  cooldown: 'This batch was re-issued a few minutes ago. Try again later.',
};

/**
 * "1-Click Re-Issue": sends every UNCLAIMED recipient of a batch a new claim link (fresh token,
 * expiry moved forward by the batch's original validity) through the batch's channel. Old links
 * stop working. Charges no credits; at most MAX_REISSUES times per batch, REISSUE_COOLDOWN_MS
 * apart; impossible once the batch's recipients were purged.
 */
export async function runReissue(input: {
  db: Firestore;
  user: SessionUser;
  batchId: string;
  senderFor: (channel: DispatchChannel) => DispatchSender<DispatchChannel> | null;
  now?: number;
}): Promise<ReissueOutcome> {
  const { db, user, batchId } = input;
  const now = input.now ?? Date.now();
  const batchRef = db.collection(COLLECTIONS.issuedBatches).doc(batchId);
  const unclaimed = db
    .collection(COLLECTIONS.claimTokens)
    .where('batchId', '==', batchId)
    .where('claimedAt', '==', null);

  // A. Check, lock the batch and count the re-issue.
  const locked = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(batchRef);
    if (!snapshot.exists) throw new DispatchError('BATCH_NOT_FOUND', 'No such batch.');
    const batch = snapshot.data() as StoredBatch;
    let issuerName: string;
    if (batch.institutionId) {
      if (user.institutionId !== batch.institutionId) {
        throw new DispatchError('BATCH_NOT_FOUND', 'No such batch.');
      }
      const institutionSnap = await transaction.get(
        db.collection(COLLECTIONS.institutions).doc(batch.institutionId),
      );
      issuerName = requireMember(institutionSnap, user).name;
    } else {
      if (batch.issuerUid !== user.uid)
        throw new DispatchError('BATCH_NOT_FOUND', 'No such batch.');
      issuerName = user.email ?? 'Your issuer';
    }

    const row = toBatchRow(asSchema(batchId, batch));
    const stale =
      batch.status === 'reissuing' &&
      row.lastReissuedAt !== null &&
      now - row.lastReissuedAt >= STALE_REISSUE_MS;
    const block = reissueBlock(stale ? { ...row, status: 'completed' } : row, now);
    if (block) {
      throw new DispatchError('REISSUE_BLOCKED', REISSUE_MESSAGES[block], { reason: block });
    }
    const pending = await transaction.get(unclaimed.limit(1));
    if (pending.empty) {
      throw new DispatchError('NOTHING_TO_REISSUE', 'Every recipient has already claimed.');
    }
    transaction.update(batchRef, {
      status: 'reissuing',
      reissueCount: batch.reissueCount + 1,
      lastReissuedAt: new Date(now),
    });
    return { batch, issuerName };
  });

  const { batch } = locked;
  const channel = batch.channel;
  const tokenExpiry = new Date(now + batch.tokenTtlMs);
  let results: TargetResult[];
  let recipients: number;
  try {
    const send = input.senderFor(channel);
    if (!send) throw new Error(`${channel} sending is not configured`);
    // B. Replace every unclaimed token with a fresh one: old links stop working.
    const old = await unclaimed.get();
    recipients = old.size;
    const renewed = await Promise.all(
      old.docs.map(async (doc) => {
        const claimToken = mintClaimToken();
        return {
          oldRef: doc.ref,
          token: doc.data() as ClaimTokenDocument,
          claimToken,
          tokenId: await hashClaimToken(claimToken),
        };
      }),
    );
    await commitInChunks(
      db,
      renewed.flatMap(({ oldRef, token, tokenId }) => [
        (writes: WriteBatch) => writes.delete(oldRef),
        (writes: WriteBatch) =>
          writes.create(db.collection(COLLECTIONS.claimTokens).doc(tokenId), {
            ...token,
            expiresAt: tokenExpiry,
            purgeAfter: purgeAfterFor(tokenExpiry),
            claimedAt: null,
          }),
      ]),
    );
    // C. Send — no credits involved.
    results = await send(
      renewed.map(
        ({ token, claimToken }) =>
          ({
            ...recipientFrom(channel, token),
            claimToken,
            expiresAt: tokenExpiry.toISOString(),
          }) as DispatchTarget<DispatchChannel>,
      ),
      { issuerName: locked.issuerName, dispatchId: `${batchId}-r${batch.reissueCount + 1}` },
    );
  } catch (error) {
    // Unlock. The attempt stays counted: some links may already have been renewed.
    await batchRef.update({ status: 'completed' });
    throw error;
  }

  // D. Settle.
  const sent = results.filter((result) => result.status === 'sent').length;
  await batchRef.update({
    status: 'completed',
    tokenExpiry,
    lastReissue: {
      at: new Date(now),
      byUid: user.uid,
      recipients,
      sent,
      failed: recipients - sent,
    },
  });
  const updated = await batchRef.get();
  return {
    batch: toBatchRow(asSchema(batchId, updated.data() as StoredBatch)),
    recipients,
    sent,
    failed: recipients - sent,
    creditsCharged: 0,
  };
}

/** Ledger rows for the caller: their institution's batches, or their own personal ones. */
export async function listIssuedBatches(
  db: Firestore,
  user: SessionUser,
  limit = 100,
): Promise<IssuedBatchRow[]> {
  const collection = db.collection(COLLECTIONS.issuedBatches);
  const query =
    user.institutionId && (user.role === 'inst_admin' || user.role === 'inst_staff')
      ? collection.where('institutionId', '==', user.institutionId)
      : collection.where('issuerUid', '==', user.uid).where('institutionId', '==', null);
  const snapshot = await query.orderBy('dispatchedAt', 'desc').limit(limit).get();
  return snapshot.docs.map((doc) => toBatchRow(asSchema(doc.id, doc.data() as StoredBatch)));
}
