/**
 * Credit deduction, refunds and idempotency of dispatches against the Firestore emulator.
 *
 *     npm run test:emulator
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { adminFirestore } from '@/lib/server/firebase-admin';
import { COLLECTIONS, type InstitutionDocument, type SessionUser } from '@/types/roles';

import { clearFirestore, HAS_EMULATORS } from '../../../tests/support/firebase-emulator';
import type { DispatchRequest, TargetResult } from './request';
import { DispatchError, dispatchId, runDispatch, type DispatchRecord } from './run';

const STAFF: SessionUser = {
  uid: 'staff-1',
  email: 'staff@example.in',
  role: 'inst_staff',
  institutionId: 'school-a',
};

async function institution(overrides: Partial<InstitutionDocument> = {}) {
  await adminFirestore()
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
  (await adminFirestore().collection(COLLECTIONS.institutions).doc('school-a').get()).get(
    'creditBalance',
  ) as number;

function request(count: number, key = 'batch-0001'): DispatchRequest<'whatsapp'> {
  return {
    idempotencyKey: key,
    targets: Array.from({ length: count }, (_, i) => ({
      recipientName: `Student ${i}`,
      phone: `91987654320${i}`,
      claimToken: `token-${String(i).padStart(12, '0')}`,
      expiresAt: '2030-01-01T00:00:00Z',
    })),
  };
}

const allSent = (r: DispatchRequest<'whatsapp'>): TargetResult[] =>
  r.targets.map((_, index) => ({ index, status: 'sent', providerId: `wamid.${index}` }));

describe.skipIf(!HAS_EMULATORS)('runDispatch (Firestore emulator)', () => {
  beforeEach(async () => {
    await clearFirestore();
    await institution();
  });

  it('deducts credits BEFORE the provider is called, then refunds failures', async () => {
    const send = vi.fn(async (r: DispatchRequest<'whatsapp'>, context) => {
      // At send time the full cost is already gone and the record says "sending".
      expect(await balance()).toBe(6);
      const record = await adminFirestore()
        .collection(COLLECTIONS.dispatches)
        .doc(context.dispatchId)
        .get();
      expect(record.get('status')).toBe('sending');
      expect(context.issuerName).toBe('Sunrise Public School');
      return allSent(r).map((result) =>
        result.index === 2
          ? { index: 2, status: 'failed' as const, error: 'WhatsApp 400' }
          : result,
      );
    });
    const outcome = await runDispatch({
      db: adminFirestore(),
      user: STAFF,
      channel: 'whatsapp',
      request: request(4),
      send,
    });
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
      await adminFirestore().collection(COLLECTIONS.dispatches).doc(outcome.dispatchId).get()
    ).data() as DispatchRecord;
    expect(stored).toMatchObject({ status: 'completed', creditsCharged: 4, creditsRefunded: 1 });
    expect(JSON.stringify(stored)).not.toContain('98765'); // no phone numbers stored
  });

  it('replays the same idempotency key without sending or charging again', async () => {
    const send = vi.fn(async (r: DispatchRequest<'whatsapp'>) => allSent(r));
    const input = { db: adminFirestore(), user: STAFF, channel: 'whatsapp' as const, send };
    const first = await runDispatch({ ...input, request: request(3) });
    const second = await runDispatch({ ...input, request: request(3) });
    expect(send).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ replayed: true, dispatchId: first.dispatchId, sent: 3 });
    expect(await balance()).toBe(7);
    await expect(runDispatch({ ...input, request: request(2) })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('charges each of concurrent dispatches exactly once', async () => {
    const send = vi.fn(async (r: DispatchRequest<'whatsapp'>) => allSent(r));
    const input = { db: adminFirestore(), user: STAFF, channel: 'whatsapp' as const, send };
    const results = await Promise.allSettled(
      ['batch-a001', 'batch-b001', 'batch-c001'].map((key) =>
        runDispatch({ ...input, request: request(3, key) }),
      ),
    );
    // 10 credits: three dispatches of 3 all fit; balance must be exactly 1.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await balance()).toBe(1);
    await expect(
      runDispatch({ ...input, request: request(2, 'batch-d001') }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
      details: { required: 2, available: 1 },
    });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it.each<[Partial<InstitutionDocument>, string]>([
    [{ verified: false }, 'INSTITUTION_NOT_VERIFIED'],
    [{ creditBalance: 3 }, 'INSUFFICIENT_CREDITS'],
    [{ staffUids: [] }, 'NOT_INSTITUTION_MEMBER'],
  ])('refuses %j with %s and charges nothing', async (overrides, code) => {
    await institution(overrides);
    const send = vi.fn();
    const before = await balance();
    const attempt = runDispatch({
      db: adminFirestore(),
      user: STAFF,
      channel: 'whatsapp',
      request: request(4),
      send,
    });
    await expect(attempt).rejects.toBeInstanceOf(DispatchError);
    await expect(attempt).rejects.toMatchObject({ code });
    expect(send).not.toHaveBeenCalled();
    expect(await balance()).toBe(before);
  });

  it('keys dispatches by institution, channel and key', () => {
    expect(dispatchId('a', 'whatsapp', 'k')).not.toBe(dispatchId('a', 'email', 'k'));
    expect(dispatchId('a', 'email', 'k')).not.toBe(dispatchId('b', 'email', 'k'));
  });
});
