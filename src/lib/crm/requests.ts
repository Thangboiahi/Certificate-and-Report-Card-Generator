/**
 * Credential requests in Firestore (Phase 12, ADR-033): the data behind the Kanban board.
 * Server-only (Admin SDK); every function scopes itself to the caller, so one institution can never
 * see or move another's cards:
 *
 *   institution staff and admins → the institution's board   (`ownerKey` = `inst:<institutionId>`)
 *   everyone else (Micro-Issuer) → their own board           (`ownerKey` = `uid:<uid>`)
 *
 * Reads use a single equality filter and sort in memory, so no composite index is needed.
 */
import 'server-only';

import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';

import { evenOrders, needsRebalance, orderForIndex, ORDER_STEP } from '@/lib/crm/order';
import { REQUEST_STAGES, type CredentialRequest, type RequestStage } from '@/types/crm';
import { COLLECTIONS, type SessionUser } from '@/types/roles';

/** Most cards one board returns; older issued cards are left out. */
const BOARD_LIMIT = 500;

export class RequestError extends Error {
  constructor(
    readonly code: 'INVALID' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

/** Whose board a user sees. */
export function ownerKeyOf(user: Pick<SessionUser, 'uid' | 'role' | 'institutionId'>): string {
  const institutional =
    (user.role === 'inst_admin' || user.role === 'inst_staff') && user.institutionId;
  return institutional ? `inst:${user.institutionId}` : `uid:${user.uid}`;
}

interface StoredRequest {
  ownerKey: string;
  stage: RequestStage;
  order: number;
  recipientName: string;
  credential: string;
  email?: string;
  phone?: string;
  note?: string;
  createdByUid: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

function toRequest(id: string, data: StoredRequest): CredentialRequest {
  return {
    id,
    stage: data.stage,
    recipientName: data.recipientName,
    credential: data.credential,
    ...(data.email ? { email: data.email } : {}),
    ...(data.phone ? { phone: data.phone } : {}),
    ...(data.note ? { note: data.note } : {}),
    updatedAt: data.updatedAt?.toMillis() ?? 0,
  };
}

function isStage(value: unknown): value is RequestStage {
  return typeof value === 'string' && (REQUEST_STAGES as readonly string[]).includes(value);
}

/** The board, in stage order then card order. */
export async function listRequests(db: Firestore, user: SessionUser): Promise<CredentialRequest[]> {
  const snapshot = await db
    .collection(COLLECTIONS.credentialRequests)
    .where('ownerKey', '==', ownerKeyOf(user))
    .limit(BOARD_LIMIT)
    .get();
  return snapshot.docs
    .map((doc) => ({ doc, data: doc.data() as StoredRequest }))
    .sort((a, b) => a.data.order - b.data.order)
    .map(({ doc, data }) => toRequest(doc.id, data));
}

export interface NewRequestInput {
  recipientName: string;
  credential: string;
  email?: string;
  phone?: string;
  note?: string;
}

function text(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new RequestError('INVALID', `${field} is required.`);
    return undefined;
  }
  if (typeof value !== 'string') throw new RequestError('INVALID', `${field} must be text.`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new RequestError('INVALID', `${field} is required.`);
    return undefined;
  }
  if (trimmed.length > max) throw new RequestError('INVALID', `${field} is too long.`);
  return trimmed;
}

/** Checks an untrusted body; throws `RequestError('INVALID')` with a message fit for the person. */
export function parseNewRequest(body: unknown): NewRequestInput {
  if (typeof body !== 'object' || body === null) {
    throw new RequestError('INVALID', 'Send the request details.');
  }
  const raw = body as Record<string, unknown>;
  const recipientName = text(raw.recipientName, 'Recipient name', 120, true)!;
  const credential = text(raw.credential, 'Credential', 120, true)!;
  const email = text(raw.email, 'Email', 254, false);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new RequestError('INVALID', 'That email address does not look right.');
  }
  const phone = text(raw.phone, 'Phone', 20, false);
  if (phone && !/^\+?[0-9 ()-]{7,20}$/.test(phone)) {
    throw new RequestError('INVALID', 'That phone number does not look right.');
  }
  const note = text(raw.note, 'Note', 200, false);
  return {
    recipientName,
    credential,
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(note ? { note } : {}),
  };
}

/** Adds a card to the top of "New Requests". */
export async function createRequest(
  db: Firestore,
  user: SessionUser,
  input: NewRequestInput,
): Promise<CredentialRequest> {
  const ownerKey = ownerKeyOf(user);
  const collection = db.collection(COLLECTIONS.credentialRequests);
  const ref = collection.doc();
  const now = Timestamp.now();
  const stored = await db.runTransaction(async (transaction) => {
    const column = await transaction.get(
      collection.where('ownerKey', '==', ownerKey).where('stage', '==', 'new').limit(BOARD_LIMIT),
    );
    const orders = column.docs.map((doc) => (doc.data() as StoredRequest).order);
    const order = orders.length > 0 ? Math.min(...orders) - ORDER_STEP : 0;
    const data: StoredRequest = {
      ownerKey,
      stage: 'new',
      order,
      ...input,
      createdByUid: user.uid,
      createdAt: now,
      updatedAt: now,
    };
    transaction.create(ref, data);
    return data;
  });
  return toRequest(ref.id, stored);
}

export interface MoveInput {
  id: string;
  to: RequestStage;
  toIndex: number;
}

export function parseMove(body: unknown): MoveInput {
  const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const { id, to, toIndex } = raw;
  if (typeof id !== 'string' || id.length === 0 || id.length > 128 || id.includes('/')) {
    throw new RequestError('INVALID', 'Which request moved?');
  }
  if (!isStage(to)) throw new RequestError('INVALID', 'Unknown column.');
  if (
    typeof toIndex !== 'number' ||
    !Number.isInteger(toIndex) ||
    toIndex < 0 ||
    toIndex > 10_000
  ) {
    throw new RequestError('INVALID', 'Unknown position.');
  }
  return { id, to, toIndex };
}

/** Moves a card to a column and position. Only the owner's own cards can be found. */
export async function moveRequest(
  db: Firestore,
  user: SessionUser,
  move: MoveInput,
): Promise<void> {
  const ownerKey = ownerKeyOf(user);
  const collection = db.collection(COLLECTIONS.credentialRequests);
  const ref = collection.doc(move.id);
  await db.runTransaction(async (transaction) => {
    const [card, column] = await Promise.all([
      transaction.get(ref),
      transaction.get(
        collection
          .where('ownerKey', '==', ownerKey)
          .where('stage', '==', move.to)
          .limit(BOARD_LIMIT),
      ),
    ]);
    if (!card.exists || card.get('ownerKey') !== ownerKey) {
      throw new RequestError('NOT_FOUND', 'That request no longer exists.');
    }
    const others = column.docs
      .filter((doc) => doc.id !== move.id)
      .sort((a, b) => (a.data() as StoredRequest).order - (b.data() as StoredRequest).order);
    const orders = others.map((doc) => (doc.data() as StoredRequest).order);
    const now = FieldValue.serverTimestamp();
    if (needsRebalance(orders)) {
      // Repeated midpoints have run out of precision: respace the column, then place the card.
      const spaced = evenOrders(others.length + 1);
      const position = Math.min(move.toIndex, others.length);
      let next = 0;
      others.forEach((doc) => {
        if (next === position) next++;
        transaction.update(doc.ref, { order: spaced[next++] });
      });
      transaction.update(ref, { stage: move.to, order: spaced[position], updatedAt: now });
      return;
    }
    transaction.update(ref, {
      stage: move.to,
      order: orderForIndex(orders, move.toIndex),
      updatedAt: now,
    });
  });
}
