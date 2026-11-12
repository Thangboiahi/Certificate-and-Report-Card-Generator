/**
 * Pre-minted verification ids against the Firestore emulator (ADR-035): minting stubs, linking them
 * to a dispatch, adopting them on claim, and what the public page sees at each step.
 *
 *     npm run test:emulator
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { claimCredential } from '@/lib/claim/claim';
import { runDispatch, type DispatchSender } from '@/lib/dispatch/run';
import type { DispatchRequest, DispatchTarget, TargetResult } from '@/lib/dispatch/request';
import { adminFirestore } from '@/lib/server/firebase-admin';
import { findSharedCredential, setSharing } from '@/lib/vault/vault';
import { COLLECTIONS, type InstitutionDocument, type SessionUser } from '@/types/roles';

import { clearFirestore, HAS_EMULATORS } from '../../../tests/support/firebase-emulator';
import { VERIFICATION_ID_PATTERN } from './ids';
import { assertStubsLinkable, mintStubs, parseMint, StubError } from './stubs';

const DAY = 86_400_000;
const STAFF: SessionUser = {
  uid: 'staff-1',
  email: 'staff@example.in',
  role: 'inst_staff',
  institutionId: 'school-a',
};
const OTHER_SCHOOL: SessionUser = { ...STAFF, uid: 'staff-b', institutionId: 'school-b' };
const MAKER: SessionUser = {
  uid: 'maker-1',
  email: 'm@example.in',
  role: 'individual',
  institutionId: null,
};
const db = () => adminFirestore();

const stub = async (id: string) =>
  (await db().collection(COLLECTIONS.verificationStubs).doc(id).get()).data();

function whatsappRequest(
  ids: (string | undefined)[],
  key = 'batch-0001',
): DispatchRequest<'whatsapp'> {
  return {
    idempotencyKey: key,
    templateId: 'tpl-cert',
    tokenExpiry: new Date(Date.now() + 7 * DAY).toISOString(),
    claimFeePaise: 0,
    targets: ids.map((verificationId, i) => ({
      recipientName: `Student ${i}`,
      phone: `91987654320${i}`,
      ...(verificationId ? { verificationId } : {}),
    })),
  };
}

const sendAll: DispatchSender<'whatsapp'> = vi.fn(async (targets: DispatchTarget<'whatsapp'>[]) =>
  targets.map((_, index): TargetResult => ({ index, status: 'sent', providerId: `w.${index}` })),
);

describe.skipIf(!HAS_EMULATORS)('verification stubs (Firestore emulator)', () => {
  beforeEach(async () => {
    await clearFirestore();
    for (const [id, name] of [
      ['school-a', 'Sunrise Public School'],
      ['school-b', 'Other School'],
    ] as const) {
      await db()
        .collection(COLLECTIONS.institutions)
        .doc(id)
        .set({
          name,
          adminUid: 'admin-1',
          staffUids: [id === 'school-a' ? 'staff-1' : 'staff-b'],
          creditBalance: 10,
          verified: true,
        } satisfies InstitutionDocument);
    }
    await db().collection(COLLECTIONS.templates).doc('tpl-cert').set({
      ownerUid: 'admin-1',
      institutionId: 'school-a',
      name: 'Class 10 certificate',
    });
  });

  it('mints one unguessable id per credential, each an unclaimed stub of the issuer', async () => {
    const ids = await mintStubs(
      db(),
      STAFF,
      parseMint({ credentialName: 'Class 10 certificate', recipientNames: ['Asha Rao', null, ''] }),
    );
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(VERIFICATION_ID_PATTERN);
    expect(await stub(ids[0]!)).toMatchObject({
      ownerKey: 'inst:school-a',
      issuerType: 'institution',
      issuerId: 'school-a',
      issuerName: 'Sunrise Public School',
      credentialName: 'Class 10 certificate',
      recipientName: 'Asha Rao',
      status: 'unclaimed',
      linkedBatchId: null,
    });
    expect((await stub(ids[1]!))!.recipientName).toBeNull();
    expect((await stub(ids[2]!))!.recipientName).toBeNull();
  });

  it('refuses a body that is empty, nameless or too big', () => {
    expect(() => parseMint({ credentialName: 'x', recipientNames: [] })).toThrow(StubError);
    expect(() => parseMint({ recipientNames: ['a'] })).toThrow(StubError);
    expect(() =>
      parseMint({ credentialName: 'x', recipientNames: Array(2_501).fill('a') }),
    ).toThrow(StubError);
  });

  it('a Micro-Issuer can mint too, and is shown generically', async () => {
    const [id] = await mintStubs(
      db(),
      MAKER,
      parseMint({ credentialName: 'Workshop', recipientNames: ['Ravi'] }),
    );
    expect(await stub(id!)).toMatchObject({
      ownerKey: 'uid:maker-1',
      issuerType: 'individual',
      issuerName: 'Independent issuer',
    });
  });

  it('the public page sees an unclaimed stub as issued-not-claimed, and nothing for other ids', async () => {
    const [id] = await mintStubs(
      db(),
      STAFF,
      parseMint({ credentialName: 'Class 10 certificate', recipientNames: ['Asha Rao'] }),
    );
    const seen = await findSharedCredential(db(), id!);
    expect(seen).toMatchObject({
      claimed: false,
      status: 'valid',
      credentialName: 'Class 10 certificate',
      issuerName: 'Sunrise Public School',
      issuerVerified: true,
      recipientName: 'Asha Rao',
    });
    expect(await findSharedCredential(db(), 'Z'.repeat(43))).toBeNull();
    // The Firestore document id of the stub is its id, but a made-up or malformed one finds nothing.
    expect(await findSharedCredential(db(), 'not-an-id')).toBeNull();
  });

  describe('linking to a dispatch', () => {
    it('only the issuer’s own, unclaimed, unlinked ids can be linked', async () => {
      const [mine] = await mintStubs(
        db(),
        STAFF,
        parseMint({ credentialName: 'C', recipientNames: ['A'] }),
      );
      const [theirs] = await mintStubs(
        db(),
        OTHER_SCHOOL,
        parseMint({ credentialName: 'C', recipientNames: ['B'] }),
      );
      await expect(assertStubsLinkable(db(), STAFF, [mine], 'b1')).resolves.toBeUndefined();
      await expect(
        assertStubsLinkable(db(), STAFF, [undefined, undefined], 'b1'),
      ).resolves.toBeUndefined();
      await expect(assertStubsLinkable(db(), STAFF, [theirs], 'b1')).rejects.toMatchObject({
        code: 'VERIFICATION_ID_INVALID',
      });
      await expect(assertStubsLinkable(db(), STAFF, ['Q'.repeat(43)], 'b1')).rejects.toMatchObject({
        code: 'VERIFICATION_ID_INVALID',
      });
    });

    it('a dispatch with a bad id is refused before anything is charged or sent', async () => {
      const [theirs] = await mintStubs(
        db(),
        OTHER_SCHOOL,
        parseMint({ credentialName: 'C', recipientNames: ['B'] }),
      );
      const send = vi.fn(sendAll);
      await expect(
        runDispatch({
          db: db(),
          user: STAFF,
          channel: 'whatsapp',
          request: whatsappRequest([theirs]),
          send,
        }),
      ).rejects.toMatchObject({ code: 'VERIFICATION_ID_INVALID' });
      expect(send).not.toHaveBeenCalled();
      expect(
        (await db().collection(COLLECTIONS.institutions).doc('school-a').get()).get(
          'creditBalance',
        ),
      ).toBe(10);
      expect((await db().collection(COLLECTIONS.claimTokens).get()).size).toBe(0);
    });

    it('carries the id from the QR code into the claim, so the paper keeps working', async () => {
      const [first, second] = await mintStubs(
        db(),
        STAFF,
        parseMint({ credentialName: 'Class 10 certificate', recipientNames: ['Asha Rao', 'Ravi'] }),
      );
      let raw = '';
      const send: DispatchSender<'whatsapp'> = async (targets) => {
        raw = targets[0]!.claimToken;
        return targets.map((_, index): TargetResult => ({
          index,
          status: 'sent',
          providerId: `w.${index}`,
        }));
      };
      const outcome = await runDispatch({
        db: db(),
        user: STAFF,
        channel: 'whatsapp',
        request: whatsappRequest([first, second]),
        send,
      });
      expect(outcome.sent).toBe(2);
      // Both stubs are now tied to the batch; a replay of the same dispatch is still accepted.
      expect((await stub(first!))!.linkedBatchId).toBe(outcome.batchId);
      expect((await stub(second!))!.linkedBatchId).toBe(outcome.batchId);
      const tokens = await db().collection(COLLECTIONS.claimTokens).get();
      expect(tokens.docs.map((doc) => doc.get('verificationId')).sort()).toEqual(
        [first, second].sort(),
      );
      // The same id cannot go to a different batch.
      await expect(
        runDispatch({
          db: db(),
          user: STAFF,
          channel: 'whatsapp',
          request: whatsappRequest([first], 'batch-0002'),
          send,
        }),
      ).rejects.toMatchObject({ code: 'VERIFICATION_ID_INVALID' });

      // Before the claim: scanning shows "issued, not yet claimed".
      expect(await findSharedCredential(db(), first!)).toMatchObject({ claimed: false });

      // Claim it (the recipient's contact is the phone the link went to).
      const doc = tokens.docs.find((d) => d.get('verificationId') === first)!;
      expect(doc.get('recipientName')).toBe('Student 0');
      const recipient: SessionUser = {
        uid: 'recipient-1',
        email: null,
        role: 'individual',
        institutionId: null,
        phoneNumber: `+${doc.get('contact')}`,
      };
      const claimed = await claimCredential({ db: db(), user: recipient, rawToken: raw });
      expect(claimed.alreadyClaimed).toBe(false);

      // The printed id now resolves to the vault item, shared from the start.
      const item = (
        await db().collection(COLLECTIONS.vaultItems).doc(claimed.vaultItemId).get()
      ).data()!;
      expect(item).toMatchObject({ shareId: first, mintedShareId: first, ownerUid: 'recipient-1' });
      expect(await stub(first!)).toMatchObject({
        status: 'claimed',
        vaultItemId: claimed.vaultItemId,
      });
      expect(await findSharedCredential(db(), first!)).toMatchObject({
        claimed: true,
        credentialName: 'Class 10 certificate',
        status: 'valid',
      });

      // The owner can stop sharing: the paper QR then says "not valid / stopped sharing".
      await setSharing(db(), recipient, claimed.vaultItemId, false);
      expect(await findSharedCredential(db(), first!)).toBeNull();
      // ...and turning it back on restores the SAME id rather than minting a new one.
      expect(await setSharing(db(), recipient, claimed.vaultItemId, true)).toEqual({
        shareId: first,
      });
      expect(await findSharedCredential(db(), first!)).toMatchObject({ claimed: true });
      // The other recipient's QR is untouched.
      expect(await findSharedCredential(db(), second!)).toMatchObject({ claimed: false });
    });
  });
});
