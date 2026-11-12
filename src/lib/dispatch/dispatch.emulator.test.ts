/**
 * Credits, claim tokens, the audit ledger, re-issue and the purge sweep against the Firestore
 * emulator.
 *
 *     npm run test:emulator
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { adminFirestore } from '@/lib/server/firebase-admin';
import {
  hashClaimToken,
  isTokenExpired,
  purgeExpiredClaimTokens,
  verifyClaimToken,
} from '@/lib/utils/tokenManager';
import { CLAIM_RETENTION_DAYS, MAX_REISSUES, REISSUE_COOLDOWN_MS } from '@/types/audit';
import { COLLECTIONS, type InstitutionDocument, type SessionUser } from '@/types/roles';

import { clearFirestore, HAS_EMULATORS } from '../../../tests/support/firebase-emulator';
import type { DispatchRequest, DispatchTarget, TargetResult } from './request';
import {
  DispatchError,
  dispatchId,
  listIssuedBatches,
  runDispatch,
  runReissue,
  type DispatchRecord,
  type DispatchSender,
} from './run';

const DAY = 86_400_000;
const STAFF: SessionUser = {
  uid: 'staff-1',
  email: 'staff@example.in',
  role: 'inst_staff',
  institutionId: 'school-a',
};
const OUTSIDER: SessionUser = { ...STAFF, uid: 'staff-b', institutionId: 'school-b' };

const db = () => adminFirestore();

async function institution(overrides: Partial<InstitutionDocument> = {}) {
  await db()
    .collection(COLLECTIONS.institutions)
    .doc('school-a')
    .set({
      name: 'Sunrise Public School',
      adminUid: 'admin-1',
      staffUids: ['staff-1'],
      creditBalance: 10,
      verified: true,
      ...overrides,
    } satisfies InstitutionDocument);
}

const balance = async () =>
  (await db().collection(COLLECTIONS.institutions).doc('school-a').get()).get(
    'creditBalance',
  ) as number;

function request(count: number, key = 'batch-0001', ttlDays = 7): DispatchRequest<'whatsapp'> {
  return {
    idempotencyKey: key,
    templateId: 'tpl-cert',
    tokenExpiry: new Date(Date.now() + ttlDays * DAY).toISOString(),
    claimFeePaise: 0,
    targets: Array.from({ length: count }, (_, i) => ({
      recipientName: `Student ${i}`,
      phone: `91987654320${i}`,
    })),
  };
}

/** A sender that records what it was given and reports every recipient as sent. */
function recorder(fail: (target: DispatchTarget<'whatsapp'>) => boolean = () => false) {
  const calls: DispatchTarget<'whatsapp'>[][] = [];
  const send = vi.fn(async (targets: DispatchTarget<'whatsapp'>[]) => {
    calls.push(targets);
    return targets.map((target, index): TargetResult =>
      fail(target)
        ? { index, status: 'failed', error: 'WhatsApp 400' }
        : { index, status: 'sent', providerId: `wamid.${index}` },
    );
  });
  return { send, calls };
}

const dispatch = (r: DispatchRequest<'whatsapp'>, send: DispatchSender<'whatsapp'>) =>
  runDispatch({ db: db(), user: STAFF, channel: 'whatsapp', request: r, send });

const reissue = (batchId: string, send: DispatchSender<'whatsapp'>, now?: number, user = STAFF) =>
  runReissue({
    db: db(),
    user,
    batchId,
    senderFor: () => send as DispatchSender<'whatsapp' | 'email'>,
    now,
  });

describe.skipIf(!HAS_EMULATORS)('dispatch, ledger and claim tokens (Firestore emulator)', () => {
  beforeEach(async () => {
    await clearFirestore();
    await institution();
    await db().collection(COLLECTIONS.templates).doc('tpl-cert').set({
      ownerUid: 'admin-1',
      institutionId: 'school-a',
      name: 'Class 10 certificate',
    });
  });

  it('refuses a claim fee before charging when the institution has no payout account', async () => {
    const { send } = recorder();
    await expect(dispatch({ ...request(2), claimFeePaise: 5_000 }, send)).rejects.toMatchObject({
      code: 'PAYOUT_ACCOUNT_MISSING',
    });
    expect(send).not.toHaveBeenCalled();
    expect(await balance()).toBe(10);
    expect((await db().collection(COLLECTIONS.claimTokens).get()).size).toBe(0);

    await db()
      .collection(COLLECTIONS.institutions)
      .doc('school-a')
      .update({ razorpayAccountId: 'acc_SchoolA0000001' });
    await dispatch({ ...request(2), claimFeePaise: 5_000 }, send);
    expect(send).toHaveBeenCalledOnce();
    const tokens = await db().collection(COLLECTIONS.claimTokens).get();
    expect(tokens.docs.map((doc) => doc.get('feePaise'))).toEqual([5_000, 5_000]);
  });

  it('deducts credits BEFORE the provider is called, then refunds failures', async () => {
    const send = vi.fn(async (targets: DispatchTarget<'whatsapp'>[], context) => {
      expect(await balance()).toBe(6);
      const record = await db().collection(COLLECTIONS.dispatches).doc(context.dispatchId).get();
      expect(record.get('status')).toBe('sending');
      expect(context.issuerName).toBe('Sunrise Public School');
      return targets.map((_, index): TargetResult =>
        index === 2
          ? { index, status: 'failed', error: 'WhatsApp 400' }
          : { index, status: 'sent', providerId: `wamid.${index}` },
      );
    });
    const outcome = await dispatch(request(4), send);
    expect(outcome).toMatchObject({
      replayed: false,
      sent: 3,
      failed: 1,
      creditsCharged: 4,
      creditsRefunded: 1,
      creditBalance: 7,
    });
    expect(await balance()).toBe(7);
    const stored = (
      await db().collection(COLLECTIONS.dispatches).doc(outcome.dispatchId).get()
    ).data() as DispatchRecord;
    expect(stored).toMatchObject({ status: 'completed', creditsCharged: 4, creditsRefunded: 1 });
    expect(JSON.stringify(stored)).not.toContain('98765');
  });

  it('records the batch and one hashed, time-locked token per recipient', async () => {
    const { send, calls } = recorder();
    const r = request(3);
    const outcome = await dispatch(r, send);
    const batch = (
      await db().collection(COLLECTIONS.issuedBatches).doc(outcome.batchId).get()
    ).data()!;
    expect(batch).toMatchObject({
      issuerUid: 'staff-1',
      templateId: 'tpl-cert',
      templateName: 'Class 10 certificate',
      institutionId: 'school-a',
      recipientCount: 3,
      sentCount: 3,
      status: 'completed',
      reissueCount: 0,
    });
    expect(batch.tokenExpiry.toMillis()).toBe(Date.parse(r.tokenExpiry));
    expect(batch.dispatchedAt.toMillis()).toBeGreaterThan(Date.now() - 60_000);

    const sentTokens = calls[0]!.map((target) => target.claimToken);
    expect(new Set(sentTokens).size).toBe(3);
    for (const token of sentTokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // Only the hash is stored.
      expect((await db().collection(COLLECTIONS.claimTokens).doc(token).get()).exists).toBe(false);
      const check = await verifyClaimToken(db(), token);
      expect(check.status).toBe('valid');
      expect(check.token).toMatchObject({ batchId: outcome.batchId, claimedAt: null });
      expect(check.token!.purgeAfter.toMillis() - check.token!.expiresAt.toMillis()).toBe(
        CLAIM_RETENTION_DAYS * DAY,
      );
    }
    expect((await verifyClaimToken(db(), 'x'.repeat(43))).status).toBe('not_found');
    expect((await verifyClaimToken(db(), 'bad token')).status).toBe('malformed');
    // Expired before the sweep has run: refused all the same.
    const later = Date.parse(r.tokenExpiry);
    expect((await verifyClaimToken(db(), sentTokens[0]!, later)).status).toBe('expired');
    expect(isTokenExpired(later, later - 1)).toBe(false);
    expect(isTokenExpired(later, later)).toBe(true);
  });

  it('replays the same idempotency key without sending, charging or minting again', async () => {
    const { send } = recorder();
    const first = await dispatch(request(3), send);
    const second = await dispatch(request(3), send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ replayed: true, dispatchId: first.dispatchId, sent: 3 });
    expect(await balance()).toBe(7);
    expect((await db().collection(COLLECTIONS.claimTokens).get()).size).toBe(3);
    await expect(dispatch(request(2), send)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('charges each of concurrent dispatches exactly once', async () => {
    const { send } = recorder();
    const results = await Promise.allSettled(
      ['batch-a001', 'batch-b001', 'batch-c001'].map((key) => dispatch(request(3, key), send)),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await balance()).toBe(1);
    await expect(dispatch(request(2, 'batch-d001'), send)).rejects.toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
      details: { required: 2, available: 1 },
    });
  });

  it.each<[string, () => Promise<void>, string]>([
    ['unverified', () => institution({ verified: false }), 'INSTITUTION_NOT_VERIFIED'],
    ['short of credits', () => institution({ creditBalance: 3 }), 'INSUFFICIENT_CREDITS'],
    ['no longer staff', () => institution({ staffUids: [] }), 'NOT_INSTITUTION_MEMBER'],
    [
      'using another institution’s template',
      async () => {
        await db().collection(COLLECTIONS.templates).doc('tpl-cert').update({
          institutionId: 'school-b',
        });
      },
      'TEMPLATE_NOT_FOUND',
    ],
  ])('refuses a dispatch when %s, charging nothing', async (_label, setup, code) => {
    await setup();
    const { send } = recorder();
    const before = await balance();
    const attempt = dispatch(request(4), send);
    await expect(attempt).rejects.toBeInstanceOf(DispatchError);
    await expect(attempt).rejects.toMatchObject({ code });
    expect(send).not.toHaveBeenCalled();
    expect(await balance()).toBe(before);
    expect((await db().collection(COLLECTIONS.claimTokens).get()).size).toBe(0);
  });

  it('re-issues unclaimed recipients with fresh links, free of charge', async () => {
    const first = recorder((target) => target.phone.endsWith('2'));
    const r = request(3, 'batch-0001', 7);
    const { batchId } = await dispatch(r, first.send);
    expect(await balance()).toBe(8); // 3 charged, 1 refunded
    const [claimedToken, oldToken] = first.calls[0]!.map((t) => t.claimToken);
    // Recipient 0 claims; recipients 1 and 2 (2 was undelivered) have not.
    await db()
      .collection(COLLECTIONS.claimTokens)
      .doc(await hashClaimToken(claimedToken!))
      .update({ claimedAt: new Date() });

    const now = Date.now() + 2 * DAY;
    const second = recorder();
    const outcome = await reissue(batchId, second.send, now);
    expect(outcome).toMatchObject({ recipients: 2, sent: 2, failed: 0, creditsCharged: 0 });
    expect(await balance()).toBe(8);
    expect(second.calls[0]!.map((t) => t.recipientName).sort()).toEqual(['Student 1', 'Student 2']);
    // New expiry = re-issue time + the batch's original validity (7 days).
    expect(outcome.batch.tokenExpiry).toBeGreaterThanOrEqual(now + 7 * DAY - 60_000);
    expect(outcome.batch).toMatchObject({ reissueCount: 1, status: 'completed' });
    expect(outcome.batch.lastReissue).toMatchObject({ recipients: 2, sent: 2 });
    // Old unclaimed link is dead, the new one works, the claimed one is untouched.
    expect((await verifyClaimToken(db(), oldToken!, now)).status).toBe('not_found');
    expect((await verifyClaimToken(db(), second.calls[0]![0]!.claimToken, now)).status).toBe(
      'valid',
    );
    expect((await verifyClaimToken(db(), claimedToken!, now)).status).toBe('claimed');
  });

  it('bounds re-issues: cooldown, limit, other institutions, nothing left', async () => {
    const { send } = recorder();
    const { batchId } = await dispatch(request(2), send);
    let now = Date.now();
    await reissue(batchId, send, now);
    await expect(reissue(batchId, send, now + 1000)).rejects.toMatchObject({
      code: 'REISSUE_BLOCKED',
      details: { reason: 'cooldown' },
    });
    await expect(reissue(batchId, send, now, OUTSIDER)).rejects.toMatchObject({
      code: 'BATCH_NOT_FOUND',
    });
    for (let i = 1; i < MAX_REISSUES; i++) {
      now += REISSUE_COOLDOWN_MS;
      await reissue(batchId, send, now);
    }
    await expect(reissue(batchId, send, now + REISSUE_COOLDOWN_MS)).rejects.toMatchObject({
      details: { reason: 'limit' },
    });

    const other = await dispatch(request(1, 'batch-0002'), send);
    const tokens = await db()
      .collection(COLLECTIONS.claimTokens)
      .where('batchId', '==', other.batchId)
      .get();
    await tokens.docs[0]!.ref.update({ claimedAt: new Date() });
    await expect(reissue(other.batchId, send)).rejects.toMatchObject({
      code: 'NOTHING_TO_REISSUE',
    });
    const batch = await db().collection(COLLECTIONS.issuedBatches).doc(other.batchId).get();
    expect(batch.get('reissueCount')).toBe(0); // a refused re-issue is not counted
  });

  it('purges expired tokens after the retention period and blocks re-issue', async () => {
    const { send } = recorder();
    const r = request(3, 'batch-0001', 1);
    const { batchId } = await dispatch(r, send);
    const fresh = await dispatch(request(2, 'batch-0002', 60), send);
    const expiry = Date.parse(r.tokenExpiry);

    // Expired but within retention: kept (re-issue still possible).
    let result = await purgeExpiredClaimTokens(db(), { now: expiry + DAY });
    expect(result).toEqual({ deleted: 0, batchesPurged: 0 });

    result = await purgeExpiredClaimTokens(db(), {
      now: expiry + CLAIM_RETENTION_DAYS * DAY + 1,
      pageSize: 2, // exercises paging
    });
    expect(result).toEqual({ deleted: 3, batchesPurged: 1 });
    const remaining = await db().collection(COLLECTIONS.claimTokens).get();
    expect(remaining.docs.every((doc) => doc.get('batchId') === fresh.batchId)).toBe(true);
    expect(remaining.size).toBe(2);

    const rows = await listIssuedBatches(db(), STAFF);
    expect(rows.map((row) => row.id).sort()).toEqual([batchId, fresh.batchId].sort());
    expect(rows.find((row) => row.id === batchId)!.purgedAt).not.toBeNull();
    await expect(reissue(batchId, send)).rejects.toMatchObject({ details: { reason: 'purged' } });
    // Idempotent.
    expect(
      await purgeExpiredClaimTokens(db(), { now: expiry + CLAIM_RETENTION_DAYS * DAY + 1 }),
    ).toEqual({ deleted: 0, batchesPurged: 0 });
  });

  it('lists only the caller’s institution’s batches, newest first', async () => {
    const { send } = recorder();
    await dispatch(request(1, 'batch-0001'), send);
    await dispatch(request(1, 'batch-0002'), send);
    const rows = await listIssuedBatches(db(), STAFF);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.dispatchedAt).toBeGreaterThanOrEqual(rows[1]!.dispatchedAt);
    expect(await listIssuedBatches(db(), OUTSIDER)).toEqual([]);
    expect(
      await listIssuedBatches(db(), { ...STAFF, role: 'individual', institutionId: null }),
    ).toEqual([]);
  });

  it('keys dispatches by institution, channel and key', () => {
    expect(dispatchId('a', 'whatsapp', 'k')).not.toBe(dispatchId('a', 'email', 'k'));
    expect(dispatchId('a', 'email', 'k')).not.toBe(dispatchId('b', 'email', 'k'));
  });
});
