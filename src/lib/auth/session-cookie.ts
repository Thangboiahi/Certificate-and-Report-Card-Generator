/**
 * The session cookie's name and attributes. Kept free of Next.js and Firebase imports so the
 * proxy, route handlers and tests can share it cheaply.
 */

/**
 * `__session` is the one cookie name Firebase Hosting forwards to Cloud Run, so the app keeps
 * working if Hosting is ever put in front of it.
 */
export const SESSION_COOKIE = '__session';

/** Firebase allows 5 minutes to 14 days. */
export const SESSION_MAX_AGE_SECONDS = 5 * 24 * 60 * 60;

/**
 * An ID token is exchanged for a session only if its sign-in happened this recently. Limits what
 * a stolen ID token is worth: it cannot be turned into a five-day session after the fact.
 */
export const MAX_SIGN_IN_AGE_SECONDS = 5 * 60;

export interface SessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

/**
 * - `httpOnly`: page scripts cannot read it, so an XSS bug cannot steal it.
 * - `secure`: HTTPS only (relaxed for `next dev` on http://localhost).
 * - `sameSite: 'lax'`: not sent on cross-site sub-requests or form posts, but still sent when a
 *   person follows a link into the app.
 */
export function sessionCookieOptions(
  maxAge: number = SESSION_MAX_AGE_SECONDS,
  env: NodeJS.ProcessEnv = process.env,
): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV !== 'development',
    sameSite: 'lax',
    path: '/',
    maxAge,
  };
}
