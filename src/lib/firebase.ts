/**
 * Firebase Auth in the browser: passwordless sign-in only (ADR-027).
 *
 *   Email  — `sendEmailSignInLink` mails a one-time link; opening it on the same device lets
 *            `completeEmailSignIn` finish without typing anything again.
 *   Phone  — `startPhoneSignIn` sends a 6-digit SMS code (invisible reCAPTCHA);
 *            `confirmPhoneCode` finishes.
 *
 * Either way the fresh ID token is exchanged once for the httpOnly session cookie
 * (`establishSession` → `POST /api/auth/session`) and the browser-side Firebase session is
 * dropped: the server cookie is the only session, nothing lingers in IndexedDB. No passwords
 * exist anywhere.
 *
 * Browser only. Configuration comes from the server at request time (`firebaseClientConfig`).
 */
import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator,
  inMemoryPersistence,
  initializeAuth,
  isSignInWithEmailLink,
  RecaptchaVerifier,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  signInWithPhoneNumber,
  signOut,
  type Auth,
  type ConfirmationResult,
  type User,
} from 'firebase/auth';

export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  /** `http://127.0.0.1:9099` when this server talks to the Auth emulator (local testing only). */
  authEmulatorUrl: string | null;
}

const EMAIL_KEY = 'passwordless.emailForSignIn';
let cached: { key: string; auth: Auth } | null = null;

/** The Auth instance for this configuration (created once per page). */
export function clientAuth(config: FirebaseClientConfig): Auth {
  const key = JSON.stringify(config);
  if (cached?.key === key) return cached.auth;
  const app: FirebaseApp =
    getApps().find((candidate) => candidate.name === 'passwordless') ??
    initializeApp(
      { apiKey: config.apiKey, authDomain: config.authDomain, projectId: config.projectId },
      'passwordless',
    );
  // In memory only: once the server cookie exists the browser needs no Firebase session.
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  auth.useDeviceLanguage();
  if (config.authEmulatorUrl) {
    connectAuthEmulator(auth, config.authEmulatorUrl, { disableWarnings: true });
    // The emulator sends no SMS and checks no reCAPTCHA.
    auth.settings.appVerificationDisabledForTesting = true;
  }
  cached = { key, auth };
  return auth;
}

function rememberEmail(email: string): void {
  try {
    window.localStorage.setItem(EMAIL_KEY, email);
  } catch {
    // Private mode: the user will be asked for the address again when the link opens.
  }
}

/** The address the link was sent to from this browser, if remembered. */
export function rememberedEmail(): string | null {
  try {
    return window.localStorage.getItem(EMAIL_KEY);
  } catch {
    return null;
  }
}

/** Emails a one-time sign-in link that returns to `continueUrl`. */
export async function sendEmailSignInLink(
  config: FirebaseClientConfig,
  email: string,
  continueUrl: string,
): Promise<void> {
  await sendSignInLinkToEmail(clientAuth(config), email, {
    url: continueUrl,
    handleCodeInApp: true,
  });
  rememberEmail(email);
}

/** True when `href` is a sign-in link this page should complete. */
export function isEmailSignInLink(config: FirebaseClientConfig, href: string): boolean {
  return isSignInWithEmailLink(clientAuth(config), href);
}

/** Completes an email-link sign-in; returns the fresh ID token. */
export async function completeEmailSignIn(
  config: FirebaseClientConfig,
  href: string,
  email: string,
): Promise<string> {
  const { user } = await signInWithEmailLink(clientAuth(config), email, href);
  try {
    window.localStorage.removeItem(EMAIL_KEY);
  } catch {
    // ignore
  }
  return user.getIdToken();
}

/**
 * Sends an SMS code to `phoneE164` (`+919876543210`). `container` is an element (or its id) that
 * hosts the invisible reCAPTCHA; it must stay in the page until the code is confirmed.
 */
export async function startPhoneSignIn(
  config: FirebaseClientConfig,
  phoneE164: string,
  container: HTMLElement | string,
): Promise<ConfirmationResult> {
  const auth = clientAuth(config);
  const verifier = new RecaptchaVerifier(auth, container, { size: 'invisible' });
  try {
    return await signInWithPhoneNumber(auth, phoneE164, verifier);
  } catch (error) {
    verifier.clear();
    throw error;
  }
}

/** Confirms the SMS code; returns the fresh ID token. */
export async function confirmPhoneCode(
  confirmation: ConfirmationResult,
  code: string,
): Promise<string> {
  const { user } = await confirmation.confirm(code);
  return user.getIdToken();
}

/**
 * Exchanges a fresh ID token for the server's session cookie, then ends the browser-side Firebase
 * session. Throws with the server's message when refused.
 */
export async function establishSession(
  config: FirebaseClientConfig,
  idToken: string,
): Promise<void> {
  const response = await fetch('/api/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  await signOut(clientAuth(config)).catch(() => undefined);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(body?.error?.message ?? 'Sign-in could not be completed.');
  }
}

/** Signs out of the server session (so another account can sign in). */
export async function endSession(): Promise<void> {
  await fetch('/api/auth/session', { method: 'DELETE' });
}

/** Human message for a Firebase Auth error code. */
export function authErrorMessage(error: unknown): string {
  const code = (error as { code?: string } | null)?.code ?? '';
  const messages: Record<string, string> = {
    'auth/invalid-email': 'That email address does not look right.',
    'auth/invalid-phone-number': 'That mobile number does not look right.',
    'auth/invalid-verification-code': 'That code is not correct. Check the SMS and try again.',
    'auth/code-expired': 'That code has expired. Send a new one.',
    'auth/invalid-action-code': 'This sign-in link has already been used or has expired.',
    'auth/expired-action-code': 'This sign-in link has expired. Send a new one.',
    'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
    'auth/quota-exceeded': 'Too many codes were sent today. Try again later or use email.',
    'auth/network-request-failed': 'No connection. Check your internet and try again.',
  };
  return messages[code] ?? 'Something went wrong. Please try again.';
}

export type { ConfirmationResult, User };
