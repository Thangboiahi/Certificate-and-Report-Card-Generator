/**
 * Browser-side image editing for the upload gateway: crop with a canvas, then compress to a size
 * budget. Browser only (uses Image, canvas and Blob).
 */
import imageCompression from 'browser-image-compression';

/** Upload budget for an edited image. */
export const MAX_IMAGE_BYTES = 200 * 1024;

/** Longest side of an edited image: plenty for a photo printed a few inches wide. */
export const MAX_IMAGE_DIMENSION = 1600;

/** A crop rectangle in the image's natural pixels, as reported by react-easy-crop. */
export interface PixelCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(
        new Error('The image could not be opened. It may be damaged or in an unsupported format.'),
      );
    image.decoding = 'async';
    image.src = src;
  });
}

/**
 * Cuts `pixelCrop` out of the image at `imageSrc` and returns it as a Blob. The browser applies
 * EXIF orientation when decoding, so the crop matches what the person saw in the cropper.
 * The result is scaled down to `maxDimension` on its longest side; it is never scaled up.
 */
export async function getCroppedImg(
  imageSrc: string,
  pixelCrop: PixelCrop,
  options: { mimeType?: 'image/jpeg' | 'image/png'; maxDimension?: number } = {},
): Promise<Blob> {
  const mimeType = options.mimeType ?? 'image/jpeg';
  const maxDimension = options.maxDimension ?? MAX_IMAGE_DIMENSION;
  const image = await loadImage(imageSrc);

  const width = Math.max(1, Math.round(pixelCrop.width));
  const height = Math.max(1, Math.round(pixelCrop.height));
  const scale = Math.min(1, maxDimension / Math.max(width, height));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot edit images.');

  if (mimeType === 'image/jpeg') {
    // JPEG has no transparency; without a fill, transparent areas turn black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    image,
    Math.round(pixelCrop.x),
    Math.round(pixelCrop.y),
    width,
    height,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error('The cropped image could not be created.')),
      mimeType,
      0.92,
    );
  });
}

/**
 * Compresses an image to at most `maxBytes`. Runs on the main thread on purpose: the library's
 * Web Worker mode downloads its code from a CDN, which would add a third-party dependency at run
 * time. Inputs here are already cropped and bounded in size, so this is fast.
 */
export async function compressImage(file: File, maxBytes: number = MAX_IMAGE_BYTES): Promise<File> {
  if (file.size <= maxBytes) return file;

  let maxWidthOrHeight = MAX_IMAGE_DIMENSION;
  for (let attempt = 0; attempt < 4; attempt++) {
    const compressed = await imageCompression(file, {
      maxSizeMB: maxBytes / (1024 * 1024),
      maxWidthOrHeight,
      useWebWorker: false,
      initialQuality: 0.85,
    });
    if (compressed.size <= maxBytes) {
      return new File([compressed], file.name, { type: compressed.type, lastModified: Date.now() });
    }
    // Some images (large flat PNGs, noisy photos) need fewer pixels, not just more compression.
    maxWidthOrHeight = Math.round(maxWidthOrHeight * 0.7);
  }
  throw new Error(`The image could not be reduced below ${Math.round(maxBytes / 1024)} KB.`);
}

/** Replaces a file name's extension to match its new type: `photo.HEIC` → `photo.jpg`. */
export function renameForType(fileName: string, mimeType: string): string {
  const extension = mimeType === 'image/png' ? 'png' : 'jpg';
  const base = fileName.replace(/\.[^./\\]+$/, '') || 'image';
  return `${base}.${extension}`;
}

/** Crop then compress: the whole edit, from the original file to the upload-ready `File`. */
export async function cropAndCompress(
  imageFile: File,
  imageSrc: string,
  pixelCrop: PixelCrop,
  maxBytes: number = MAX_IMAGE_BYTES,
): Promise<File> {
  // Keep PNG for images that may be transparent (logos, signatures); photos become JPEG.
  const mimeType = imageFile.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await getCroppedImg(imageSrc, pixelCrop, { mimeType });
  const cropped = new File([blob], renameForType(imageFile.name, mimeType), {
    type: mimeType,
    lastModified: Date.now(),
  });
  return compressImage(cropped, maxBytes);
}
