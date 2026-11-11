import { describe, expect, it, vi } from 'vitest';

import { createImageLoader } from './image-loader';

const ORIGIN = 'https://app.example.in';
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

interface Call {
  url: string;
  authorization: string | null;
}

function fakeFetch(respond: (url: URL) => Response = () => new Response(BYTES)) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, authorization: new Headers(init?.headers).get('authorization') });
    return respond(url);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('createImageLoader', () => {
  it('fetches other sites through the proxy, with the user’s token', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const load = createImageLoader({
      proxyUrl: '/api/proxy-image',
      origin: ORIGIN,
      getAuthToken: async () => 'token-1',
      fetch: fetchImpl,
    });

    expect(await load('https://school.example.org/photos/a b.jpg?x=1&y=2')).toEqual(BYTES);
    expect(calls).toEqual([
      {
        url: `${ORIGIN}/api/proxy-image?url=${encodeURIComponent('https://school.example.org/photos/a%20b.jpg?x=1&y=2')}`,
        authorization: 'Bearer token-1',
      },
    ]);
  });

  it('fetches same-origin files directly, without the proxy or the token', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const load = createImageLoader({
      proxyUrl: '/api/proxy-image',
      origin: ORIGIN,
      getAuthToken: async () => 'token-1',
      fetch: fetchImpl,
    });

    await load('/samples/photo.jpg');
    await load(`${ORIGIN}/samples/logo.png`);
    expect(calls).toEqual([
      { url: `${ORIGIN}/samples/photo.jpg`, authorization: null },
      { url: `${ORIGIN}/samples/logo.png`, authorization: null },
    ]);
  });

  it('uses files supplied by the caller without touching the network', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const load = createImageLoader({
      proxyUrl: '/api/proxy-image',
      origin: ORIGIN,
      localImages: { '1023.jpg': BYTES.buffer.slice(0) as ArrayBuffer },
      fetch: fetchImpl,
    });

    expect(await load('1023.jpg')).toEqual(BYTES);
    expect(calls).toEqual([]);
  });

  it('explains a file name that matches no supplied file, instead of requesting it from our site', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const load = createImageLoader({
      proxyUrl: '/api/proxy-image',
      origin: ORIGIN,
      fetch: fetchImpl,
    });

    await expect(load('1024.jpg')).rejects.toThrow('No image named "1024.jpg" was provided.');
    expect(calls).toEqual([]);
  });

  it.each(['ftp://files.example.org/a.jpg', 'data:image/png;base64,AAAA', 'javascript:alert(1)'])(
    'rejects %s',
    async (source) => {
      const { calls, fetchImpl } = fakeFetch();
      const load = createImageLoader({
        proxyUrl: '/api/proxy-image',
        origin: ORIGIN,
        fetch: fetchImpl,
      });
      await expect(load(source)).rejects.toThrow();
      expect(calls).toEqual([]);
    },
  );

  it('passes on the proxy’s explanation when it refuses', async () => {
    const { fetchImpl } = fakeFetch(() =>
      Response.json(
        { error: { code: 'NOT_AN_IMAGE', message: 'The link did not return an image.' } },
        { status: 415 },
      ),
    );
    const load = createImageLoader({
      proxyUrl: '/api/proxy-image',
      origin: ORIGIN,
      fetch: fetchImpl,
    });
    await expect(load('https://school.example.org/page.html')).rejects.toThrow(
      'The link did not return an image.',
    );
  });

  it('falls back to the status code when the failure has no explanation', async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response('<html>Bad gateway</html>', { status: 502 }),
    );
    const load = createImageLoader({
      proxyUrl: '/api/proxy-image',
      origin: ORIGIN,
      fetch: fetchImpl,
    });
    await expect(load('https://school.example.org/a.jpg')).rejects.toThrow(
      'The image could not be loaded (HTTP 502).',
    );
  });

  it('asks the page for a token once for many simultaneous downloads, and again when it is stale', async () => {
    vi.useFakeTimers();
    try {
      const { calls, fetchImpl } = fakeFetch();
      let issued = 0;
      const getAuthToken = vi.fn(async () => `token-${++issued}`);
      const load = createImageLoader({
        proxyUrl: '/api/proxy-image',
        origin: ORIGIN,
        getAuthToken,
        fetch: fetchImpl,
      });

      await Promise.all(
        Array.from({ length: 8 }, (_, index) => load(`https://cdn.example.org/${index}.jpg`)),
      );
      expect(getAuthToken).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(6 * 60 * 1000);
      await load('https://cdn.example.org/later.jpg');
      expect(getAuthToken).toHaveBeenCalledTimes(2);
      expect(calls.at(-1)!.authorization).toBe('Bearer token-2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends no Authorization header when signed out', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const load = createImageLoader({
      proxyUrl: '/api/proxy-image',
      origin: ORIGIN,
      getAuthToken: async () => null,
      fetch: fetchImpl,
    });
    await load('https://cdn.example.org/a.jpg');
    expect(calls[0]!.authorization).toBeNull();
  });

  it('forwards cancellation to the request', async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response(BYTES);
    }) as typeof fetch;
    const load = createImageLoader({
      proxyUrl: '/api/proxy-image',
      origin: ORIGIN,
      fetch: fetchImpl,
    });
    const controller = new AbortController();
    await load('https://cdn.example.org/a.jpg', controller.signal);
    expect(seen).toEqual([controller.signal]);
  });
});
