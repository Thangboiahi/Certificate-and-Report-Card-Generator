/**
 * Route protection (Next.js 16 "proxy", formerly `middleware.ts`).
 *
 *   /admin/*                 → super_admin
 *   /dashboard/institution/* → inst_admin or inst_staff
 *   /dashboard/vault/*       → any signed-in (non-anonymous) user
 *   /dashboard/*             → any signed-in user (fail closed for unlisted dashboard pages)
 *   /editor                  → everyone, including anonymous guests
 *
 * The rule table lives in `src/lib/auth/access.ts` and is shared with the server-side guards.
 *
 * The session cookie is verified cryptographically here (Node.js runtime, Firebase Admin SDK);
 * privileged areas additionally check with Firebase Auth that the session was not revoked, so a
 * demoted admin is locked out at once. This is the first gate, not the only one: pages, route
 * handlers and server actions re-verify through `src/lib/auth/session.ts`.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { evaluateAccess, requiresRevocationCheck, ruleForPath } from '@/lib/auth/access';
import { verifySessionCookie } from '@/lib/auth/customClaims';
import { SESSION_COOKIE } from '@/lib/auth/session-cookie';
import type { SessionUser } from '@/types/roles';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const rule = ruleForPath(request.nextUrl.pathname);
  if (!rule || rule.access.kind === 'public') return NextResponse.next();

  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  let user: SessionUser | null = null;
  if (cookie) {
    try {
      user = await verifySessionCookie(cookie, {
        checkRevoked: requiresRevocationCheck(rule.access),
      });
    } catch (error) {
      // Verification could not run (configuration, Google key fetch, Auth outage): fail closed,
      // and do not pretend the user is signed out.
      console.error(
        JSON.stringify({
          severity: 'ERROR',
          message: 'session verification unavailable',
          path: rule.prefix,
          cause: error instanceof Error ? error.message : String(error),
        }),
      );
      return new NextResponse('Authentication is temporarily unavailable.', {
        status: 503,
        headers: { ...NO_STORE, 'Retry-After': '30' },
      });
    }
  }

  const decision = evaluateAccess(rule.access, user);
  if (decision === 'allow') return NextResponse.next();

  if (decision === 'unauthenticated') {
    const login = new URL('/login', request.url);
    login.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`);
    const response = NextResponse.redirect(login);
    // An expired, revoked or forged cookie is useless: clear it.
    if (cookie) response.cookies.delete(SESSION_COOKIE);
    return response;
  }

  return new NextResponse('Forbidden', { status: 403, headers: NO_STORE });
}

export const config = {
  // Every request except build assets. Deliberately broad: the rule table decides what is
  // protected, using a canonical form of the path, so encoded or oddly-cased variants of a
  // protected path cannot slip past a narrower matcher.
  matcher: ['/((?!_next/static/|_next/image).*)'],
};
