/**
 * Roles, sessions and route protection against the real Firebase Auth and Firestore emulators:
 * real users, real custom claims, real session cookies, real revocation.
 *
 *     npm run test:emulator
 */
import { NextRequest } from 'next/server';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DELETE, POST } from '@/app/api/auth/session/route';
import { proxy } from '@/proxy';
import { adminAuth, adminFirestore } from '@/lib/server/firebase-admin';
import { COLLECTIONS, type InstitutionDocument } from '@/types/roles';

import {
  clearAuth,
  clearFirestore,
  createUser,
  HAS_EMULATORS,
  nextSecond,
  signIn,
  signInAnonymously,
  type EmulatorUser,
} from '../../../tests/support/firebase-emulator';
import {
  getRoleClaims,
  grantSuperAdmin,
  removeElevatedRole,
  RoleAssignmentError,
  setInstitutionRole,
  setUserRole,
  verifySessionCookie,
} from './customClaims';
import { createSession } from './session';
import { SESSION_COOKIE } from './session-cookie';

const ORIGIN = 'http://localhost:3000';

async function createInstitution(id: string, overrides: Partial<InstitutionDocument> = {}) {
  const institution: InstitutionDocument = {
    name: `Institution ${id}`,
    adminUid: null,
    staffUids: [],
    creditBalance: 100,
    verified: true,
    ...overrides,
  };
  await adminFirestore().collection(COLLECTIONS.institutions).doc(id).set(institution);
}

async function readInstitution(id: string): Promise<InstitutionDocument> {
  const snapshot = await adminFirestore().collection(COLLECTIONS.institutions).doc(id).get();
  return snapshot.data() as InstitutionDocument;
}

/** Signs in afresh and exchanges the token for a session cookie, as the browser would. */
async function sessionFor(user: EmulatorUser): Promise<string> {
  const result = await createSession(await signIn(user));
  if (!result.ok) throw new Error(`session refused: ${result.code}`);
  return result.cookie;
}

async function failureCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'no error';
  } catch (error) {
    return error instanceof RoleAssignmentError ? error.code : String(error);
  }
}

describe.skipIf(!HAS_EMULATORS)('with the Firebase emulators', () => {
  beforeAll(async () => {
    await clearAuth();
    await clearFirestore();
  });

  beforeEach(async () => {
    await clearFirestore();
    await createInstitution('school-a');
    await createInstitution('school-b');
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────

  describe('custom claims', () => {
    it('walks one user through every kind of role change, keeping the directory in step', async () => {
      const user = await createUser('teacher@example.in');
      await adminAuth().setCustomUserClaims(user.uid, { plan: 'pro' }); // a claim we do not own
      expect(await getRoleClaims(user.uid)).toBeNull();

      // individual → staff of A: a grant, nothing revoked
      let change = await setInstitutionRole(user.uid, 'school-a', 'inst_staff');
      expect(change).toMatchObject({
        previous: null,
        current: { role: 'inst_staff', institutionId: 'school-a' },
        sessionsRevoked: false,
      });
      expect(await readInstitution('school-a')).toMatchObject({
        adminUid: null,
        staffUids: [user.uid],
      });

      // staff → admin of the same institution: a pure promotion, sessions survive
      change = await setInstitutionRole(user.uid, 'school-a', 'inst_admin');
      expect(change.sessionsRevoked).toBe(false);
      expect(await readInstitution('school-a')).toMatchObject({
        adminUid: user.uid,
        staffUids: [],
      });

      // admin of A → staff of B: access to A is taken away, so sessions are revoked
      change = await setInstitutionRole(user.uid, 'school-b', 'inst_staff');
      expect(change.sessionsRevoked).toBe(true);
      expect(await readInstitution('school-a')).toMatchObject({ adminUid: null, staffUids: [] });
      expect(await readInstitution('school-b')).toMatchObject({ staffUids: [user.uid] });

      // → super admin: leaves B's directory; no institution claim remains
      change = await grantSuperAdmin(user.uid);
      expect(change.current).toEqual({ role: 'super_admin' });
      expect((await readInstitution('school-b')).staffUids).toEqual([]);
      expect((await adminAuth().getUser(user.uid)).customClaims).toEqual({
        plan: 'pro',
        role: 'super_admin',
      });

      // → individual: elevated claims gone, our unrelated claim untouched
      change = await removeElevatedRole(user.uid);
      expect(change).toMatchObject({
        previous: { role: 'super_admin' },
        current: null,
        sessionsRevoked: true,
      });
      expect((await adminAuth().getUser(user.uid)).customClaims).toEqual({ plan: 'pro' });
    });

    it('is idempotent', async () => {
      const user = await createUser('staff@example.in');
      await setInstitutionRole(user.uid, 'school-a', 'inst_staff');
      const again = await setInstitutionRole(user.uid, 'school-a', 'inst_staff');
      expect(again.sessionsRevoked).toBe(false);
      expect((await readInstitution('school-a')).staffUids).toEqual([user.uid]);
    });

    it('allows one admin per institution and leaves a refused user unchanged', async () => {
      const first = await createUser('principal@example.in');
      const second = await createUser('deputy@example.in');
      await setInstitutionRole(first.uid, 'school-a', 'inst_admin');

      expect(await failureCode(setInstitutionRole(second.uid, 'school-a', 'inst_admin'))).toBe(
        'ADMIN_ALREADY_ASSIGNED',
      );
      expect(await getRoleClaims(second.uid)).toBeNull();
      expect((await readInstitution('school-a')).adminUid).toBe(first.uid);
    });

    it('refuses unknown institutions, invalid ids and unknown users without changing claims', async () => {
      const user = await createUser('someone@example.in');
      expect(await failureCode(setInstitutionRole(user.uid, 'no-such-school', 'inst_staff'))).toBe(
        'INSTITUTION_NOT_FOUND',
      );
      expect(await failureCode(setInstitutionRole(user.uid, '../school-a', 'inst_staff'))).toBe(
        'INVALID_ASSIGNMENT',
      );
      expect(await failureCode(setUserRole(user.uid, { role: 'owner' } as never))).toBe(
        'INVALID_ASSIGNMENT',
      );
      expect(await failureCode(grantSuperAdmin('no-such-user'))).toBe('USER_NOT_FOUND');
      expect(await getRoleClaims(user.uid)).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────

  describe('sessions', () => {
    it('exchanges a fresh ID token for a session cookie that carries the role', async () => {
      const user = await createUser('staff2@example.in');
      await setInstitutionRole(user.uid, 'school-b', 'inst_staff');
      const cookie = await sessionFor(user);

      expect(await verifySessionCookie(cookie, { checkRevoked: true })).toEqual({
        uid: user.uid,
        email: 'staff2@example.in',
        role: 'inst_staff',
        institutionId: 'school-b',
        // Since Phase 7 the session also says how the person proved who they are.
        phoneNumber: null,
        emailVerified: false,
      });
    });

    it('refuses anonymous guests, bad tokens and stale sign-ins', async () => {
      const guest = await signInAnonymously();
      expect(await createSession(guest.idToken)).toMatchObject({
        ok: false,
        code: 'ANONYMOUS_NOT_ALLOWED',
        status: 403,
      });
      expect(await createSession('not-a-token')).toMatchObject({
        ok: false,
        code: 'INVALID_TOKEN',
        status: 401,
      });

      const user = await createUser('slow@example.in');
      const idToken = await signIn(user);
      const tenMinutesLater = () => Date.now() + 10 * 60 * 1000;
      expect(await createSession(idToken, tenMinutesLater)).toMatchObject({
        ok: false,
        code: 'SIGN_IN_TOO_OLD',
      });
    });

    it('rejects malformed cookies and cookies minted for another project or already expired', async () => {
      // The emulator does not sign tokens, so signature checks cannot be exercised here (in
      // production the Admin SDK checks them against Google's keys). Everything else can.
      const user = await createUser('tamper@example.in');
      const cookie = await sessionFor(user);
      const [header, payload, signature] = cookie.split('.') as [string, string, string];
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
        string,
        unknown
      >;
      const reissue = (changes: Record<string, unknown>) =>
        [
          header,
          Buffer.from(JSON.stringify({ ...claims, ...changes })).toString('base64url'),
          signature,
        ].join('.');

      expect(await verifySessionCookie('garbage', { checkRevoked: false })).toBeNull();
      expect(
        await verifySessionCookie(reissue({ aud: 'someone-elses-project' }), {
          checkRevoked: false,
        }),
      ).toBeNull();
      expect(
        await verifySessionCookie(
          reissue({ iss: 'https://session.firebase.google.com/someone-elses-project' }),
          {
            checkRevoked: false,
          },
        ),
      ).toBeNull();
      const anHourAgo = Math.floor(Date.now() / 1000) - 3600;
      expect(
        await verifySessionCookie(reissue({ exp: anHourAgo }), { checkRevoked: false }),
      ).toBeNull();
    });

    it('locks a demoted user out of privileged checks at once', async () => {
      const user = await createUser('demoted@example.in');
      await grantSuperAdmin(user.uid);
      const cookie = await sessionFor(user);
      expect((await verifySessionCookie(cookie, { checkRevoked: true }))?.role).toBe('super_admin');

      await nextSecond();
      await removeElevatedRole(user.uid);

      // Revocation-checked verification (all privileged routes) rejects the old session at once.
      // (Without the check, production would still accept the cookie with the claims it was
      // minted with until it expires; the emulator always checks, so that cannot be shown here.)
      expect(await verifySessionCookie(cookie, { checkRevoked: true })).toBeNull();

      // After signing in again the user gets a session with their new role.
      const fresh = await sessionFor(user);
      expect((await verifySessionCookie(fresh, { checkRevoked: true }))?.role).toBe('individual');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────

  describe('POST/DELETE /api/auth/session', () => {
    const post = (body: unknown, headers: Record<string, string>) =>
      POST(
        new NextRequest(`${ORIGIN}/api/auth/session`, {
          method: 'POST',
          // Browsers always send Host; the same-origin check compares Origin with it.
          headers: { host: new URL(ORIGIN).host, 'content-type': 'application/json', ...headers },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
      );

    it('sets an httpOnly, secure, same-site session cookie', async () => {
      const user = await createUser('cookie@example.in');
      const response = await post({ idToken: await signIn(user) }, { origin: ORIGIN });

      expect(response.status).toBe(204);
      const setCookie = response.headers.get('set-cookie') ?? '';
      expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/Secure/i);
      expect(setCookie).toMatch(/SameSite=lax/i);
      expect(setCookie).toMatch(/Path=\//);
      expect(setCookie).toMatch(/Max-Age=432000/);
      expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it('refuses cross-origin and malformed requests', async () => {
      const user = await createUser('csrf@example.in');
      const idToken = await signIn(user);

      expect((await post({ idToken }, { origin: 'https://evil.example' })).status).toBe(403);
      expect((await post({ idToken }, {})).status).toBe(403);
      expect(
        (await post({ idToken }, { origin: ORIGIN, 'content-type': 'text/plain' })).status,
      ).toBe(415);
      expect((await post({}, { origin: ORIGIN })).status).toBe(400);
      expect((await post('{not json', { origin: ORIGIN })).status).toBe(400);
      expect((await post({ idToken: 'x'.repeat(10_000) }, { origin: ORIGIN })).status).toBe(400);
      expect((await post({ idToken: 'forged' }, { origin: ORIGIN })).status).toBe(401);
    });

    it('signs out by clearing the cookie', async () => {
      const response = await DELETE(
        new NextRequest(`${ORIGIN}/api/auth/session`, {
          method: 'DELETE',
          headers: { host: new URL(ORIGIN).host, origin: ORIGIN },
        }),
      );
      expect(response.status).toBe(204);
      expect(response.headers.get('set-cookie')).toMatch(
        new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`, 'i'),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────

  describe('proxy', () => {
    const request = (path: string, cookie?: string) =>
      new NextRequest(`${ORIGIN}${path}`, {
        headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {},
      });

    /** What the proxy decided: pass through, redirect to sign-in, or refuse. */
    async function outcome(path: string, cookie?: string): Promise<string> {
      const response = await proxy(request(path, cookie));
      if (response.headers.get('x-middleware-next') === '1') return 'next';
      if (response.status === 307) {
        const location = new URL(response.headers.get('location')!);
        return `login ${location.pathname}?${location.searchParams.toString()}`;
      }
      return String(response.status);
    }

    let individual: string;
    let staffA: string;
    let adminA: string;
    let superAdmin: string;

    beforeAll(async () => {
      await createInstitution('school-a');
      const users = await Promise.all(
        ['p-individual', 'p-staff', 'p-admin', 'p-super'].map((name) =>
          createUser(`${name}@example.in`),
        ),
      );
      const [, u2, u3, u4] = users as [EmulatorUser, EmulatorUser, EmulatorUser, EmulatorUser];
      await setInstitutionRole(u2.uid, 'school-a', 'inst_staff');
      await setInstitutionRole(u3.uid, 'school-a', 'inst_admin');
      await grantSuperAdmin(u4.uid);
      [individual, staffA, adminA, superAdmin] = (await Promise.all(users.map(sessionFor))) as [
        string,
        string,
        string,
        string,
      ];
    });

    it('applies the route table to every kind of user', async () => {
      const paths = [
        '/admin',
        '/dashboard/institution',
        '/dashboard/vault',
        '/dashboard',
        '/editor',
        '/',
      ];
      const table = async (cookie?: string) =>
        Promise.all(paths.map((path) => outcome(path, cookie)));

      expect(await table()).toEqual([
        'login /login?next=%2Fadmin',
        'login /login?next=%2Fdashboard%2Finstitution',
        'login /login?next=%2Fdashboard%2Fvault',
        'login /login?next=%2Fdashboard',
        'next',
        'next',
      ]);
      expect(await table(individual)).toEqual(['403', '403', 'next', 'next', 'next', 'next']);
      expect(await table(staffA)).toEqual(['403', 'next', 'next', 'next', 'next', 'next']);
      expect(await table(adminA)).toEqual(['403', 'next', 'next', 'next', 'next', 'next']);
      expect(await table(superAdmin)).toEqual(['next', '403', 'next', 'next', 'next', 'next']);
    });

    it('keeps the query string in the return path', async () => {
      expect(await outcome('/dashboard/vault/item-7?tab=share')).toBe(
        'login /login?next=%2Fdashboard%2Fvault%2Fitem-7%3Ftab%3Dshare',
      );
    });

    it('sees through disguised paths', async () => {
      for (const path of ['/%61dmin', '/ADMIN', '/admin/', '//admin', '/dashboard/%69nstitution']) {
        expect(await outcome(path, individual), path).toBe('403');
      }
    });

    it('redirects and clears an invalid cookie', async () => {
      const response = await proxy(request('/dashboard/vault', 'not-a-session'));
      expect(response.status).toBe(307);
      expect(response.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    });

    it('locks a revoked session out of privileged routes', async () => {
      const user = await createUser('p-revoked@example.in');
      await grantSuperAdmin(user.uid);
      const cookie = await sessionFor(user);
      expect(await outcome('/admin', cookie)).toBe('next');

      await nextSecond();
      await adminAuth().revokeRefreshTokens(user.uid);

      expect(await outcome('/admin', cookie)).toBe('login /login?next=%2Fadmin');
    });
  });
});
