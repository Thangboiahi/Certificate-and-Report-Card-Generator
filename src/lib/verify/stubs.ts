/**
 * Pre-minted verification ids and their "unclaimed" stubs (Phase 14, ADR-035).
 *
 * A QR code printed on a certificate has to say where to verify it, but a credential only gets a
 * vault item when its recipient claims it. So the issuer's browser asks the server to MINT ids
 * first (`mintStubs`): each becomes `verification_stubs/{id}`, a record that the issuer produced a
 * credential, status `unclaimed`. The id goes into the row, onto the PDF as a QR code, and (if the
 * credential is also sent through a claim link) into the claim token, so that claiming adopts the
 * same id and the paper QR keeps working. Scanning an id that is still a stub shows "issued, not yet
 * claimed" instead of an error.
 *
 * Server-only (Admin SDK). Every function scopes itself to the caller's board key
 * (`inst:<id>` or `uid:<uid>`, the same as the request board).
 */
import 'server-only';

import {
  FieldValue,
  type DocumentSnapshot,
  type Firestore,
  type Timestamp,
  type WriteBatch,
} from 'firebase-admin/firestore';

import { ownerKeyOf } from '@/lib/crm/requests';
import { mintClaimToken } from '@/lib/utils/tokenManager';
import {
  COLLECTIONS,
  type InstitutionDocument,
  type IssuerType,
  type SessionUser,
} from '@/types/roles';

import { VERIFICATION_ID_PATTERN } from './ids';
import { MAX_MINT_PER_REQUEST } from './limits';

const WRITES_PER_BATCH = 450;
const MAX_NAME = 100;

export type StubStatus = 'unclaimed' | 'claimed' | 'revoked';

/** `verification_stubs/{id}`. */
export interface VerificationStubDocument {
  ownerKey: string;
  issuerType: IssuerType;
  issuerId: string;
  issuerName: string;
  credentialName: string;
  /** As printed on the document; `null` when the issuer chose not to record it. */
  recipientName: string | null;
  status: StubStatus;
  createdByUid: string;
  createdAt: Timestamp | FieldValue;
  /** The dispatch batch whose claim links carry this id (set when linked). */
  linkedBatchId?: string | null;
  claimedAt?: Timestamp | FieldValue;
  vaultItemId?: string;
  revokedAt?: Timestamp | FieldValue | null;
}

export class StubError extends Error {
  constructor(
    readonly code: 'INVALID' | 'VERIFICATION_ID_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'StubError';
  }
}

export interface MintInput {
  credentialName: string;
  /** One entry per credential, in the order the ids come back; `null` = do not record a name. */
  recipientNames: (string | null)[];
}

function clean(value: unknown, field: string, max: number, required: boolean): string | null {
  if (value === null || value === undefined || value === '') {
    if (required) throw new StubError('INVALID', `${field} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw new StubError('INVALID', `${field} must be text.`);
  const text = value.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
  if (!text) {
    if (required) throw new StubError('INVALID', `${field} is required.`);
    return null;
  }
  if (text.length > max)
    throw new StubError('INVALID', `${field} is longer than ${max} characters.`);
  return text;
}

/** Checks an untrusted body: `{ credentialName, recipientNames: (string | null)[] }`. */
export function parseMint(body: unknown): MintInput {
  const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const credentialName = clean(raw.credentialName, 'Credential name', MAX_NAME, true)!;
  const names = raw.recipientNames;
  if (!Array.isArray(names) || names.length === 0) {
    throw new StubError('INVALID', 'List at least one credential to mint an id for.');
  }
  if (names.length > MAX_MINT_PER_REQUEST) {
    throw new StubError('INVALID', `Mint at most ${MAX_MINT_PER_REQUEST} ids at a time.`);
  }
  return {
    credentialName,
    recipientNames: names.map((name, index) =>
      clean(name, `Recipient ${index + 1}`, MAX_NAME, false),
    ),
  };
}

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

/** Who the verification page names as issuer. Institutions by their record, individuals generically. */
async function issuerOf(
  db: Firestore,
  user: SessionUser,
): Promise<{ issuerType: IssuerType; issuerId: string; issuerName: string }> {
  if ((user.role === 'inst_admin' || user.role === 'inst_staff') && user.institutionId) {
    const snapshot = await db.collection(COLLECTIONS.institutions).doc(user.institutionId).get();
    const institution = snapshot.data() as InstitutionDocument | undefined;
    return {
      issuerType: 'institution',
      issuerId: user.institutionId,
      issuerName: institution?.name ?? 'Institution',
    };
  }
  return { issuerType: 'individual', issuerId: user.uid, issuerName: 'Independent issuer' };
}

/**
 * Mints one id per credential and stores its unclaimed stub. Returns the ids in the order of
 * `recipientNames`. Ids are 256 random bits, so they cannot be guessed or enumerated.
 */
export async function mintStubs(
  db: Firestore,
  user: SessionUser,
  input: MintInput,
): Promise<string[]> {
  const ownerKey = ownerKeyOf(user);
  const issuer = await issuerOf(db, user);
  const ids = input.recipientNames.map(() => mintClaimToken());
  await commitInChunks(
    db,
    ids.map((id, index) => (writes: WriteBatch) => {
      writes.create(db.collection(COLLECTIONS.verificationStubs).doc(id), {
        ownerKey,
        ...issuer,
        credentialName: input.credentialName,
        recipientName: input.recipientNames[index] ?? null,
        status: 'unclaimed',
        createdByUid: user.uid,
        createdAt: FieldValue.serverTimestamp(),
        linkedBatchId: null,
      } satisfies VerificationStubDocument);
    }),
  );
  return ids;
}

/**
 * Before a dispatch: every id must be a stub of the caller's own, still unclaimed, and not already
 * linked to a different batch. Throws `StubError('VERIFICATION_ID_INVALID')` naming the recipient.
 */
export async function assertStubsLinkable(
  db: Firestore,
  user: SessionUser,
  ids: readonly (string | undefined)[],
  batchId: string,
): Promise<void> {
  const ownerKey = ownerKeyOf(user);
  const wanted = ids.flatMap((id, index) => (id === undefined ? [] : [{ id, index }]));
  if (wanted.length === 0) return;
  const refs = wanted.map(({ id }) => db.collection(COLLECTIONS.verificationStubs).doc(id));
  const snapshots: DocumentSnapshot[] = await db.getAll(...refs);
  snapshots.forEach((snapshot, position) => {
    const { index } = wanted[position]!;
    const stub = snapshot.data() as VerificationStubDocument | undefined;
    const usable =
      stub !== undefined &&
      stub.ownerKey === ownerKey &&
      stub.status === 'unclaimed' &&
      (stub.linkedBatchId == null || stub.linkedBatchId === batchId);
    if (!usable) {
      throw new StubError(
        'VERIFICATION_ID_INVALID',
        `Recipient ${index + 1} has a verification id that is unknown, already used or not yours.`,
      );
    }
  });
}

/** Marks stubs as carried by a batch's claim links, so one id cannot go to two recipients. */
export function linkStub(db: Firestore, writes: WriteBatch, id: string, batchId: string): void {
  writes.update(db.collection(COLLECTIONS.verificationStubs).doc(id), { linkedBatchId: batchId });
}

/** A stub as the verification page needs it, or `null` (unknown id, malformed id, claimed). */
export async function findUnclaimedStub(
  db: Firestore,
  id: string,
): Promise<(VerificationStubDocument & { issuerVerified: boolean }) | null> {
  if (!VERIFICATION_ID_PATTERN.test(id)) return null;
  const snapshot = await db.collection(COLLECTIONS.verificationStubs).doc(id).get();
  const stub = snapshot.data() as VerificationStubDocument | undefined;
  // A claimed stub is represented by the recipient's vault item: if that is no longer shared,
  // this id must not resolve either.
  if (!stub || stub.status === 'claimed') return null;
  let issuerVerified = false;
  if (stub.issuerType === 'institution') {
    const institution = await db.collection(COLLECTIONS.institutions).doc(stub.issuerId).get();
    issuerVerified = institution.get('verified') === true;
  }
  return { ...stub, issuerVerified };
}
