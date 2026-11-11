/**
 * Firebase Admin SDK access for server code (API routes only — never import from client code).
 *
 * Initialised lazily so that importing a route does not pay the SDK's start-up cost until a
 * request needs it; on scale-to-zero Cloud Run that keeps cold starts short.
 *
 * Verifying an ID token needs only the project id (Google's public signing keys are fetched and
 * cached by the SDK). On Cloud Run, other Admin features use the service's own identity through
 * Application Default Credentials — no key file is ever shipped with the app.
 */
import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

function adminApp(projectId: string): App {
  return getApps()[0] ?? initializeApp({ projectId });
}

export interface VerifiedIdToken {
  uid: string;
  /** Custom claims and standard JWT fields, e.g. `claims.superAdmin === true`. */
  claims: Record<string, unknown>;
}

/**
 * Verifies a Firebase Auth ID token (signature, expiry, audience and issuer) for the given
 * project. Rejects when the token is not valid.
 */
export async function verifyFirebaseIdToken(
  idToken: string,
  projectId: string,
): Promise<VerifiedIdToken> {
  const decoded = await getAuth(adminApp(projectId)).verifyIdToken(idToken);
  return { uid: decoded.uid, claims: decoded };
}
