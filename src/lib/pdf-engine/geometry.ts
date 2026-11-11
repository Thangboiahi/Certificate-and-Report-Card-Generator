/**
 * Geometry: from the template's "page space" to where pdf-lib must draw.
 *
 * Three coordinate systems are involved:
 *
 *   page space      — what the template stores. Points, origin at the TOP-left of the page as a
 *                     viewer shows it, y down.
 *   display frame   — the same displayed page, but origin BOTTOM-left and y up (PDF's direction).
 *   PDF user space  — the page's raw coordinates: before its /Rotate is applied and including
 *                     any /CropBox offset. This is what pdf-lib draws in.
 *
 * `computePageFrame` yields the display-frame → user-space transform for a page; `placeholderFrame`
 * yields the transform from a placeholder's own box (origin at its bottom-left corner, y up,
 * unrotated) to the display frame. With both applied, drawing code only ever works in simple
 * box-local coordinates and stays correct on rotated or cropped PDFs.
 */
import type { Box, ImageFit, ImagePosition } from '@/lib/template/types';

import { chain, rotation, translation, type Matrix } from './matrix';

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

export type QuarterTurn = 0 | 90 | 180 | 270;

/** Normalises a PDF /Rotate value. Anything that is not a multiple of 90° is invalid → 0. */
export function normalizeRotation(degrees: number): QuarterTurn {
  const turned = ((Math.round(degrees) % 360) + 360) % 360;
  return turned === 90 || turned === 180 || turned === 270 ? turned : 0;
}

export interface PageFrame extends Size {
  /** Display frame → PDF user space. */
  toUserSpace: Matrix;
}

/**
 * Describes how a page is displayed. `cropBox` is the visible region in user space and
 * `rotationDegrees` the page's /Rotate entry (clockwise, applied by the viewer).
 */
export function computePageFrame(cropBox: Rect, rotationDegrees: number): PageFrame {
  const { x, y, width, height } = cropBox;

  switch (normalizeRotation(rotationDegrees)) {
    case 0:
      return { width, height, toUserSpace: [1, 0, 0, 1, x, y] };
    case 90:
      // The viewer turns the page clockwise: display-right is user-space up.
      return { width: height, height: width, toUserSpace: [0, 1, -1, 0, x + width, y] };
    case 180:
      return { width, height, toUserSpace: [-1, 0, 0, -1, x + width, y + height] };
    case 270:
      return { width: height, height: width, toUserSpace: [0, -1, 1, 0, x, y + height] };
  }
}

/**
 * Box-local coordinates → display frame, for a placeholder on a page of the given displayed
 * height. `rotationDegrees` turns the box clockwise about its centre.
 */
export function placeholderFrame(box: Box, rotationDegrees: number, pageHeight: number): Matrix {
  const bottom = pageHeight - box.y - box.height;
  const place = translation(box.x, bottom);
  if (!rotationDegrees) return place;

  const halfWidth = box.width / 2;
  const halfHeight = box.height / 2;
  // Clockwise on the page is a negative angle in a y-up system.
  const radians = (-rotationDegrees * Math.PI) / 180;
  return chain(
    translation(-halfWidth, -halfHeight),
    rotation(radians),
    translation(halfWidth, halfHeight),
    place,
  );
}

/**
 * Where to draw an image of size `image` inside a box of size `box` — CSS `object-fit` plus
 * `object-position`. The result is in box-local coordinates (origin bottom-left, y up) and never
 * changes the image's aspect ratio except for `fill`. For `cover` the rectangle is larger than
 * the box on one axis; the caller clips to the box.
 */
export function fitImageInBox(
  image: Size,
  box: Size,
  fit: ImageFit,
  position: ImagePosition = { x: 0.5, y: 0.5 },
): Rect {
  if (fit === 'fill' || image.width <= 0 || image.height <= 0) {
    return { x: 0, y: 0, width: box.width, height: box.height };
  }

  const scaleX = box.width / image.width;
  const scaleY = box.height / image.height;
  const scale = fit === 'cover' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
  const width = image.width * scale;
  const height = image.height * scale;

  return {
    // `position` distributes the difference between box and image: empty space for `contain`
    // (positive), cropped overflow for `cover` (negative). The same formula serves both.
    x: (box.width - width) * position.x,
    // position.y = 0 means "keep the top"; in a y-up frame the top is the larger y.
    y: (box.height - height) * (1 - position.y),
    width,
    height,
  };
}
