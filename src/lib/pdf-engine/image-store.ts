/**
 * Images for a job: downloaded at most once, a few at a time, and kept only while useful.
 *
 * - A logo or signature that appears on every row is fetched (and processed) once.
 * - Downloads run with bounded concurrency, and rows that have not been reached yet can be
 *   prefetched so the network works while the CPU builds PDFs.
 * - Memory is bounded: the least recently used images are dropped once the cache exceeds its
 *   budget. Failures are remembered too, so a dead link is not retried for every row.
 */
import { detectImageFormat, type ImageFormat } from '@/lib/images/sniff';

import type { ImageLoader, ImageProcessor, WarningCode } from './types';

/** An image ready to be embedded: verified, and already converted/resized if a processor ran. */
export interface PreparedImage {
  bytes: Uint8Array;
  format: ImageFormat;
}

export interface ImageRequest {
  /** What the placeholder resolved to — normally a URL. */
  source: string;
  /** Pixel size needed to look sharp in the placeholder's box. */
  targetWidth: number;
  targetHeight: number;
}

/** Why an image cannot be used. `code` becomes the row warning's code. */
export class ImageError extends Error {
  constructor(
    readonly code: Extract<WarningCode, `IMAGE_${string}`>,
    message: string,
  ) {
    super(message);
    this.name = 'ImageError';
  }
}

export interface ImageStoreOptions {
  loadImage: ImageLoader;
  processImage?: ImageProcessor;
  /** Maximum simultaneous downloads. */
  concurrency: number;
  /** Budget for cached image bytes. */
  maxCachedBytes: number;
  signal?: AbortSignal;
}

interface Entry {
  promise: Promise<PreparedImage>;
  /** Size once resolved; 0 while pending or after a failure. */
  byteLength: number;
}

export class ImageStore {
  private readonly entries = new Map<string, Entry>();
  private cachedBytes = 0;
  private activeDownloads = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly options: ImageStoreOptions) {}

  /** Identifies a request; also used as the per-document embedding key. */
  keyOf(request: ImageRequest): string {
    // The target size only affects the result when a processor can resize.
    return this.options.processImage
      ? `${request.source}\u0000${request.targetWidth}x${request.targetHeight}`
      : request.source;
  }

  /** Resolves with the prepared image, or rejects with an `ImageError`. */
  get(request: ImageRequest): Promise<PreparedImage> {
    const key = this.keyOf(request);
    const existing = this.entries.get(key);
    if (existing) {
      // Re-insert to mark it as the most recently used.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.promise;
    }

    const entry: Entry = { promise: this.prepare(request), byteLength: 0 };
    this.entries.set(key, entry);
    entry.promise.then(
      (image) => {
        // Only account for it if it is still cached (it may have been evicted while pending).
        if (this.entries.get(key) !== entry) return;
        entry.byteLength = image.bytes.byteLength;
        this.cachedBytes += entry.byteLength;
        this.evict(key);
      },
      () => {
        // Failures stay cached (they hold no bytes). Handled here so a prefetch that nobody has
        // awaited yet does not surface as an unhandled rejection.
      },
    );
    return entry.promise;
  }

  /** Starts loading an image that a later row will need. Never throws. */
  prefetch(request: ImageRequest): void {
    void this.get(request).catch(() => undefined);
  }

  private evict(justAdded: string): void {
    if (this.cachedBytes <= this.options.maxCachedBytes) return;
    for (const [key, entry] of this.entries) {
      if (this.cachedBytes <= this.options.maxCachedBytes) break;
      if (key === justAdded || entry.byteLength === 0) continue;
      this.entries.delete(key);
      this.cachedBytes -= entry.byteLength;
    }
  }

  private async prepare(request: ImageRequest): Promise<PreparedImage> {
    const bytes = await this.download(request.source);

    const format = detectImageFormat(bytes);
    if (!format) {
      throw new ImageError('IMAGE_INVALID', 'The file is not an image.');
    }

    const { processImage } = this.options;
    if (processImage) {
      try {
        const processed = await processImage({
          bytes,
          format,
          targetWidth: request.targetWidth,
          targetHeight: request.targetHeight,
        });
        if (processed) return processed;
      } catch {
        // Processing is an optimisation for JPEG/PNG and a requirement for everything else; the
        // check below turns the latter into a clear message.
      }
    }

    if (format !== 'jpeg' && format !== 'png') {
      throw new ImageError(
        'IMAGE_UNSUPPORTED_FORMAT',
        `${format.toUpperCase()} images cannot be used on this device. Use JPG or PNG.`,
      );
    }
    return { bytes, format };
  }

  private async download(source: string): Promise<Uint8Array> {
    // Wait for a free slot. A finishing download hands its slot straight to the next waiter, so
    // the limit is never exceeded.
    if (this.activeDownloads >= this.options.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.activeDownloads++;
    }

    try {
      return await this.options.loadImage(source, this.options.signal);
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : 'Unknown error';
      throw new ImageError('IMAGE_LOAD_FAILED', reason);
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.activeDownloads--;
    }
  }
}
