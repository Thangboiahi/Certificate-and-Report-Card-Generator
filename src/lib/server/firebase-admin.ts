/**
 * Firebase Admin SDK access for server code (proxy, route handlers, server components). Never
 * import this from client code — `server-only` makes such an import fail the build.
 *
 * Initialised lazily so importing a route does not pay the SDK's start-up cost until a request
 * needs it; on scale-to-zero Cloud Run that keeps cold starts short.
 *
 * Credentials: token verification needs only the project id (Google's public signing keys are
 * fetched and cached by the SDK). Everything else — setting claims, Firestore — uses the Cloud
 * Run service's own identity through Application Default Credentials. No key file is shipped.
 */
import 'server-only';

import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

export class FirebaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FirebaseConfigError';
  }
}

/** The configured Firebase project, or `null` when the server has not been configured. */
export function firebaseProjectId(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.FIREBASE_PROJECT_ID?.trim() || null;
}

/**
 * With an emulator host set, the Admin SDK accepts UNSIGNED tokens: anyone could forge any role.
 * That is how local testing works, so it must never reach a deployed server. Cloud Run always
 * sets `K_SERVICE`; refuse to start auth there if an emulator variable is present.
 */
export function assertNoEmulatorInProduction(env: NodeJS.ProcessEnv = process.env): void {
  const emulator = env.FIREBASE_AUTH_EMULATOR_HOST || env.FIRESTORE_EMULATOR_HOST;
  // A production build may talk to emulators only when explicitly allowed (local end-to-end
  // tests); on Cloud Run it never may.
  const productionBuild = env.NODE_ENV === 'production' && env.ALLOW_FIREBASE_EMULATOR !== 'true';
  if (emulator && (env.K_SERVICE || productionBuild)) {
    throw new FirebaseConfigError(
      'Firebase emulator variables are set on a production server. Refusing to verify tokens.',
    );
  }
}

function adminApp(projectId?: string): App {
  const existing = getApps()[0];
  if (existing) return existing;

  assertNoEmulatorInProduction();
  const resolved = projectId ?? firebaseProjectId();
  if (!resolved) {
    throw new FirebaseConfigError('FIREBASE_PROJECT_ID is not set.');
  }
  return initializeApp({ projectId: resolved });
}

export function adminAuth(): Auth {
  return getAuth(adminApp());
}

export function adminFirestore(): Firestore {
  return getFirestore(adminApp());
}

export interface VerifiedIdToken {
  uid: string;
  /** Custom claims and standard JWT fields, e.g. `claims.role === 'super_admin'`. */
  claims: Record<string, unknown>;
}

/**
 * Verifies a Firebase Auth ID token (signature, expiry, audience and issuer) for the given
 * project. Rejects when the token is not valid. Used by the image proxy.
 */
export async function verifyFirebaseIdToken(
  idToken: string,
  projectId: string,
): Promise<VerifiedIdToken> {
  const decoded = await getAuth(adminApp(projectId)).verifyIdToken(idToken);
  return { uid: decoded.uid, claims: decoded };
}
