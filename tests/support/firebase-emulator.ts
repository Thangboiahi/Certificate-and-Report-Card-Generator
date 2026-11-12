/**
 * Test support: talking to the Firebase Auth and Firestore emulators started by
 * `npm run test:emulator` (which sets FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST).
 *
 * The Auth emulator's REST API stands in for the browser: it signs people up and in and returns
 * the same ID tokens the Firebase client SDK would hand to the app.
 */
export const PROJECT_ID = 'demo-v6';

export const HAS_EMULATORS = Boolean(
  process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIRESTORE_EMULATOR_HOST,
);

const authBase = () => `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`;
const firestoreBase = () => `http://${process.env.FIRESTORE_EMULATOR_HOST}`;

async function identityToolkit<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(
    `${authBase()}/identitytoolkit.googleapis.com/v1/accounts:${method}?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, returnSecureToken: true }),
    },
  );
  if (!response.ok) throw new Error(`Auth emulator ${method} failed: ${await response.text()}`);
  return (await response.json()) as T;
}

export interface EmulatorUser {
  uid: string;
  email: string;
  password: string;
}

/** Creates an email/password account and returns it. */
export async function createUser(email: string): Promise<EmulatorUser> {
  const password = 'correct horse battery staple';
  const result = await identityToolkit<{ localId: string }>('signUp', { email, password });
  return { uid: result.localId, email, password };
}

/** Signs in again and returns a fresh ID token carrying the user's current custom claims. */
export async function signIn(user: EmulatorUser): Promise<string> {
  const result = await identityToolkit<{ idToken: string }>('signInWithPassword', {
    email: user.email,
    password: user.password,
  });
  return result.idToken;
}

/** Signs in anonymously (a "guest") and returns the ID token. */
export async function signInAnonymously(): Promise<{ uid: string; idToken: string }> {
  const result = await identityToolkit<{ localId: string; idToken: string }>('signUp', {});
  return { uid: result.localId, idToken: result.idToken };
}

export async function clearAuth(): Promise<void> {
  await fetch(`${authBase()}/emulator/v1/projects/${PROJECT_ID}/accounts`, { method: 'DELETE' });
}

export async function clearFirestore(): Promise<void> {
  await fetch(
    `${firestoreBase()}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    {
      method: 'DELETE',
    },
  );
}

/** Waits past the current second: Firebase compares revocation times at one-second precision. */
export function nextSecond(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1100));
}
