/**
 * Server sessions: exchanging a Firebase ID token for an httpOnly session cookie, and reading
 * the signed-in user back in server components, route handlers and server actions.
 *
 * The proxy (`src/proxy.ts`) already gates whole routes, but it is not a complete authorization
 * layer: server actions, route handlers and future refactors can sidestep it. Anything that shows
 * or changes protected data must call `requireAccess`/`authorize` itself (defence in depth).
 */
import 'server-only';

import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';

import { adminAuth } from '@/lib/server/firebase-admin';
import type { SessionUser } from '@/types/roles';

import {
  evaluateAccess,
  requiresRevocationCheck,
  ruleForPath,
  type AccessDecision,
  type RouteAccess,
} from './access';
import { verifyIdToken, verifySessionCookie } from './customClaims';
import { MAX_SIGN_IN_AGE_SECONDS, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from './session-cookie';

export type SessionCreation =
  | { ok: true; cookie: string; user: SessionUser }
  | {
      ok: false;
      status: 401 | 403;
      code: 'INVALID_TOKEN' | 'SIGN_IN_TOO_OLD' | 'ANONYMOUS_NOT_ALLOWED';
      message: string;
    };

/**
 * Turns a freshly issued ID token into a session cookie value. Requires a real (non-anonymous)
 * account, a token that is not revoked, and a sign-in within the last few minutes.
 */
export async function createSession(
  idToken: string,
  now: () => number = Date.now,
): Promise<SessionCreation> {
  const verified = await verifyIdToken(idToken, { checkRevoked: true });
  if (!verified) {
    return {
      ok: false,
      status: 401,
      code: 'INVALID_TOKEN',
      message: 'Sign-in could not be verified.',
    };
  }
  if (verified.user.role === 'guest') {
    return {
      ok: false,
      status: 403,
      code: 'ANONYMOUS_NOT_ALLOWED',
      message: 'Sign in with an account to continue.',
    };
  }
  if (now() / 1000 - verified.authTime > MAX_SIGN_IN_AGE_SECONDS) {
    return { ok: false, status: 401, code: 'SIGN_IN_TOO_OLD', message: 'Please sign in again.' };
  }

  const cookie = await adminAuth().createSessionCookie(idToken, {
    expiresIn: SESSION_MAX_AGE_SECONDS * 1000,
  });
  return { ok: true, cookie, user: verified.user };
}

/**
 * The verified user behind the current request, or `null`. Memoised per request, so layouts and
 * pages can all ask without repeating the verification.
 */
export const getSessionUser = cache(async (checkRevoked: boolean): Promise<SessionUser | null> => {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  return cookie ? verifySessionCookie(cookie, { checkRevoked }) : null;
});

/** For route handlers and server actions: the decision, without redirecting. */
export async function authorize(
  access: RouteAccess,
): Promise<{ decision: AccessDecision; user: SessionUser | null }> {
  const user =
    access.kind === 'public' ? null : await getSessionUser(requiresRevocationCheck(access));
  return { decision: evaluateAccess(access, user), user };
}

/**
 * For server components: returns the user if they may see this content; otherwise redirects to
 * sign-in, or answers "not found" so that privileged areas do not reveal that they exist.
 */
export async function requireAccess(
  access: Exclude<RouteAccess, { kind: 'public' }>,
  returnTo: string,
): Promise<SessionUser> {
  const { decision, user } = await authorize(access);
  if (decision === 'unauthenticated') redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  if (decision === 'forbidden' || !user) notFound();
  return user;
}

/**
 * `requireAccess` with the rule taken from the shared route table, so a page and the proxy can
 * never disagree about who may see it.
 */
export async function requireRouteAccess(path: string): Promise<SessionUser> {
  const rule = ruleForPath(path);
  if (!rule || rule.access.kind === 'public') {
    throw new Error(`"${path}" has no protected route rule; add one to ROUTE_RULES.`);
  }
  return requireAccess(rule.access, path);
}
