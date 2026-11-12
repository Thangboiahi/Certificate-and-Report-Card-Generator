/**
 * POST   /api/auth/session   { "idToken": "<Firebase ID token>" }  → sets the session cookie
 * DELETE /api/auth/session                                       → clears it (sign out)
 *
 * The browser signs in with the Firebase client SDK, then posts the fresh ID token here once.
 * From then on, the httpOnly cookie identifies the user to the proxy and to server code.
 *
 * Only same-origin calls are accepted (`Origin` header check): otherwise another site could sign
 * a visitor into an account of the attacker's choosing ("login CSRF").
 */
import { NextResponse, type NextRequest } from 'next/server';

import { createSession } from '@/lib/auth/session';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth/session-cookie';
import { FirebaseConfigError } from '@/lib/server/firebase-admin';
import { isSameOrigin } from '@/lib/server/same-origin';

const MAX_TOKEN_LENGTH = 8192;

function error(status: number, code: string, message: string): NextResponse {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOrigin(request)) return error(403, 'CROSS_ORIGIN', 'Request refused.');
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return error(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON.');
  }

  const body = (await request.json().catch(() => null)) as { idToken?: unknown } | null;
  const idToken = body?.idToken;
  if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > MAX_TOKEN_LENGTH) {
    return error(400, 'MISSING_TOKEN', 'No sign-in token was provided.');
  }

  try {
    const result = await createSession(idToken);
    if (!result.ok) return error(result.status, result.code, result.message);

    const response = new NextResponse(null, {
      status: 204,
      headers: { 'Cache-Control': 'no-store' },
    });
    response.cookies.set(SESSION_COOKIE, result.cookie, sessionCookieOptions());
    return response;
  } catch (cause) {
    const misconfigured = cause instanceof FirebaseConfigError;
    console.error(
      JSON.stringify({
        severity: 'ERROR',
        message: 'session creation failed',
        cause: cause instanceof Error ? cause.message : String(cause),
      }),
    );
    return misconfigured
      ? error(500, 'SERVER_MISCONFIGURED', 'Sign-in is not configured on the server.')
      : error(503, 'AUTH_UNAVAILABLE', 'Sign-in is temporarily unavailable. Try again shortly.');
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  if (!isSameOrigin(request)) return error(403, 'CROSS_ORIGIN', 'Request refused.');
  const response = new NextResponse(null, {
    status: 204,
    headers: { 'Cache-Control': 'no-store' },
  });
  response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(0));
  return response;
}
