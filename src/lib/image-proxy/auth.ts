/**
 * Who may use the image proxy: signed-in users only.
 *
 * The caller sends its Firebase ID token as `Authorization: Bearer <token>`. An unauthenticated
 * proxy would be an open relay for anyone on the internet, so the default is to refuse.
 */
import { verifyFirebaseIdToken } from '@/lib/server/firebase-admin';

import type { ImageProxyConfig } from './config';
import { ProxyError } from './errors';

export interface ProxyUser {
  /** Firebase Auth uid, or `"anonymous"` in local development. */
  uid: string;
}

/** Verifies an ID token for a project and returns the user's uid. Replaced in tests. */
export type TokenVerifier = (idToken: string, projectId: string) => Promise<{ uid: string }>;

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
 * - Otherwise a valid Firebase ID token is mandatory.
 */
export async function authenticateProxyRequest(
  request: Request,
  config: Pick<ImageProxyConfig, 'allowAnonymous' | 'firebaseProjectId'>,
  verify: TokenVerifier = verifyFirebaseIdToken,
): Promise<ProxyUser> {
  if (config.allowAnonymous) return { uid: 'anonymous' };

  const token = bearerToken(request);
  if (!token) {
    throw new ProxyError('UNAUTHENTICATED', 'Sign in to load images.');
  }
  if (!config.firebaseProjectId) {
    throw new ProxyError(
      'SERVER_MISCONFIGURED',
      'Image loading is not configured on the server (FIREBASE_PROJECT_ID is missing).',
    );
  }

  try {
    const { uid } = await verify(token, config.firebaseProjectId);
    return { uid };
  } catch (error) {
    throw new ProxyError('UNAUTHENTICATED', 'Your session has expired. Sign in again.', {
      cause: error,
    });
  }
}
