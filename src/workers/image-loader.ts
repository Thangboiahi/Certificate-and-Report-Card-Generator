/**
 * How the Worker obtains image bytes for the engine.
 *
 * In order of preference:
 *   1. a file the caller supplied directly (`localImages`) — no network at all;
 *   2. a same-origin URL — fetched directly;
 *   3. any other http(s) URL — fetched through `/api/proxy-image`, because browsers do not let a
 *      page read cross-origin image bytes unless the other site opts in (CORS).
 *
 * Runs in a Worker or on a page; uses only `fetch` and `URL`.
 */
import type { ImageLoader } from '@/lib/pdf-engine';

export interface ImageLoaderOptions {
  /** Absolute or root-relative URL of the proxy route. */
  proxyUrl: string;
  /** The origin this code runs on, to tell same-origin links apart. */
  origin: string;
  localImages?: Readonly<Record<string, ArrayBuffer>>;
  /** Supplies the Firebase ID token the proxy requires. */
  getAuthToken?: () => Promise<string | null>;
  /** Replaceable for tests. */
  fetch?: typeof fetch;
}

/** ID tokens last an hour; asking the page every few minutes keeps a long job authorised. */
const TOKEN_MAX_AGE_MS = 5 * 60 * 1000;

interface ProxyErrorBody {
  error?: { code?: string; message?: string };
}

export function createImageLoader(options: ImageLoaderOptions): ImageLoader {
  const fetchImpl = options.fetch ?? fetch;
  let token: { value: string | null; fetchedAt: number } | undefined;
  let pendingToken: Promise<string | null> | undefined;

  async function authToken(): Promise<string | null> {
    if (!options.getAuthToken) return null;
    if (token && Date.now() - token.fetchedAt < TOKEN_MAX_AGE_MS) return token.value;
    // Many downloads start at once; they share one request to the page.
    pendingToken ??= options.getAuthToken().finally(() => {
      pendingToken = undefined;
    });
    const value = await pendingToken;
    token = { value, fetchedAt: Date.now() };
    return value;
  }

  async function read(response: Response): Promise<Uint8Array> {
    if (!response.ok) {
      // The proxy explains failures in a form meant for the user; pass that on.
      const body = (await response.json().catch(() => null)) as ProxyErrorBody | null;
      throw new Error(
        body?.error?.message ?? `The image could not be loaded (HTTP ${response.status}).`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  return async (source, signal) => {
    const local = options.localImages?.[source];
    if (local) return new Uint8Array(local);

    let url: URL;
    try {
      url = new URL(source, options.origin);
    } catch {
      throw new Error('This is not a valid image link.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Only http and https image links are supported.');
    }
    // A value like "photo-17.jpg" parses as a relative URL; without a matching local file it is
    // almost certainly a file name, not a page on our site.
    if (!/^(https?:)?\/\//i.test(source) && !source.startsWith('/')) {
      throw new Error(`No image named "${source}" was provided.`);
    }

    if (url.origin === options.origin) {
      return read(await fetchImpl(url, { signal, credentials: 'same-origin' }));
    }

    const proxied = new URL(options.proxyUrl, options.origin);
    proxied.searchParams.set('url', url.href);
    const idToken = await authToken();
    return read(
      await fetchImpl(proxied, {
        signal,
        headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined,
      }),
    );
  };
}
