import { describe, expect, it, vi } from 'vitest';

import { fixtureImage } from '../../../tests/support/engine-fixtures';
import { ImageError, ImageStore, type ImageRequest } from './image-store';
import type { ImageLoader, ImageProcessor } from './types';

const request = (source: string, size = 100): ImageRequest => ({
  source,
  targetWidth: size,
  targetHeight: size,
});

const JPEG = fixtureImage('landscape.jpg');
const WEBP = fixtureImage('landscape.webp');

function createStore(
  loadImage: ImageLoader,
  options: { concurrency?: number; maxCachedBytes?: number; processImage?: ImageProcessor } = {},
): ImageStore {
  return new ImageStore({
    loadImage,
    processImage: options.processImage,
    concurrency: options.concurrency ?? 4,
    maxCachedBytes: options.maxCachedBytes ?? 1024 * 1024,
  });
}

async function failure(promise: Promise<unknown>): Promise<ImageError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ImageError);
    return error as ImageError;
  }
  throw new Error('Expected the promise to reject');
}

describe('ImageStore', () => {
  it('returns the bytes and the detected format', async () => {
    const store = createStore(async () => JPEG);
    expect(await store.get(request('a'))).toEqual({ bytes: JPEG, format: 'jpeg' });
  });

  it('downloads an image once however many rows use it', async () => {
    const load = vi.fn(async () => JPEG);
    const store = createStore(load);
    await Promise.all([
      store.get(request('logo')),
      store.get(request('logo')),
      store.get(request('logo')),
    ]);
    await store.get(request('logo'));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never runs more downloads at once than allowed', async () => {
    let active = 0;
    let peak = 0;
    const store = createStore(
      async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return JPEG;
      },
      { concurrency: 3 },
    );
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.get(request(`image-${index}`))),
    );
    expect(peak).toBe(3);
  });

  it('starts queued downloads in the order they were requested', async () => {
    const started: string[] = [];
    const store = createStore(
      async (source) => {
        started.push(source);
        await new Promise((resolve) => setTimeout(resolve, 2));
        return JPEG;
      },
      { concurrency: 1 },
    );
    await Promise.all(['a', 'b', 'c', 'd'].map((source) => store.get(request(source))));
    expect(started).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reports a failed download with the loader’s message, and does not retry it', async () => {
    const load = vi.fn(async () => {
      throw new Error('The image host answered with HTTP 404.');
    });
    const store = createStore(load);

    const first = await failure(store.get(request('missing')));
    expect(first.code).toBe('IMAGE_LOAD_FAILED');
    expect(first.message).toBe('The image host answered with HTTP 404.');

    await failure(store.get(request('missing')));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('frees its download slot after a failure', async () => {
    const store = createStore(
      async (source) => {
        if (source === 'bad') throw new Error('nope');
        return JPEG;
      },
      { concurrency: 1 },
    );
    await failure(store.get(request('bad')));
    expect((await store.get(request('good'))).format).toBe('jpeg');
  });

  it('rejects bytes that are not an image', async () => {
    const store = createStore(async () =>
      new TextEncoder().encode('<html>Sign in to continue</html>'),
    );
    expect((await failure(store.get(request('page')))).code).toBe('IMAGE_INVALID');
  });

  it('refuses formats that cannot be embedded when there is no processor', async () => {
    const store = createStore(async () => WEBP);
    const error = await failure(store.get(request('photo.webp')));
    expect(error.code).toBe('IMAGE_UNSUPPORTED_FORMAT');
    expect(error.message).toContain('WEBP');
  });

  it('prefetch never produces an unhandled rejection', async () => {
    const store = createStore(async () => {
      throw new Error('offline');
    });
    store.prefetch(request('a'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await failure(store.get(request('a')))).code).toBe('IMAGE_LOAD_FAILED');
  });

  describe('memory budget', () => {
    it('drops the least recently used images once over budget', async () => {
      const load = vi.fn(async () => JPEG);
      // Room for two copies of the fixture, not three.
      const store = createStore(load, { maxCachedBytes: JPEG.byteLength * 2 + 10 });

      await store.get(request('a'));
      await store.get(request('b'));
      await store.get(request('a')); // touch "a": "b" is now the oldest
      await store.get(request('c')); // evicts "b"
      expect(load).toHaveBeenCalledTimes(3);

      await store.get(request('a'));
      await store.get(request('c'));
      expect(load).toHaveBeenCalledTimes(3);

      await store.get(request('b'));
      expect(load).toHaveBeenCalledTimes(4);
    });

    it('still serves an image larger than the whole budget', async () => {
      const store = createStore(async () => JPEG, { maxCachedBytes: 10 });
      expect((await store.get(request('big'))).bytes).toBe(JPEG);
    });
  });

  describe('with a processor', () => {
    const SMALL = new Uint8Array(JPEG.subarray(0, 600));

    it('uses the processed image and passes the target size', async () => {
      const process = vi.fn<ImageProcessor>(async () => ({ bytes: SMALL, format: 'jpeg' }));
      const store = createStore(async () => WEBP, { processImage: process });

      expect(
        await store.get({ source: 'photo.webp', targetWidth: 300, targetHeight: 375 }),
      ).toEqual({
        bytes: SMALL,
        format: 'jpeg',
      });
      expect(process).toHaveBeenCalledWith({
        bytes: WEBP,
        format: 'webp',
        targetWidth: 300,
        targetHeight: 375,
      });
    });

    it('keeps the original when the processor declines', async () => {
      const store = createStore(async () => JPEG, { processImage: async () => null });
      expect((await store.get(request('a'))).bytes).toBe(JPEG);
    });

    it('falls back to the original JPEG or PNG when processing fails', async () => {
      const store = createStore(async () => JPEG, {
        processImage: async () => {
          throw new Error('out of memory');
        },
      });
      expect((await store.get(request('a'))).bytes).toBe(JPEG);
    });

    it('reports an unsupported format when processing fails for anything else', async () => {
      const store = createStore(async () => WEBP, {
        processImage: async () => {
          throw new Error('cannot decode');
        },
      });
      expect((await failure(store.get(request('a')))).code).toBe('IMAGE_UNSUPPORTED_FORMAT');
    });

    it('treats the same image at two target sizes as two entries', async () => {
      const process = vi.fn<ImageProcessor>(async () => null);
      const load = vi.fn(async () => JPEG);
      const store = createStore(load, { processImage: process });

      await store.get(request('a', 100));
      await store.get(request('a', 100));
      await store.get(request('a', 400));
      expect(process).toHaveBeenCalledTimes(2);
      expect(store.keyOf(request('a', 100))).not.toBe(store.keyOf(request('a', 400)));
    });

    it('ignores the target size in the key when nothing can resize', () => {
      const store = createStore(async () => JPEG);
      expect(store.keyOf(request('a', 100))).toBe(store.keyOf(request('a', 400)));
    });
  });
});
