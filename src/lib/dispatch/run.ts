/**
 * A dispatch, start to finish (ADR-024):
 *
 *   1. RESERVE (one Firestore transaction): if a dispatch with this idempotency key exists, return
 *      it — nothing is sent or charged again. Otherwise check the caller still belongs to the
 *      institution, that it is verified and has enough credits; deduct `cost × recipients` from
 *      `institutions/{id}.creditBalance` and create `dispatches/{id}` with status `sending`.
 *   2. SEND through the provider — only after the credits are taken.
 *   3. SETTLE (second transaction): refund one cost per failed recipient and record the results.
 *
 * If the process dies between 1 and 3, the record stays `sending` with the full charge; it can be
 * reconciled from the provider's logs (`providerId`s are stored once known). Nothing here touches
 * Next.js, so it is tested directly against the Firestore emulator.
 */
import { createHash } from 'node:crypto';

import {
  FieldValue,
  type DocumentSnapshot,
  type Firestore,
  type Timestamp,
} from 'firebase-admin/firestore';

import { COLLECTIONS, type InstitutionDocument, type SessionUser } from '@/types/roles';

import {
  DISPATCH_CREDIT_COST,
  type DispatchChannel,
  type DispatchRequest,
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
  | 'INSUFFICIENT_CREDITS'
  | 'DISPATCH_IN_PROGRESS'
  | 'IDEMPOTENCY_KEY_REUSED';

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
  request: DispatchRequest<C>,
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
  const cost = DISPATCH_CREDIT_COST[channel] * request.targets.length;

  // 1. Reserve.
  const reserved = await db.runTransaction(async (transaction) => {
    const [institutionSnap, existingSnap] = (await transaction.getAll(
      institutionRef,
      dispatchRef,
    )) as [DocumentSnapshot, DocumentSnapshot];
    const institution = institutionSnap.data() as InstitutionDocument | undefined;
    if (!institution) {
      throw new DispatchError('INSTITUTION_NOT_FOUND', 'The institution does not exist.');
    }
    // Claims can lag behind the directory; the institution document is the source of truth.
    if (institution.adminUid !== user.uid && !institution.staffUids.includes(user.uid)) {
      throw new DispatchError(
        'NOT_INSTITUTION_MEMBER',
        'You are not a member of this institution.',
      );
    }
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
    return { replay: null, issuerName: institution.name };
  });
  if (reserved.replay) return reserved.replay;

  // 2. Send — credits are already deducted.
  const results = await send(request, { issuerName: reserved.issuerName, dispatchId: id });
  const failed = results.filter((result) => result.status !== 'sent').length;
  const refund = DISPATCH_CREDIT_COST[channel] * failed;

  // 3. Settle.
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
