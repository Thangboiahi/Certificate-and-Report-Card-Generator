import { afterEach, describe, expect, it, vi } from 'vitest';

import { startTestOrigin, TINY_PNG, type TestOrigin } from '../../../tests/support/test-origin';
import { isAnonymousAccessAllowed, type ImageProxyConfig } from './config';
import { handleProxyImageRequest, type ProxyErrorBody } from './handler';

const BASE_CONFIG: ImageProxyConfig = {
  maxBytes: 64 * 1024,
  timeoutMs: 2000,
  maxRedirects: 3,
  cacheSeconds: 600,
  allowAnonymous: false,
  firebaseProjectId: 'demo-project',
};

let origin: TestOrigin | undefined;

async function startOrigin(): Promise<TestOrigin> {
  origin = await startTestOrigin({
    '/photo.png': (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(TINY_PNG);
    },
  });
  return origin;
}

afterEach(async () => {
  await origin?.close();
  origin = undefined;
  vi.restoreAllMocks();
});

function proxyRequest(target: string | null, token?: string): Request {
  const url = new URL('https://app.example.in/api/proxy-image');
  if (target !== null) url.searchParams.set('url', target);
  return new Request(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

const acceptToken = async (token: string) => {
  if (token !== 'good-token') throw new Error('bad signature');
  return { uid: 'user-1' };
};

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as ProxyErrorBody).error.code;
}

describe('handleProxyImageRequest', () => {
  it('relays an image to an authenticated user with hardened headers', async () => {
    const { url, policy } = await startOrigin();
    const response = await handleProxyImageRequest(proxyRequest(`${url}/photo.png`, 'good-token'), {
      config: BASE_CONFIG,
      verifyToken: acceptToken,
      policy,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-length')).toBe(String(TINY_PNG.length));
    expect(response.headers.get('cache-control')).toBe('private, max-age=600');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    // Same-origin only: the proxy must not become a CORS bypass for other websites.
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(TINY_PNG);
  });

  it('accepts the session cookie that the browser sends on same-origin requests', async () => {
    const { url, policy } = await startOrigin();
    const target = new URL('https://app.example.in/api/proxy-image');
    target.searchParams.set('url', `${url}/photo.png`);
    const withCookie = (cookie: string) =>
      handleProxyImageRequest(new Request(target, { headers: { cookie } }), {
        config: BASE_CONFIG,
        verifyToken: acceptToken,
        verifySession: async (value) => (value === 'good-session' ? { uid: 'user-2' } : null),
        policy,
      });

    expect((await withCookie('theme=dark; __session=good-session')).status).toBe(200);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await withCookie('__session=forged')).status).toBe(401);
    expect((await withCookie('__session=%E0%A4%A')).status).toBe(401);
    expect((await withCookie('other=good-session')).status).toBe(401);
  });

  it('rejects requests without a token', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { url, policy, requests } = await startOrigin();
    const response = await handleProxyImageRequest(proxyRequest(`${url}/photo.png`), {
      config: BASE_CONFIG,
      verifyToken: acceptToken,
      policy,
    });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('UNAUTHENTICATED');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(requests).toEqual([]);
  });

  it('rejects an invalid token', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { url, policy, requests } = await startOrigin();
    const response = await handleProxyImageRequest(proxyRequest(`${url}/photo.png`, 'forged'), {
      config: BASE_CONFIG,
      verifyToken: acceptToken,
      policy,
    });
    expect(response.status).toBe(401);
    expect(requests).toEqual([]);
  });

  it('rejects real-looking garbage tokens through the real Firebase verifier', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await handleProxyImageRequest(
      proxyRequest('https://example.com/a.png', 'eyJhbGciOiJSUzI1NiJ9.e30.c2lnbmF0dXJl'),
      { config: BASE_CONFIG },
    );
    expect(response.status).toBe(401);
  });

  it('fails closed when Firebase is not configured', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await handleProxyImageRequest(
      proxyRequest('https://example.com/a.png', 'good-token'),
      {
        config: { ...BASE_CONFIG, firebaseProjectId: null },
        verifyToken: acceptToken,
      },
    );
    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe('SERVER_MISCONFIGURED');
  });

  it('serves anonymous requests only when local development allows it', async () => {
    const { url, policy } = await startOrigin();
    const response = await handleProxyImageRequest(proxyRequest(`${url}/photo.png`), {
      config: { ...BASE_CONFIG, allowAnonymous: true, firebaseProjectId: null },
      policy,
    });
    expect(response.status).toBe(200);
  });

  it.each([
    [null, 400, 'MISSING_URL'],
    ['', 400, 'MISSING_URL'],
    ['not a url', 400, 'INVALID_URL'],
    ['ftp://example.com/a.png', 400, 'INVALID_URL'],
    [`https://example.com/${'a'.repeat(5000)}`, 400, 'INVALID_URL'],
    ['http://169.254.169.254/computeMetadata/v1/', 403, 'BLOCKED_DESTINATION'],
    ['http://localhost:3000/api/admin', 403, 'BLOCKED_DESTINATION'],
  ])('answers %j with %i %s', async (target, status, code) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await handleProxyImageRequest(proxyRequest(target, 'good-token'), {
      config: BASE_CONFIG,
      verifyToken: acceptToken,
    });
    expect(response.status).toBe(status);
    expect(await errorCode(response)).toBe(code);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('logs the host but never the full URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await handleProxyImageRequest(
      proxyRequest('http://10.0.0.8/photo.jpg?token=SECRET', 'good-token'),
      {
        config: BASE_CONFIG,
        verifyToken: acceptToken,
      },
    );
    const line = String(warn.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      code: 'BLOCKED_DESTINATION',
      host: '10.0.0.8',
      uid: 'user-1',
    });
    expect(line).not.toContain('SECRET');
  });
});

describe('isAnonymousAccessAllowed', () => {
  it('requires the explicit flag', () => {
    expect(isAnonymousAccessAllowed({ NODE_ENV: 'development' })).toBe(false);
    expect(
      isAnonymousAccessAllowed({ NODE_ENV: 'development', IMAGE_PROXY_ALLOW_ANONYMOUS: 'true' }),
    ).toBe(true);
    expect(
      isAnonymousAccessAllowed({ NODE_ENV: 'development', IMAGE_PROXY_ALLOW_ANONYMOUS: '1' }),
    ).toBe(false);
  });

  it('can never be enabled on Cloud Run', () => {
    expect(
      isAnonymousAccessAllowed({
        NODE_ENV: 'production',
        IMAGE_PROXY_ALLOW_ANONYMOUS: 'true',
        K_SERVICE: 'document-generator',
      }),
    ).toBe(false);
  });
});
