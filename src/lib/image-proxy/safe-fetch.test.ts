import type { LookupAddress } from 'node:dns';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import {
  startTestOrigin,
  TINY_PNG,
  type RouteHandler,
  type TestOrigin,
} from '../../../tests/support/test-origin';
import { ProxyError, type ProxyErrorCode } from './errors';
import { fetchImage, STRICT_NETWORK_POLICY, type FetchImageOptions } from './safe-fetch';
import { createGuardedLookup } from './ssrf';

const LIMITS: FetchImageOptions = { maxBytes: 64 * 1024, timeoutMs: 2000, maxRedirects: 3 };

let origin: TestOrigin | undefined;

async function serve(routes: Record<string, RouteHandler>): Promise<TestOrigin> {
  origin = await startTestOrigin(routes);
  return origin;
}

afterEach(async () => {
  await origin?.close();
  origin = undefined;
});

const png: RouteHandler = (_request, response) => {
  response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': TINY_PNG.length });
  response.end(TINY_PNG);
};

const redirectTo =
  (location: string): RouteHandler =>
  (_request, response) => {
    response.writeHead(302, { Location: location }).end();
  };

async function failureCode(promise: Promise<unknown>): Promise<ProxyErrorCode | 'no error'> {
  try {
    await promise;
    return 'no error';
  } catch (error) {
    if (error instanceof ProxyError) return error.code;
    throw error;
  }
}

describe('fetchImage', () => {
  it('returns the bytes and the sniffed type of an image', async () => {
    const { url, policy } = await serve({ '/a.png': png });
    const image = await fetchImage(new URL(`${url}/a.png`), { ...LIMITS, policy });
    expect(image.format).toBe('png');
    expect(image.contentType).toBe('image/png');
    expect(Buffer.from(image.bytes).equals(Buffer.from(TINY_PNG))).toBe(true);
  });

  it('trusts the bytes, not the Content-Type header', async () => {
    const { url, policy } = await serve({
      '/mislabelled': (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html' }).end(TINY_PNG);
      },
      '/fake.png': (_request, response) => {
        response
          .writeHead(200, { 'Content-Type': 'image/png' })
          .end('<html>Sign in to continue</html>');
      },
      '/vector.svg': (_request, response) => {
        response
          .writeHead(200, { 'Content-Type': 'image/svg+xml' })
          .end('<svg xmlns="http://www.w3.org/2000/svg"/>');
      },
    });
    expect((await fetchImage(new URL(`${url}/mislabelled`), { ...LIMITS, policy })).format).toBe(
      'png',
    );
    expect(await failureCode(fetchImage(new URL(`${url}/fake.png`), { ...LIMITS, policy }))).toBe(
      'NOT_AN_IMAGE',
    );
    expect(await failureCode(fetchImage(new URL(`${url}/vector.svg`), { ...LIMITS, policy }))).toBe(
      'NOT_AN_IMAGE',
    );
  });

  it('follows redirects, including relative ones', async () => {
    const { url, policy, requests } = await serve({
      '/start': redirectTo('/middle'),
      '/middle': redirectTo('final.png'),
      '/final.png': png,
    });
    const image = await fetchImage(new URL(`${url}/start`), { ...LIMITS, policy });
    expect(image.format).toBe('png');
    expect(requests).toEqual(['/start', '/middle', '/final.png']);
  });

  it('gives up on redirect loops', async () => {
    const { url, policy, requests } = await serve({ '/loop': redirectTo('/loop') });
    expect(await failureCode(fetchImage(new URL(`${url}/loop`), { ...LIMITS, policy }))).toBe(
      'TOO_MANY_REDIRECTS',
    );
    expect(requests).toHaveLength(LIMITS.maxRedirects + 1);
  });

  it.each([
    'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://localhost/admin',
    'http://[::1]/',
    'file:///etc/passwd',
  ])('refuses to follow a redirect to %s', async (target) => {
    const { url, policy, requests } = await serve({ '/evil': redirectTo(target) });
    const code = await failureCode(fetchImage(new URL(`${url}/evil`), { ...LIMITS, policy }));
    expect(['BLOCKED_DESTINATION', 'INVALID_URL']).toContain(code);
    expect(requests).toEqual(['/evil']);
  });

  it('rejects an image whose declared size is over the limit without downloading it', async () => {
    const { url, policy } = await serve({
      '/huge': (_request, response) => {
        response.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': 10 * 1024 * 1024,
        });
        response.write(TINY_PNG);
        // never finishes — the proxy must not wait for the body
      },
    });
    expect(await failureCode(fetchImage(new URL(`${url}/huge`), { ...LIMITS, policy }))).toBe(
      'IMAGE_TOO_LARGE',
    );
  });

  it('stops reading when a body of undeclared size grows past the limit', async () => {
    const { url, policy } = await serve({
      '/endless': (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.write(TINY_PNG);
        const filler = Buffer.alloc(16 * 1024);
        const timer = setInterval(() => response.write(filler), 1);
        response.on('close', () => clearInterval(timer));
      },
    });
    expect(await failureCode(fetchImage(new URL(`${url}/endless`), { ...LIMITS, policy }))).toBe(
      'IMAGE_TOO_LARGE',
    );
  });

  it('times out on an origin that never answers', async () => {
    const { url, policy } = await serve({
      '/slow': () => {
        // accept the request and say nothing
      },
    });
    const started = Date.now();
    const code = await failureCode(
      fetchImage(new URL(`${url}/slow`), { ...LIMITS, timeoutMs: 150, policy }),
    );
    expect(code).toBe('UPSTREAM_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('times out on an origin that stalls in the middle of the body', async () => {
    const { url, policy } = await serve({
      '/stall': (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.write(TINY_PNG.subarray(0, 20));
      },
    });
    const code = await failureCode(
      fetchImage(new URL(`${url}/stall`), { ...LIMITS, timeoutMs: 150, policy }),
    );
    expect(code).toBe('UPSTREAM_TIMEOUT');
  });

  it('reports origin errors without leaking their bodies', async () => {
    const { url, policy } = await serve({
      '/secret': (_request, response) => {
        response.writeHead(403).end('internal detail: token=abc');
      },
    });
    try {
      await fetchImage(new URL(`${url}/secret`), { ...LIMITS, policy });
      expect.unreachable();
    } catch (error) {
      expect((error as ProxyError).code).toBe('UPSTREAM_ERROR');
      expect((error as ProxyError).message).toContain('403');
      expect((error as ProxyError).message).not.toContain('token');
    }
    expect(await failureCode(fetchImage(new URL(`${url}/missing`), { ...LIMITS, policy }))).toBe(
      'UPSTREAM_ERROR',
    );
  });

  it('decodes a gzip-encoded body and applies the size limit to the decoded bytes', async () => {
    const bomb = Buffer.concat([Buffer.from(TINY_PNG), Buffer.alloc(1024 * 1024)]);
    const { url, policy } = await serve({
      '/gz': (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Encoding': 'gzip' });
        response.end(gzipSync(TINY_PNG));
      },
      '/bomb': (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Encoding': 'gzip' });
        response.end(gzipSync(bomb)); // ~1 KB on the wire, 1 MB decoded
      },
    });
    expect((await fetchImage(new URL(`${url}/gz`), { ...LIMITS, policy })).format).toBe('png');
    expect(await failureCode(fetchImage(new URL(`${url}/bomb`), { ...LIMITS, policy }))).toBe(
      'IMAGE_TOO_LARGE',
    );
  });

  it('aborts when the caller cancels', async () => {
    const { url, policy } = await serve({ '/slow': () => undefined });
    const controller = new AbortController();
    const pending = fetchImage(new URL(`${url}/slow`), {
      ...LIMITS,
      policy,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('fetchImage with the production network policy', () => {
  it('refuses a loopback origin outright', async () => {
    const { url, requests } = await serve({ '/a.png': png });
    expect(await failureCode(fetchImage(new URL(`${url}/a.png`), LIMITS))).toBe(
      'BLOCKED_DESTINATION',
    );
    expect(requests).toEqual([]);
  });

  it('blocks a public-looking name that resolves to a private address', async () => {
    const { url, requests } = await serve({ '/a.png': png });
    const port = new URL(url).port;
    const rebinding: LookupAddress[] = [{ address: '127.0.0.1', family: 4 }];
    const policy = {
      ...STRICT_NETWORK_POLICY,
      // Let the test port through so the DNS layer is what gets exercised.
      assertUrl: () => undefined,
      lookup: createGuardedLookup((_host, _options, callback) => callback(null, rebinding)),
    };
    const code = await failureCode(
      fetchImage(new URL(`http://images.example.com:${port}/a.png`), { ...LIMITS, policy }),
    );
    expect(code).toBe('BLOCKED_DESTINATION');
    expect(requests).toEqual([]);
  });

  it('re-checks the connected address even if DNS filtering was bypassed', async () => {
    const { url } = await serve({ '/a.png': png });
    const port = new URL(url).port;
    const policy = {
      ...STRICT_NETWORK_POLICY,
      assertUrl: () => undefined,
      // A resolver that performs no filtering at all.
      lookup: ((
        _host: string,
        options: { all?: boolean },
        callback: (...args: unknown[]) => void,
      ) =>
        options.all
          ? callback(null, [{ address: '127.0.0.1', family: 4 }])
          : callback(null, '127.0.0.1', 4)) as typeof STRICT_NETWORK_POLICY.lookup,
    };
    const code = await failureCode(
      fetchImage(new URL(`http://images.example.com:${port}/a.png`), { ...LIMITS, policy }),
    );
    expect(code).toBe('BLOCKED_DESTINATION');
  });
});
