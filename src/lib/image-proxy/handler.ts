/**
 * The image proxy's request handling, independent of Next.js so it can be tested with plain
 * `Request` objects. The route file (`src/app/api/proxy-image/route.ts`) only adapts to Next.js.
 *
 * Flow: authenticate → normalise the link → fetch safely → answer with the verified bytes.
 */
import { authenticateProxyRequest, type SessionVerifier, type TokenVerifier } from './auth';
import { readImageProxyConfig, type ImageProxyConfig } from './config';
import { ProxyError } from './errors';
import { normalizeImageUrl } from './normalize-url';
import { fetchImage, type NetworkPolicy } from './safe-fetch';

/** Longest URL accepted. Real image links are far shorter; this bounds log and parser work. */
const MAX_URL_LENGTH = 4096;

export interface ProxyHandlerDependencies {
  config?: ImageProxyConfig;
  verifyToken?: TokenVerifier;
  verifySession?: SessionVerifier;
  policy?: NetworkPolicy;
}

/** Shape of every error body the proxy returns. The Web Worker reads `error.code`. */
export interface ProxyErrorBody {
  error: { code: string; message: string };
}

function errorResponse(error: ProxyError): Response {
  const body: ProxyErrorBody = { error: { code: error.code, message: error.message } };
  return Response.json(body, {
    status: error.status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

/**
 * One structured line per failure; Cloud Logging parses JSON on stdout/stderr. Only the host is
 * recorded — full URLs can carry access tokens and personal data.
 */
function logFailure(error: ProxyError, host: string | null, uid: string | null): void {
  const severity = error.status >= 500 ? 'ERROR' : 'WARNING';
  console.warn(
    JSON.stringify({
      severity,
      message: `proxy-image ${error.code}`,
      code: error.code,
      status: error.status,
      host,
      uid,
      cause: error.cause instanceof Error ? error.cause.message : undefined,
    }),
  );
}

/** Handles `GET /api/proxy-image?url=<image address>`. Never throws. */
export async function handleProxyImageRequest(
  request: Request,
  dependencies: ProxyHandlerDependencies = {},
): Promise<Response> {
  const config = dependencies.config ?? readImageProxyConfig();
  let host: string | null = null;
  let uid: string | null = null;

  try {
    const user = await authenticateProxyRequest(
      request,
      config,
      dependencies.verifyToken,
      dependencies.verifySession,
    );
    uid = user.uid;

    const raw = new URL(request.url).searchParams.get('url');
    if (!raw) throw new ProxyError('MISSING_URL', 'No image address was provided.');
    if (raw.length > MAX_URL_LENGTH)
      throw new ProxyError('INVALID_URL', 'The image address is too long.');

    const target = normalizeImageUrl(raw);
    host = target.hostname;

    const image = await fetchImage(target, {
      maxBytes: config.maxBytes,
      timeoutMs: config.timeoutMs,
      maxRedirects: config.maxRedirects,
      signal: request.signal,
      policy: dependencies.policy,
    });

    return new Response(image.bytes, {
      status: 200,
      headers: {
        'Content-Type': image.contentType,
        'Content-Length': String(image.bytes.byteLength),
        // Per-user browser cache only: re-running a batch or a preview should not refetch.
        'Cache-Control': `private, max-age=${config.cacheSeconds}`,
        // If someone opens the proxied file directly it must never be treated as a page.
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-origin',
      },
    });
  } catch (error) {
    if (request.signal.aborted) {
      // The browser gave up (job cancelled, tab closed). Nobody is listening for the answer.
      return new Response(null, { status: 499 });
    }
    const proxyError =
      error instanceof ProxyError
        ? error
        : new ProxyError('UPSTREAM_ERROR', 'The image could not be loaded.', { cause: error });
    logFailure(proxyError, host, uid);
    return errorResponse(proxyError);
  }
}
