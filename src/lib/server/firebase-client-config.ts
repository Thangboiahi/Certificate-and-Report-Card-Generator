/**
 * The Firebase web configuration the browser needs for passwordless sign-in, read from the
 * server's environment AT REQUEST TIME and handed to client components as a prop. Nothing is baked
 * into the JavaScript bundle at build time, so the same build serves every environment — and the
 * emulator address can only reach a browser through a server that passed the emulator guard
 * (ADR-019).
 */
import 'server-only';

import type { FirebaseClientConfig } from '@/lib/firebase';

import { assertNoEmulatorInProduction, firebaseProjectId } from './firebase-admin';

/** `null` when sign-in is not configured on this server. */
export function firebaseClientConfig(
  env: Record<string, string | undefined> = process.env,
): FirebaseClientConfig | null {
  const projectId = firebaseProjectId(env as NodeJS.ProcessEnv);
  if (!projectId) return null;
  const emulatorHost = env.FIREBASE_AUTH_EMULATOR_HOST?.trim();
  if (emulatorHost) {
    assertNoEmulatorInProduction(env as NodeJS.ProcessEnv);
    return {
      apiKey: env.FIREBASE_WEB_API_KEY?.trim() || 'demo-api-key',
      authDomain: `${projectId}.firebaseapp.com`,
      projectId,
      authEmulatorUrl: `http://${emulatorHost}`,
    };
  }
  const apiKey = env.FIREBASE_WEB_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    authDomain: env.FIREBASE_AUTH_DOMAIN?.trim() || `${projectId}.firebaseapp.com`,
    projectId,
    authEmulatorUrl: null,
  };
}
