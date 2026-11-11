/**
 * Drawing an image placeholder: embed the bytes, then paint them into the box without distortion.
 *
 * pdf-lib embeds JPEG data untouched and has no notion of cropping, masks or EXIF rotation, so
 * this file supplies them with raw operators:
 *   - the box's outline (rectangle, rounded rectangle or ellipse) becomes a clipping path;
 *   - the image is scaled per `object-fit` and painted through that clip;
 *   - the EXIF orientation is folded into the image's transform.
 */
import {
  appendBezierCurve,
  clip,
  closePath,
  drawObject,
  endPath,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingColor,
  setLineWidth,
  setStrokingColor,
  stroke,
  type PDFDocument,
  type PDFImage,
  type PDFOperator,
} from 'pdf-lib';

import { orientationSwapsAxes, readJpegOrientation, type ExifOrientation } from '@/lib/images/exif';
import type { ImagePlaceholder, ImageShape } from '@/lib/template/types';

import { hexToRgb } from './draw-text';
import { fitImageInBox, type Size } from './geometry';
import { ImageError, type PreparedImage } from './image-store';
import { chain, type Matrix } from './matrix';
import { round, transform, type PageCanvas } from './page-canvas';

/** An image inside one output document. */
export interface EmbeddedImage {
  image: PDFImage;
  /** Size as it should be displayed, i.e. with the EXIF orientation applied. */
  size: Size;
  orientation: ExifOrientation;
}

/**
 * Turns the unit square the image is stored in so that it displays upright, for each EXIF
 * orientation. PDF paints an image into the unit square with the stored top row at y = 1.
 * (Derivation: docs/ARCHITECTURE.md, "EXIF orientation".)
 */
const ORIENTATION_TRANSFORMS: Record<ExifOrientation, Matrix> = {
  1: [1, 0, 0, 1, 0, 0],
  2: [-1, 0, 0, 1, 1, 0], // mirrored left-right
  3: [-1, 0, 0, -1, 1, 1], // upside down
  4: [1, 0, 0, -1, 0, 1], // mirrored top-bottom
  5: [0, -1, -1, 0, 1, 1], // mirrored along the top-left diagonal
  6: [0, -1, 1, 0, 0, 1], // needs a quarter turn clockwise (typical portrait phone photo)
  7: [0, 1, 1, 0, 0, 0], // mirrored along the top-right diagonal
  8: [0, 1, -1, 0, 1, 0], // needs a quarter turn counter-clockwise
};

/** Adds an image to a document. Rejects with `ImageError` when the bytes are damaged. */
export async function embedImage(
  document: PDFDocument,
  prepared: PreparedImage,
): Promise<EmbeddedImage> {
  try {
    if (prepared.format === 'jpeg') {
      const orientation = readJpegOrientation(prepared.bytes);
      const image = await document.embedJpg(prepared.bytes);
      const size = orientationSwapsAxes(orientation)
        ? { width: image.height, height: image.width }
        : { width: image.width, height: image.height };
      return { image, size, orientation };
    }
    if (prepared.format === 'png') {
      const image = await document.embedPng(prepared.bytes);
      return { image, size: { width: image.width, height: image.height }, orientation: 1 };
    }
  } catch {
    throw new ImageError('IMAGE_INVALID', 'The image file is damaged and could not be read.');
  }
  throw new ImageError(
    'IMAGE_UNSUPPORTED_FORMAT',
    `${prepared.format.toUpperCase()} images cannot be embedded. Use JPG or PNG.`,
  );
}

/** How far a Bézier control point sits from a quarter circle's end point, per unit radius. */
const KAPPA = 0.5522847498;

/**
 * Path operators for a shape filling a box of `size`, shrunk by `inset` on every side. Runs
 * counter-clockwise from the bottom edge.
 */
function outline(shape: ImageShape, size: Size, inset: number): PDFOperator[] {
  const left = inset;
  const bottom = inset;
  const width = Math.max(0, size.width - 2 * inset);
  const height = Math.max(0, size.height - 2 * inset);
  const right = left + width;
  const top = bottom + height;

  let radiusX = 0;
  let radiusY = 0;
  if (shape.kind === 'ellipse') {
    radiusX = width / 2;
    radiusY = height / 2;
  } else if (shape.kind === 'rounded') {
    radiusX = radiusY = Math.max(0, Math.min(shape.radius - inset, width / 2, height / 2));
  }
  if (radiusX === 0 || radiusY === 0) {
    return [rectangle(round(left), round(bottom), round(width), round(height))];
  }

  const controlX = radiusX * KAPPA;
  const controlY = radiusY * KAPPA;
  const curve = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) =>
    appendBezierCurve(round(x1), round(y1), round(x2), round(y2), round(x), round(y));

  return [
    moveTo(round(left + radiusX), round(bottom)),
    lineTo(round(right - radiusX), round(bottom)),
    curve(
      right - radiusX + controlX,
      bottom,
      right,
      bottom + radiusY - controlY,
      right,
      bottom + radiusY,
    ),
    lineTo(round(right), round(top - radiusY)),
    curve(right, top - radiusY + controlY, right - radiusX + controlX, top, right - radiusX, top),
    lineTo(round(left + radiusX), round(top)),
    curve(left + radiusX - controlX, top, left, top - radiusY + controlY, left, top - radiusY),
    lineTo(round(left), round(bottom + radiusY)),
    curve(
      left,
      bottom + radiusY - controlY,
      left + radiusX - controlX,
      bottom,
      left + radiusX,
      bottom,
    ),
    closePath(),
  ];
}

/** Paints an embedded image into the placeholder's box. */
export function drawImage(
  canvas: PageCanvas,
  placeholder: ImagePlaceholder,
  embedded: EmbeddedImage,
): void {
  const shape: ImageShape = placeholder.shape ?? { kind: 'rectangle' };
  const { background, border } = placeholder;

  canvas.drawInBox(placeholder.box, placeholder.rotation ?? 0, placeholder.opacity ?? 1, (size) => {
    if (background) {
      canvas.push(setFillingColor(hexToRgb(background)), ...outline(shape, size, 0), fill());
    }

    const target = fitImageInBox(embedded.size, size, placeholder.fit, placeholder.position);
    // Unit square → upright unit square → the target rectangle.
    const placement = chain(ORIENTATION_TRANSFORMS[embedded.orientation], [
      target.width,
      0,
      0,
      target.height,
      target.x,
      target.y,
    ]);

    canvas.push(
      pushGraphicsState(),
      ...outline(shape, size, 0),
      clip(),
      endPath(),
      transform(placement),
      drawObject(canvas.imageName(embedded.image)),
      popGraphicsState(),
    );

    if (border) {
      // Inset by half the line width so the whole stroke stays inside the box.
      canvas.push(
        setStrokingColor(hexToRgb(border.color)),
        setLineWidth(round(border.width)),
        ...outline(shape, size, border.width / 2),
        stroke(),
      );
    }
  });
}
