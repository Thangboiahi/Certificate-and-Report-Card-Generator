/**
 * Wraps an uploaded PNG or JPEG in a one-page PDF so a scanned or exported certificate can be
 * used as a template background like any other PDF.
 *
 * The page is sized to the image's aspect ratio with its longer side set to A4's long edge
 * (842 pt): a 300 dpi scan would otherwise become a several-thousand-point page, which makes every
 * font size in the editor look tiny.
 */
import { PDFDocument } from 'pdf-lib';

import { EngineError } from './errors';

const LONG_EDGE_POINTS = 842;

export async function imageToPdf(
  image: Uint8Array | ArrayBuffer,
  mimeType: 'image/png' | 'image/jpeg',
): Promise<Uint8Array> {
  const bytes = image instanceof Uint8Array ? image : new Uint8Array(image);
  const document = await PDFDocument.create();
  let embedded;
  try {
    embedded =
      mimeType === 'image/png' ? await document.embedPng(bytes) : await document.embedJpg(bytes);
  } catch {
    throw new EngineError(
      'TEMPLATE_PDF_UNREADABLE',
      'That image could not be read. Try a PNG or JPG.',
    );
  }
  const scale = LONG_EDGE_POINTS / Math.max(embedded.width, embedded.height);
  const width = embedded.width * scale;
  const height = embedded.height * scale;
  const page = document.addPage([width, height]);
  page.drawImage(embedded, { x: 0, y: 0, width, height });
  return document.save();
}
