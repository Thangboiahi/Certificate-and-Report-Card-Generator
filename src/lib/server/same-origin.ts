/**
 * Same-origin check for state-changing requests authenticated by the session cookie (login CSRF,
 * cross-site dispatch). The `Origin` header's host must equal the host the request was addressed
 * to: `APP_ORIGIN`'s host when configured, otherwise the forwarded or direct `Host` header — the
 * comparison Next.js makes for Server Actions. Browsers always send `Origin` on POST and DELETE,
 * so a missing header is refused too.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin || !URL.canParse(origin)) return false;
  const configured = process.env.APP_ORIGIN?.trim();
  const expectedHost = configured
    ? URL.canParse(configured)
      ? new URL(configured).host
      : null
    : (request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ??
      request.headers.get('host'));
  return expectedHost !== null && new URL(origin).host === expectedHost;
}
