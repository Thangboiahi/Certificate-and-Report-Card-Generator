/**
 * Elevated roles as Firebase custom claims: granting, changing and verifying them.
 *
 * Claims are the source of truth for access — the proxy, server code and Firestore rules all read
 * them from verified tokens. The institution document's `adminUid`/`staffUids` are a directory
 * for display, kept in step here. Every change follows one ordering rule so that a failure part
 * way through can never leave someone with access they should not have:
 *
 *   1. add the user to the new institution's directory   (grants nothing by itself)
 *   2. swap the claims in one write                       (takes old access away, grants new)
 *   3. remove the user from the old institution's directory
 *   4. revoke existing sessions if any access was taken away
 *
 * A failure at any step leaves the user with at most the access they had before; calling again
 * completes the change (every step is idempotent).
 *
 * Server only: requires the Admin SDK and the service account's permission to manage users.
 */
import 'server-only';

import type { DecodedIdToken } from 'firebase-admin/auth';
import { FieldValue } from 'firebase-admin/firestore';

import { adminAuth, adminFirestore } from '@/lib/server/firebase-admin';
import {
  COLLECTIONS,
  type InstitutionDocument,
  type RoleAssignment,
  type RoleClaims,
  type SessionUser,
} from '@/types/roles';

import {
  isValidInstitutionId,
  mergeRoleClaims,
  parseRoleClaims,
  privilegesReduced,
  sameRoleClaims,
  toSessionUser,
  type VerifiedClaims,
} from './access';

export type RoleAssignmentErrorCode =
  'INVALID_ASSIGNMENT' | 'USER_NOT_FOUND' | 'INSTITUTION_NOT_FOUND' | 'ADMIN_ALREADY_ASSIGNED';

export class RoleAssignmentError extends Error {
  readonly code: RoleAssignmentErrorCode;

  constructor(code: RoleAssignmentErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RoleAssignmentError';
    this.code = code;
  }
}

export interface RoleChange {
  uid: string;
  previous: RoleClaims | null;
  current: RoleClaims | null;
  /**
   * True when access was taken away and the user's existing sessions were revoked. The user
   * must sign in again; privileged areas reject their old session immediately.
   */
  sessionsRevoked: boolean;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

async function getUserOrThrow(uid: string) {
  try {
    return await adminAuth().getUser(uid);
  } catch (error) {
    if (errorCode(error) === 'auth/user-not-found') {
      throw new RoleAssignmentError('USER_NOT_FOUND', `No user with uid "${uid}".`, {
        cause: error,
      });
    }
    throw error;
  }
}

function toRoleClaims(assignment: RoleAssignment): RoleClaims | null {
  switch (assignment.role) {
    case 'individual':
      return null;
    case 'super_admin':
      return { role: 'super_admin' };
    case 'inst_admin':
    case 'inst_staff':
      if (!isValidInstitutionId(assignment.institutionId)) {
        throw new RoleAssignmentError(
          'INVALID_ASSIGNMENT',
          'An institution role needs a valid institution id (letters, digits, "_" or "-").',
        );
      }
      return { role: assignment.role, institutionId: assignment.institutionId };
    default:
      throw new RoleAssignmentError('INVALID_ASSIGNMENT', 'Unknown role.');
  }
}

function institutionRef(institutionId: string) {
  return adminFirestore().collection(COLLECTIONS.institutions).doc(institutionId);
}

/** Step 1: list the user in their new institution. Fails if the institution does not exist. */
async function addToInstitutionDirectory(
  uid: string,
  claims: Extract<RoleClaims, { institutionId: string }>,
): Promise<void> {
  const ref = institutionRef(claims.institutionId);
  await adminFirestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      throw new RoleAssignmentError(
        'INSTITUTION_NOT_FOUND',
        `Institution "${claims.institutionId}" does not exist.`,
      );
    }
    const data = snapshot.data() as Partial<InstitutionDocument>;

    if (claims.role === 'inst_admin') {
      // One admin per institution: replacing an admin is an explicit two-step change.
      if (data.adminUid && data.adminUid !== uid) {
        throw new RoleAssignmentError(
          'ADMIN_ALREADY_ASSIGNED',
          `Institution "${claims.institutionId}" already has an admin. Remove them first.`,
        );
      }
      transaction.update(ref, { adminUid: uid, staffUids: FieldValue.arrayRemove(uid) });
    } else {
      transaction.update(ref, {
        staffUids: FieldValue.arrayUnion(uid),
        ...(data.adminUid === uid ? { adminUid: null } : {}),
      });
    }
  });
}

/** Step 3: remove the user from an institution's directory. A deleted institution is fine. */
async function removeFromInstitutionDirectory(uid: string, institutionId: string): Promise<void> {
  const ref = institutionRef(institutionId);
  await adminFirestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return;
    const data = snapshot.data() as Partial<InstitutionDocument>;
    transaction.update(ref, {
      staffUids: FieldValue.arrayRemove(uid),
      ...(data.adminUid === uid ? { adminUid: null } : {}),
    });
  });
}

const institutionOf = (claims: RoleClaims | null): string | null =>
  claims && claims.role !== 'super_admin' ? claims.institutionId : null;

/** The elevated role a user currently holds, or `null`. */
export async function getRoleClaims(uid: string): Promise<RoleClaims | null> {
  const user = await getUserOrThrow(uid);
  return parseRoleClaims(user.customClaims);
}

/**
 * Gives a user an elevated role, moves them between roles or institutions, or (with
 * `{ role: 'individual' }`) removes their elevated role. Other custom claims are preserved.
 * Idempotent: assigning the role a user already has changes nothing.
 */
export async function setUserRole(uid: string, assignment: RoleAssignment): Promise<RoleChange> {
  const next = toRoleClaims(assignment);
  const user = await getUserOrThrow(uid);
  const previous = parseRoleClaims(user.customClaims);
  if (sameRoleClaims(previous, next)) {
    return { uid, previous, current: next, sessionsRevoked: false };
  }

  const nextInstitution = institutionOf(next);
  const previousInstitution = institutionOf(previous);

  if (nextInstitution && next && next.role !== 'super_admin') {
    await addToInstitutionDirectory(uid, next);
  }

  await adminAuth().setCustomUserClaims(uid, mergeRoleClaims(user.customClaims, next));

  if (previousInstitution && previousInstitution !== nextInstitution) {
    await removeFromInstitutionDirectory(uid, previousInstitution);
  }

  const sessionsRevoked = privilegesReduced(previous, next);
  if (sessionsRevoked) {
    // Session cookies keep the claims they were minted with. Revoking makes every verification
    // that checks revocation (all privileged routes, session creation) reject them from now on.
    await adminAuth().revokeRefreshTokens(uid);
  }

  return { uid, previous, current: next, sessionsRevoked };
}

export function grantSuperAdmin(uid: string): Promise<RoleChange> {
  return setUserRole(uid, { role: 'super_admin' });
}

export function setInstitutionRole(
  uid: string,
  institutionId: string,
  role: 'inst_admin' | 'inst_staff',
): Promise<RoleChange> {
  return setUserRole(uid, { role, institutionId });
}

/** Removes any elevated role; the user remains an ordinary signed-in individual. */
export function removeElevatedRole(uid: string): Promise<RoleChange> {
  return setUserRole(uid, { role: 'individual' });
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Verification
// ───────────────────────────────────────────────────────────────────────────────────────────────

export interface VerifyOptions {
  /**
   * Also confirm with Firebase Auth that the session was not revoked and the user is not
   * disabled. One network call; use it wherever privileged access is decided.
   */
  checkRevoked: boolean;
}

/**
 * Whether an Admin SDK error means "this token is not acceptable" (expired, revoked, forged,
 * malformed, disabled user) as opposed to "verification could not be performed" (configuration
 * or network trouble). Only the first may be treated as "signed out".
 */
function isTokenRejection(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && code.startsWith('auth/') && code !== 'auth/internal-error';
}

/**
 * Verifies a session cookie and returns who it belongs to, or `null` if it is not valid.
 * Throws if verification itself could not be performed — callers must fail closed.
 */
export async function verifySessionCookie(
  cookie: string,
  options: VerifyOptions,
): Promise<SessionUser | null> {
  try {
    const decoded = await adminAuth().verifySessionCookie(cookie, options.checkRevoked);
    return toSessionUser(decoded as unknown as VerifiedClaims);
  } catch (error) {
    if (isTokenRejection(error)) return null;
    throw error;
  }
}

export interface VerifiedIdToken {
  user: SessionUser;
  /** When the user last actually signed in, in seconds since the epoch. */
  authTime: number;
  decoded: DecodedIdToken;
}

/**
 * Verifies a Firebase ID token (as sent by the browser after sign-in), or returns `null` if it
 * is not valid. Throws if verification itself could not be performed.
 */
export async function verifyIdToken(
  idToken: string,
  options: VerifyOptions,
): Promise<VerifiedIdToken | null> {
  try {
    const decoded = await adminAuth().verifyIdToken(idToken, options.checkRevoked);
    return {
      user: toSessionUser(decoded as unknown as VerifiedClaims),
      authTime: decoded.auth_time,
      decoded,
    };
  } catch (error) {
    if (isTokenRejection(error)) return null;
    throw error;
  }
}
