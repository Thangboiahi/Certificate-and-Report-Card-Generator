/**
 * Prepares photos in the browser before they are embedded in a PDF.
 *
 * Two jobs, both done with an OffscreenCanvas so they work inside the Worker:
 *
 *   - Shrink. A 4000 × 3000 phone photo placed in a one-inch box needs about 300 × 300 pixels to
 *     print perfectly. Embedding the original would make every document megabytes larger for no
 *     visible gain — and a batch of 500 would not fit in a phone's memory.
 *   - Convert. pdf-lib can only embed JPEG and PNG; the browser can decode WebP, GIF, AVIF and
 *     more, and re-encode them.
 *
 * The browser applies EXIF rotation while decoding, so processed photos are already upright.
 */
import { IMAGE_MIME_TYPES } from '@/lib/images/sniff';
import type { ImageProcessor } from '@/lib/pdf-engine';

/** Below this much reduction a JPEG/PNG is left alone: re-encoding would only cost quality. */
const MIN_USEFUL_SCALE = 0.85;
const JPEG_QUALITY = 0.88;

/** Formats that can carry transparency, which JPEG would turn black. */
const MAY_HAVE_ALPHA = new Set(['png', 'webp', 'gif', 'avif']);

async function hasTransparency(
  context: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
) {
  const { data } = context.getImageData(0, 0, width, height);
  for (let index = 3; index < data.length; index += 4) {
    if ((data[index] as number) < 255) return true;
  }
  return false;
}

/**
 * Returns an image processor, or `undefined` in an environment without OffscreenCanvas (very old
 * browsers; Node). Without it the engine still works, embedding JPEG and PNG as they are.
 */
export function createCanvasImageProcessor(): ImageProcessor | undefined {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    return undefined;
  }

  // Decoding a large photo needs tens of megabytes for a moment. Downloads run several at a time;
  // decoding is done strictly one at a time so that memory use stays flat on low-end phones.
  let queue: Promise<unknown> = Promise.resolve();

  const process: ImageProcessor = async ({ bytes, format, targetWidth, targetHeight }) => {
    const embeddable = format === 'jpeg' || format === 'png';
    const source = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: IMAGE_MIME_TYPES[format] });
    const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });

    try {
      // Keep enough pixels to cover the box in both directions; never enlarge.
      const scale = Math.min(1, Math.max(targetWidth / bitmap.width, targetHeight / bitmap.height));
      if (embeddable && scale > MIN_USEFUL_SCALE) return null;

      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, width, height);

      const keepAlpha =
        MAY_HAVE_ALPHA.has(format) && (await hasTransparency(context, width, height));
      const encoded = await canvas.convertToBlob(
        keepAlpha ? { type: 'image/png' } : { type: 'image/jpeg', quality: JPEG_QUALITY },
      );
      const result = new Uint8Array(await encoded.arrayBuffer());

      // Re-encoding a small or already well-compressed file can make it bigger.
      if (embeddable && result.byteLength >= bytes.byteLength) return null;
      return { bytes: result, format: keepAlpha ? 'png' : 'jpeg' };
    } finally {
      bitmap.close();
    }
  };

  return (request) => {
    const result = queue.then(() => process(request));
    queue = result.catch(() => undefined);
    return result;
  };
}
