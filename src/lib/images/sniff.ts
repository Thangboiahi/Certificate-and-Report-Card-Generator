/**
 * Identify an image by its leading "magic" bytes.
 *
 * File extensions and `Content-Type` headers are claims; the bytes are evidence. Both sides of
 * the pipeline use this: the proxy refuses to relay anything that is not really an image, and the
 * engine picks the right embedder (pdf-lib only understands JPEG and PNG natively).
 *
 * No Node or browser APIs — safe to import anywhere.
 */

export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'bmp' | 'avif' | 'heic' | 'tiff';

export const IMAGE_MIME_TYPES: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  tiff: 'image/tiff',
};

/** How many leading bytes `detectImageFormat` needs to recognise every supported format. */
export const SNIFF_BYTES = 16;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  if (bytes.length < start + length) return '';
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

/** Returns the image format the bytes begin with, or `null` if they are not a known image. */
export function detectImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (ascii(bytes, 0, 2) === 'BM' && bytes.length >= 14) return 'bmp';
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'tiff';
  }
  // ISO base media files (AVIF, HEIC) start with a box: 4-byte size, "ftyp", then the major brand.
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (AVIF_BRANDS.has(brand)) return 'avif';
    if (HEIC_BRANDS.has(brand)) return 'heic';
  }
  return null;
}
