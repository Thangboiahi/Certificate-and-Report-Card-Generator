/**
 * Who may use the image proxy: signed-in users only.
 *
 * Either credential works:
 *   - the session cookie, which the browser sends by itself on same-origin requests (the Web
 *     Worker's fetches) — the normal case;
 *   - a Firebase ID token as `Authorization: Bearer <token>` (e.g. a guest with an anonymous
 *     Firebase session in the editor, who has no session cookie).
 * An unauthenticated proxy would be an open relay for anyone on the internet, so the default is
 * to refuse.
 */
import { verifySessionCookie } from '@/lib/auth/customClaims';
import { SESSION_COOKIE } from '@/lib/auth/session-cookie';
import { verifyFirebaseIdToken } from '@/lib/server/firebase-admin';

import type { ImageProxyConfig } from './config';
import { ProxyError } from './errors';

export interface ProxyUser {
  /** Firebase Auth uid, or `"anonymous"` in local development. */
  uid: string;
}

/** Verifies an ID token for a project and returns the user's uid. Replaced in tests. */
export type TokenVerifier = (idToken: string, projectId: string) => Promise<{ uid: string }>;

/** Verifies a session cookie; `null` when it is not valid. Replaced in tests. */
export type SessionVerifier = (cookie: string) => Promise<{ uid: string } | null>;

const verifySession: SessionVerifier = (cookie) =>
  verifySessionCookie(cookie, { checkRevoked: false });

function sessionCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(value.join('='));
    } catch {
      return value.join('=');
    }
  }
  return null;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
  return match?.[1] ?? null;
}

/**
 * Resolves the user making a proxy request, or throws `ProxyError`.
 *
 * - Local development with `IMAGE_PROXY_ALLOW_ANONYMOUS=true` (never honoured on Cloud Run):
 *   everyone is let in as "anonymous".
 * - Otherwise a valid session cookie or Firebase ID token is mandatory.
 */
export async function authenticateProxyRequest(
  request: Request,
  config: Pick<ImageProxyConfig, 'allowAnonymous' | 'firebaseProjectId'>,
  verify: TokenVerifier = verifyFirebaseIdToken,
  verifyCookie: SessionVerifier = verifySession,
): Promise<ProxyUser> {
  if (config.allowAnonymous) return { uid: 'anonymous' };

  const token = bearerToken(request);
  const cookie = token ? null : sessionCookie(request);
  if (!token && !cookie) {
    throw new ProxyError('UNAUTHENTICATED', 'Sign in to load images.');
  }
  if (!config.firebaseProjectId) {
    throw new ProxyError(
      'SERVER_MISCONFIGURED',
      'Image loading is not configured on the server (FIREBASE_PROJECT_ID is missing).',
    );
  }

  try {
    if (token) return { uid: (await verify(token, config.firebaseProjectId)).uid };
    const user = await verifyCookie(cookie as string);
    if (!user) throw new Error('invalid session cookie');
    return { uid: user.uid };
  } catch (error) {
    throw new ProxyError('UNAUTHENTICATED', 'Your session has expired. Sign in again.', {
      cause: error,
    });
  }
}
