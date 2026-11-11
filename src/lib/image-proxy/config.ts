/**
 * Image proxy settings, read from the environment on each request so a Cloud Run revision can be
 * tuned without a rebuild. See `.env.example` for the documented variables.
 */

export interface ImageProxyConfig {
  /** Largest image relayed, in bytes (after any transfer decompression). */
  maxBytes: number;
  /** Total budget for one upstream fetch, redirects included. */
  timeoutMs: number;
  /** Redirect hops followed before giving up. Each hop is re-validated. */
  maxRedirects: number;
  /** `Cache-Control: private, max-age` sent with a relayed image. */
  cacheSeconds: number;
  /** Local development only — see `isAnonymousAccessAllowed`. */
  allowAnonymous: boolean;
  /** Firebase project whose ID tokens are accepted. */
  firebaseProjectId: string | null;
}

const MIB = 1024 * 1024;

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Anonymous access exists so the engine can be exercised locally before Firebase is wired up.
 * It can never be switched on in production: Cloud Run always sets `K_SERVICE`, and when that is
 * present the flag is ignored. An unauthenticated proxy on the public internet is an open relay.
 */
export function isAnonymousAccessAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.IMAGE_PROXY_ALLOW_ANONYMOUS === 'true' && !env.K_SERVICE;
}

export function readImageProxyConfig(): ImageProxyConfig {
  return {
    maxBytes: intFromEnv('IMAGE_PROXY_MAX_BYTES', 8 * MIB, 64 * 1024, 32 * MIB),
    timeoutMs: intFromEnv('IMAGE_PROXY_TIMEOUT_MS', 15_000, 1_000, 60_000),
    maxRedirects: 5,
    cacheSeconds: intFromEnv('IMAGE_PROXY_CACHE_SECONDS', 600, 0, 86_400),
    allowAnonymous: isAnonymousAccessAllowed(),
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID?.trim() || null,
  };
}
