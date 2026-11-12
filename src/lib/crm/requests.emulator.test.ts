/**
 * The Kanban's Firestore layer against the emulator: creating, listing, moving and keeping each
 * institution's board apart from every other.
 *
 *     npm run test:emulator
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { adminFirestore } from '@/lib/server/firebase-admin';
import { COLLECTIONS, type SessionUser } from '@/types/roles';

import { clearFirestore, HAS_EMULATORS } from '../../../tests/support/firebase-emulator';
import { createRequest, listRequests, moveRequest, ownerKeyOf, RequestError } from './requests';

const staffA: SessionUser = {
  uid: 'staff-a',
  email: 'a@example.in',
  role: 'inst_staff',
  institutionId: 'school-a',
};
const adminA: SessionUser = { ...staffA, uid: 'admin-a', role: 'inst_admin' };
const staffB: SessionUser = { ...staffA, uid: 'staff-b', institutionId: 'school-b' };
const maker: SessionUser = {
  uid: 'maker',
  email: 'm@example.in',
  role: 'individual',
  institutionId: null,
};

const db = () => adminFirestore();
const add = (user: SessionUser, name: string, credential = 'Class 10 certificate') =>
  createRequest(db(), user, { recipientName: name, credential });
const names = async (user: SessionUser, stage?: string) =>
  (await listRequests(db(), user))
    .filter((r) => !stage || r.stage === stage)
    .map((r) => r.recipientName);

describe.skipIf(!HAS_EMULATORS)('credential requests (Firestore)', () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it('keys boards by institution, or by person for a Micro-Issuer', () => {
    expect(ownerKeyOf(staffA)).toBe('inst:school-a');
    expect(ownerKeyOf(adminA)).toBe('inst:school-a');
    expect(ownerKeyOf(maker)).toBe('uid:maker');
  });

  it('starts empty and lists new requests newest first, in "New Requests"', async () => {
    expect(await listRequests(db(), staffA)).toEqual([]);
    await add(staffA, 'Asha');
    await add(staffA, 'Ravi');
    const board = await listRequests(db(), staffA);
    expect(board.map((r) => r.recipientName)).toEqual(['Ravi', 'Asha']);
    expect(board.every((r) => r.stage === 'new')).toBe(true);
  });

  it('shares the board between an institution’s admin and staff, and with nobody else', async () => {
    await add(staffA, 'Asha');
    expect(await names(adminA)).toEqual(['Asha']);
    expect(await names(staffB)).toEqual([]);
    expect(await names(maker)).toEqual([]);
  });

  it('moves a card between columns and into a position, and the move persists', async () => {
    const a = await add(staffA, 'A');
    const b = await add(staffA, 'B');
    const c = await add(staffA, 'C');
    // Board "new" reads C, B, A. Send A to Ready, then B after it, then C in front of both.
    await moveRequest(db(), staffA, { id: a.id, to: 'ready', toIndex: 0 });
    await moveRequest(db(), staffA, { id: b.id, to: 'ready', toIndex: 1 });
    await moveRequest(db(), staffA, { id: c.id, to: 'ready', toIndex: 0 });
    expect(await names(adminA, 'ready')).toEqual(['C', 'A', 'B']);
    expect(await names(adminA, 'new')).toEqual([]);
    // Reorder inside a column.
    await moveRequest(db(), staffA, { id: b.id, to: 'ready', toIndex: 0 });
    expect(await names(adminA, 'ready')).toEqual(['B', 'C', 'A']);
  });

  it('survives many moves to the same spot (precision runs out, the column is respaced)', async () => {
    const first = await add(staffA, 'first');
    const last = await add(staffA, 'last');
    const movers = [];
    for (let i = 0; i < 45; i++) movers.push(await add(staffA, `m${i}`));
    // All into one column, each at index 1: the gap after "first" halves every time.
    await moveRequest(db(), staffA, { id: first.id, to: 'ready', toIndex: 0 });
    await moveRequest(db(), staffA, { id: last.id, to: 'ready', toIndex: 1 });
    for (const m of movers) await moveRequest(db(), staffA, { id: m.id, to: 'ready', toIndex: 1 });
    const ready = await names(staffA, 'ready');
    expect(ready).toHaveLength(47);
    expect(ready[0]).toBe('first');
    expect(ready[1]).toBe('m44');
    expect(ready.at(-1)).toBe('last');
  });

  it('cannot move, or even find, another institution’s card', async () => {
    const theirs = await add(staffB, 'Theirs');
    await expect(
      moveRequest(db(), staffA, { id: theirs.id, to: 'issued', toIndex: 0 }),
    ).rejects.toBeInstanceOf(RequestError);
    await expect(
      moveRequest(db(), staffA, { id: 'does-not-exist', to: 'issued', toIndex: 0 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await names(staffB, 'new')).toEqual(['Theirs']);
  });

  it('stores who made the card and when, without leaking either to the board', async () => {
    const made = await add(staffA, 'Asha');
    const doc = await db().collection(COLLECTIONS.credentialRequests).doc(made.id).get();
    expect(doc.get('createdByUid')).toBe('staff-a');
    expect(doc.get('ownerKey')).toBe('inst:school-a');
    expect(Object.keys((await listRequests(db(), staffA))[0]!).sort()).toEqual([
      'credential',
      'id',
      'recipientName',
      'stage',
      'updatedAt',
    ]);
  });
});
