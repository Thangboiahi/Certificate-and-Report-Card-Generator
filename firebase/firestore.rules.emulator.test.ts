/**
 * Firestore security rules, tested against the Firestore emulator.
 *
 *     npm run test:emulator
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  type Firestore,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

import { HAS_EMULATORS, PROJECT_ID } from '../tests/support/firebase-emulator';

let env: RulesTestEnvironment;

/** A signed-in user with an account (not anonymous), optionally with role claims. */
function as(uid: string, claims: Record<string, unknown> = {}): Firestore {
  return env
    .authenticatedContext(uid, { firebase: { sign_in_provider: 'google.com' }, ...claims })
    .firestore() as unknown as Firestore;
}

const anonymous = (claims: Record<string, unknown> = {}) =>
  env
    .authenticatedContext('guest-1', { firebase: { sign_in_provider: 'anonymous' }, ...claims })
    .firestore() as unknown as Firestore;
const signedOut = () => env.unauthenticatedContext().firestore() as unknown as Firestore;

const superAdmin = () => as('root', { role: 'super_admin' });
const adminOf = (inst: string, uid = `admin-${inst}`) =>
  as(uid, { role: 'inst_admin', institutionId: inst });
const staffOf = (inst: string, uid = `staff-${inst}`) =>
  as(uid, { role: 'inst_staff', institutionId: inst });
const individual = (uid = 'alice') => as(uid);

const institution = (overrides: Record<string, unknown> = {}) => ({
  name: 'Sunrise Public School',
  adminUid: 'admin-A',
  staffUids: ['staff-A'],
  creditBalance: 500,
  verified: true,
  ...overrides,
});

const template = (
  ownerUid: string,
  institutionId: string | null,
  overrides: Record<string, unknown> = {},
) => ({
  ownerUid,
  institutionId,
  name: 'Certificate of merit',
  definition: { schemaVersion: 1 },
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
  ...overrides,
});

const vaultItem = (overrides: Record<string, unknown> = {}) => ({
  ownerUid: 'student-1',
  templateId: 'tpl-A',
  issuerId: 'A',
  issuerType: 'institution',
  issuedAt: serverTimestamp(),
  expiresAt: null,
  status: 'valid',
  revokedAt: null,
  ...overrides,
});

async function seed(path: string, data: Record<string, unknown>): Promise<void> {
  await env.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore() as unknown as Firestore, path), data);
  });
}

describe.skipIf(!HAS_EMULATORS)('firestore.rules', () => {
  beforeAll(async () => {
    const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8085').split(':');
    env = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: readFileSync(join(process.cwd(), 'firebase', 'firestore.rules'), 'utf8'),
        host,
        port: Number(port),
      },
    });
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  beforeEach(async () => {
    await env.clearFirestore();
    const now = Timestamp.now();
    await seed('institutions/A', institution());
    await seed(
      'institutions/B',
      institution({ name: 'Other School', adminUid: 'admin-B', staffUids: ['staff-B'] }),
    );
    await seed('templates/tpl-A', { ...template('admin-A', 'A'), createdAt: now, updatedAt: now });
    await seed('templates/tpl-B', { ...template('admin-B', 'B'), createdAt: now, updatedAt: now });
    await seed('templates/tpl-alice', {
      ...template('alice', null),
      createdAt: now,
      updatedAt: now,
    });
    await seed('vault_items/item-A', { ...vaultItem(), issuedAt: now });
    await seed('vault_items/item-alice', {
      ...vaultItem({
        issuerId: 'alice',
        issuerType: 'individual',
        templateId: 'tpl-alice',
        ownerUid: 'bob',
      }),
      issuedAt: now,
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────

  describe('institutions', () => {
    it('can be read by its own staff and admin, and by super admins', async () => {
      await assertSucceeds(getDoc(doc(staffOf('A'), 'institutions/A')));
      await assertSucceeds(getDoc(doc(adminOf('A'), 'institutions/A')));
      await assertSucceeds(getDoc(doc(superAdmin(), 'institutions/A')));
    });

    it('cannot be read by anyone else', async () => {
      await assertFails(getDoc(doc(staffOf('B'), 'institutions/A')));
      await assertFails(getDoc(doc(adminOf('B'), 'institutions/A')));
      await assertFails(getDoc(doc(individual(), 'institutions/A')));
      await assertFails(getDoc(doc(signedOut(), 'institutions/A')));
      // A claim without its institution, or on an anonymous session, counts for nothing.
      await assertFails(getDoc(doc(as('x', { role: 'inst_staff' }), 'institutions/A')));
      await assertFails(
        getDoc(doc(anonymous({ role: 'inst_staff', institutionId: 'A' }), 'institutions/A')),
      );
      await assertFails(getDoc(doc(anonymous({ role: 'super_admin' }), 'institutions/A')));
    });

    it('can be written only by super admins, and only in the right shape', async () => {
      await assertSucceeds(
        setDoc(doc(superAdmin(), 'institutions/C'), institution({ adminUid: null, staffUids: [] })),
      );
      await assertSucceeds(
        updateDoc(doc(superAdmin(), 'institutions/A'), { creditBalance: 1000, verified: false }),
      );
      await assertFails(updateDoc(doc(superAdmin(), 'institutions/A'), { creditBalance: -1 }));
      await assertFails(updateDoc(doc(superAdmin(), 'institutions/A'), { creditBalance: 10.5 }));
      await assertFails(updateDoc(doc(superAdmin(), 'institutions/A'), { owner: 'someone' }));
      await assertFails(setDoc(doc(superAdmin(), 'institutions/D'), { name: 'Incomplete' }));
      await assertSucceeds(deleteDoc(doc(superAdmin(), 'institutions/B')));
    });

    it('accepts a Razorpay Linked Account id from super admins only, in the right format', async () => {
      await assertSucceeds(
        updateDoc(doc(superAdmin(), 'institutions/A'), { razorpayAccountId: 'acc_IRQWUleX4BqvYn' }),
      );
      await assertSucceeds(
        updateDoc(doc(superAdmin(), 'institutions/A'), { razorpayAccountId: null }),
      );
      await assertSucceeds(
        setDoc(doc(superAdmin(), 'institutions/F'), {
          ...institution({ adminUid: null, staffUids: [] }),
          razorpayAccountId: 'acc_IROu8Nod6PXPtZ',
        }),
      );
      for (const bad of [
        'IRQWUleX4BqvYn',
        'acc_',
        'acc_short',
        'acc_IRQWUleX4BqvYn ',
        'pay_IRQWUleX4BqvYn',
        42,
      ]) {
        await assertFails(
          updateDoc(doc(superAdmin(), 'institutions/A'), { razorpayAccountId: bad }),
        );
      }
      // Redirecting the institution's payouts to another account is a super-admin action only.
      await assertFails(
        updateDoc(doc(adminOf('A'), 'institutions/A'), {
          razorpayAccountId: 'acc_AttackerAcc0001',
        }),
      );
      await assertFails(
        updateDoc(doc(staffOf('A'), 'institutions/A'), {
          razorpayAccountId: 'acc_AttackerAcc0001',
        }),
      );
    });

    it('cannot be changed by its own admin or staff — not even the credit balance', async () => {
      await assertFails(updateDoc(doc(adminOf('A'), 'institutions/A'), { creditBalance: 999999 }));
      await assertFails(updateDoc(doc(adminOf('A'), 'institutions/A'), { name: 'Renamed' }));
      await assertFails(
        updateDoc(doc(staffOf('A'), 'institutions/A'), { staffUids: ['staff-A', 'friend'] }),
      );
      await assertFails(deleteDoc(doc(adminOf('A'), 'institutions/A')));
      await assertFails(setDoc(doc(individual(), 'institutions/E'), institution()));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────

  describe('templates', () => {
    it('lets a Micro-Issuer create, edit and delete their own personal templates', async () => {
      const alice = individual('alice');
      await assertSucceeds(setDoc(doc(alice, 'templates/new-personal'), template('alice', null)));
      await assertSucceeds(
        updateDoc(doc(alice, 'templates/tpl-alice'), {
          name: 'Renamed',
          updatedAt: serverTimestamp(),
        }),
      );
      await assertSucceeds(deleteDoc(doc(alice, 'templates/tpl-alice')));
    });

    it('keeps personal templates private to their owner (and super admins)', async () => {
      await assertSucceeds(getDoc(doc(individual('alice'), 'templates/tpl-alice')));
      await assertSucceeds(getDoc(doc(superAdmin(), 'templates/tpl-alice')));
      await assertFails(getDoc(doc(individual('bob'), 'templates/tpl-alice')));
      await assertFails(getDoc(doc(staffOf('A'), 'templates/tpl-alice')));
      await assertFails(
        updateDoc(doc(individual('bob'), 'templates/tpl-alice'), {
          name: 'Mine now',
          updatedAt: serverTimestamp(),
        }),
      );
      await assertFails(deleteDoc(doc(individual('bob'), 'templates/tpl-alice')));
    });

    it('refuses templates created in someone else’s name, or by a guest', async () => {
      await assertFails(setDoc(doc(individual('bob'), 'templates/x'), template('alice', null)));
      await assertFails(setDoc(doc(anonymous(), 'templates/x'), template('guest-1', null)));
      await assertFails(setDoc(doc(signedOut(), 'templates/x'), template('nobody', null)));
    });

    it('lets only the institution’s admin manage institution templates; staff can read them', async () => {
      await assertSucceeds(setDoc(doc(adminOf('A'), 'templates/new-A'), template('admin-A', 'A')));
      await assertSucceeds(
        updateDoc(doc(adminOf('A'), 'templates/tpl-A'), {
          name: 'Merit 2026',
          updatedAt: serverTimestamp(),
        }),
      );
      await assertSucceeds(getDoc(doc(staffOf('A'), 'templates/tpl-A')));

      await assertFails(
        setDoc(doc(staffOf('A', 'staff-A'), 'templates/staff-made'), template('staff-A', 'A')),
      );
      await assertFails(
        updateDoc(doc(staffOf('A'), 'templates/tpl-A'), {
          name: 'Staff edit',
          updatedAt: serverTimestamp(),
        }),
      );
      await assertFails(deleteDoc(doc(staffOf('A'), 'templates/tpl-A')));
      await assertFails(setDoc(doc(adminOf('B'), 'templates/into-A'), template('admin-B', 'A')));
      await assertFails(getDoc(doc(staffOf('B'), 'templates/tpl-A')));
      await assertFails(
        setDoc(doc(individual('alice'), 'templates/claims-A'), template('alice', 'A')),
      );
    });

    it('never lets ownership or creation time change', async () => {
      const alice = individual('alice');
      const later = { updatedAt: serverTimestamp() };
      await assertFails(
        updateDoc(doc(alice, 'templates/tpl-alice'), { ...later, ownerUid: 'bob' }),
      );
      await assertFails(
        updateDoc(doc(alice, 'templates/tpl-alice'), { ...later, institutionId: 'A' }),
      );
      await assertFails(
        updateDoc(doc(alice, 'templates/tpl-alice'), {
          ...later,
          createdAt: Timestamp.fromMillis(0),
        }),
      );
      await assertFails(
        updateDoc(doc(adminOf('A'), 'templates/tpl-A'), { ...later, institutionId: null }),
      );
      // Timestamps come from the server.
      await assertFails(
        updateDoc(doc(alice, 'templates/tpl-alice'), {
          name: 'x',
          updatedAt: Timestamp.fromMillis(0),
        }),
      );
      await assertFails(
        setDoc(
          doc(alice, 'templates/backdated'),
          template('alice', null, { createdAt: Timestamp.fromMillis(0) }),
        ),
      );
    });

    it('rejects documents of the wrong shape', async () => {
      const alice = individual('alice');
      await assertFails(
        setDoc(doc(alice, 'templates/a'), template('alice', null, { definition: 'not a map' })),
      );
      await assertFails(
        setDoc(doc(alice, 'templates/b'), template('alice', null, { extra: true })),
      );
      const withoutInstitution: Record<string, unknown> = template('alice', null);
      delete withoutInstitution.institutionId;
      await assertFails(setDoc(doc(alice, 'templates/c'), withoutInstitution));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────

  describe('vault_items', () => {
    it('lets institution staff and admins issue with their institution’s templates', async () => {
      await assertSucceeds(setDoc(doc(staffOf('A'), 'vault_items/new-1'), vaultItem()));
      await assertSucceeds(
        setDoc(
          doc(adminOf('A'), 'vault_items/new-2'),
          vaultItem({ expiresAt: Timestamp.fromMillis(Date.now() + 86_400_000) }),
        ),
      );
    });

    it('lets a Micro-Issuer issue under their own uid with their own template', async () => {
      await assertSucceeds(
        setDoc(
          doc(individual('alice'), 'vault_items/new-3'),
          vaultItem({ issuerId: 'alice', issuerType: 'individual', templateId: 'tpl-alice' }),
        ),
      );
    });

    it('refuses issuing in someone else’s name or with someone else’s template', async () => {
      await assertFails(setDoc(doc(staffOf('B'), 'vault_items/x1'), vaultItem()));
      await assertFails(
        setDoc(doc(staffOf('A'), 'vault_items/x2'), vaultItem({ templateId: 'tpl-B' })),
      );
      await assertFails(
        setDoc(doc(staffOf('A'), 'vault_items/x3'), vaultItem({ templateId: 'tpl-alice' })),
      );
      await assertFails(
        setDoc(doc(staffOf('A'), 'vault_items/x4'), vaultItem({ templateId: 'no-such-template' })),
      );
      await assertFails(
        setDoc(
          doc(individual('bob'), 'vault_items/x5'),
          vaultItem({ issuerId: 'alice', issuerType: 'individual', templateId: 'tpl-alice' }),
        ),
      );
      await assertFails(
        setDoc(
          doc(individual('alice'), 'vault_items/x6'),
          vaultItem({ issuerId: 'alice', issuerType: 'individual', templateId: 'tpl-A' }),
        ),
      );
      await assertFails(
        setDoc(
          doc(individual('alice'), 'vault_items/x7'),
          vaultItem({ issuerId: 'alice', issuerType: 'institution' }),
        ),
      );
      await assertFails(
        setDoc(
          doc(anonymous(), 'vault_items/x8'),
          vaultItem({ issuerId: 'guest-1', issuerType: 'individual' }),
        ),
      );
    });

    it('refuses backdated, pre-revoked, already-expired or oddly-shaped credentials', async () => {
      const staff = staffOf('A');
      await assertFails(
        setDoc(doc(staff, 'vault_items/y1'), vaultItem({ issuedAt: Timestamp.fromMillis(0) })),
      );
      await assertFails(setDoc(doc(staff, 'vault_items/y2'), vaultItem({ status: 'revoked' })));
      await assertFails(
        setDoc(doc(staff, 'vault_items/y3'), vaultItem({ revokedAt: serverTimestamp() })),
      );
      await assertFails(
        setDoc(
          doc(staff, 'vault_items/y4'),
          vaultItem({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) }),
        ),
      );
      await assertFails(setDoc(doc(staff, 'vault_items/y5'), vaultItem({ grade: 'A+' })));
      await assertFails(setDoc(doc(staff, 'vault_items/y6'), vaultItem({ ownerUid: '' })));
    });

    it('can be read by its recipient and its issuer only', async () => {
      await assertSucceeds(getDoc(doc(individual('student-1'), 'vault_items/item-A')));
      await assertSucceeds(getDoc(doc(staffOf('A'), 'vault_items/item-A')));
      await assertSucceeds(getDoc(doc(individual('bob'), 'vault_items/item-alice')));
      await assertSucceeds(getDoc(doc(individual('alice'), 'vault_items/item-alice')));
      await assertSucceeds(getDoc(doc(superAdmin(), 'vault_items/item-A')));

      await assertFails(getDoc(doc(individual('student-2'), 'vault_items/item-A')));
      await assertFails(getDoc(doc(staffOf('B'), 'vault_items/item-A')));
      await assertFails(getDoc(doc(signedOut(), 'vault_items/item-A')));
      await assertFails(getDoc(doc(anonymous(), 'vault_items/item-alice')));
    });

    it('lets the issuer revoke — once, and nothing else', async () => {
      const revoke = { status: 'revoked', revokedAt: serverTimestamp() };
      await assertFails(updateDoc(doc(individual('student-1'), 'vault_items/item-A'), revoke));
      await assertFails(updateDoc(doc(staffOf('B'), 'vault_items/item-A'), revoke));
      await assertFails(
        updateDoc(doc(staffOf('A'), 'vault_items/item-A'), { ...revoke, ownerUid: 'student-2' }),
      );
      await assertFails(
        updateDoc(doc(staffOf('A'), 'vault_items/item-A'), {
          status: 'revoked',
          revokedAt: Timestamp.fromMillis(0),
        }),
      );
      await assertFails(
        updateDoc(doc(staffOf('A'), 'vault_items/item-A'), {
          expiresAt: Timestamp.fromMillis(Date.now() + 1e9),
        }),
      );

      await assertSucceeds(updateDoc(doc(staffOf('A'), 'vault_items/item-A'), revoke));
      // Revocation is one-way.
      await assertFails(
        updateDoc(doc(adminOf('A'), 'vault_items/item-A'), { status: 'valid', revokedAt: null }),
      );
      await assertSucceeds(updateDoc(doc(individual('alice'), 'vault_items/item-alice'), revoke));
    });

    it('can never be deleted', async () => {
      await assertFails(deleteDoc(doc(staffOf('A'), 'vault_items/item-A')));
      await assertFails(deleteDoc(doc(adminOf('A'), 'vault_items/item-A')));
      await assertFails(deleteDoc(doc(individual('student-1'), 'vault_items/item-A')));
      await assertFails(deleteDoc(doc(superAdmin(), 'vault_items/item-A')));
    });
  });

  describe('dispatches', () => {
    it('are closed to every client, including the institution and super admins', async () => {
      await seed('dispatches/d-1', { institutionId: 'A', channel: 'email', creditsCharged: 3 });
      for (const db of [adminOf('A'), staffOf('A'), superAdmin(), individual('alice')]) {
        await assertFails(getDoc(doc(db, 'dispatches/d-1')));
        await assertFails(setDoc(doc(db, 'dispatches/d-2'), { institutionId: 'A' }));
        await assertFails(updateDoc(doc(db, 'dispatches/d-1'), { creditsRefunded: 3 }));
      }
    });

    it('audit ledger and claim tokens are closed to every client too', async () => {
      await seed('issued_batches/b-1', { institutionId: 'A', issuerUid: 'staff-A' });
      await seed('claim_tokens/t-1', { batchId: 'b-1', institutionId: 'A', contact: '9198' });
      for (const db of [adminOf('A'), staffOf('A'), superAdmin(), individual('alice')]) {
        await assertFails(getDoc(doc(db, 'issued_batches/b-1')));
        await assertFails(getDoc(doc(db, 'claim_tokens/t-1')));
        await assertFails(updateDoc(doc(db, 'issued_batches/b-1'), { reissueCount: 0 }));
        await assertFails(updateDoc(doc(db, 'claim_tokens/t-1'), { claimedAt: null }));
        await assertFails(setDoc(doc(db, 'claim_tokens/t-2'), { batchId: 'b-1' }));
        await assertFails(deleteDoc(doc(db, 'claim_tokens/t-1')));
      }
    });

    it('pay-to-claim orders are closed to every client, including their payer', async () => {
      await seed('claim_orders/order_JJCYnu3hipocHz', {
        uid: 'bob',
        tokenId: 't-1',
        status: 'created',
        amount: 2000,
      });
      for (const db of [individual('bob'), adminOf('A'), staffOf('A'), superAdmin(), signedOut()]) {
        await assertFails(getDoc(doc(db, 'claim_orders/order_JJCYnu3hipocHz')));
        await assertFails(
          updateDoc(doc(db, 'claim_orders/order_JJCYnu3hipocHz'), { status: 'paid' }),
        );
        await assertFails(setDoc(doc(db, 'claim_orders/order_Forged00000001'), { uid: 'bob' }));
        await assertFails(deleteDoc(doc(db, 'claim_orders/order_JJCYnu3hipocHz')));
      }
    });

    it('credential requests (the Kanban) are closed to every client', async () => {
      await seed('credential_requests/r-1', {
        ownerKey: 'inst:A',
        stage: 'new',
        recipientName: 'Asha',
      });
      for (const db of [
        adminOf('A'),
        staffOf('A'),
        superAdmin(),
        individual('alice'),
        signedOut(),
      ]) {
        await assertFails(getDoc(doc(db, 'credential_requests/r-1')));
        await assertFails(updateDoc(doc(db, 'credential_requests/r-1'), { stage: 'issued' }));
        await assertFails(setDoc(doc(db, 'credential_requests/r-2'), { ownerKey: 'inst:A' }));
        await assertFails(deleteDoc(doc(db, 'credential_requests/r-1')));
      }
    });

    it('cannot be used to change credits from the browser', async () => {
      await assertFails(updateDoc(doc(adminOf('A'), 'institutions/A'), { creditBalance: 1000 }));
    });
  });

  it('denies every other collection', async () => {
    await assertFails(getDoc(doc(superAdmin(), 'users/root')));
    await assertFails(setDoc(doc(superAdmin(), 'anything/else'), { a: 1 }));
  });
});
