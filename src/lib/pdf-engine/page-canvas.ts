/**
 * A page being drawn on.
 *
 * `PageCanvas` wraps a pdf-lib page with the two things every placeholder needs:
 *
 *   1. Coordinate frames. `open()` installs the display-frame transform for the page (undoing
 *      its rotation and crop offset); `drawInBox()` adds a placeholder's own position and
 *      rotation. Inside `drawInBox`, (0, 0) is the box's bottom-left corner and y points up,
 *      whatever the PDF underneath looks like.
 *   2. Page resources. Fonts, images and transparency settings must be registered on a page
 *      before use; the canvas registers each once and hands out its name.
 *
 * Everything is emitted as raw PDF operators through pdf-lib, which is how the engine gets
 * features pdf-lib's high-level API lacks (clipping, glyph positioning, EXIF rotation).
 */
import {
  concatTransformationMatrix,
  popGraphicsState,
  pushGraphicsState,
  setGraphicsState,
  type PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFName,
  type PDFOperator,
  type PDFPage,
} from 'pdf-lib';

import type { Box } from '@/lib/template/types';

import { placeholderFrame, type PageFrame, type Size } from './geometry';
import { isIdentity, type Matrix } from './matrix';

/** Rounds a coordinate for output. 1/10000 pt is far below print resolution and keeps files small. */
export function round(value: number): number {
  const rounded = Math.round(value * 10_000) / 10_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** A `cm` operator for the given transform. */
export function transform(matrix: Matrix): PDFOperator {
  const [a, b, c, d, e, f] = matrix;
  // Scale/rotation terms keep more digits: a small error there is multiplied by the page size.
  const fine = (value: number) => Math.round(value * 1e8) / 1e8;
  return concatTransformationMatrix(fine(a), fine(b), fine(c), fine(d), round(e), round(f));
}

export class PageCanvas {
  private readonly fontNames = new Map<PDFFont, PDFName>();
  private readonly imageNames = new Map<PDFImage, PDFName>();
  private readonly opacityNames = new Map<number, PDFName>();
  private isOpen = false;

  constructor(
    readonly document: PDFDocument,
    readonly page: PDFPage,
    readonly frame: PageFrame,
  ) {}

  push(...operators: PDFOperator[]): void {
    this.page.pushOperators(...operators);
  }

  /** Starts drawing in the display frame. Idempotent. */
  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.push(pushGraphicsState());
    if (!isIdentity(this.frame.toUserSpace)) this.push(transform(this.frame.toUserSpace));
  }

  /** Restores the page's graphics state. Call once after the last placeholder. */
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.push(popGraphicsState());
  }

  /**
   * Runs `draw` in the placeholder's own coordinate system (origin at the bottom-left corner of
   * `box`, y up, rotation applied) with `opacity` in effect. Whatever `draw` changes — clipping,
   * colours — is undone afterwards.
   */
  drawInBox(box: Box, rotationDegrees: number, opacity: number, draw: (size: Size) => void): void {
    this.open();
    this.push(
      pushGraphicsState(),
      transform(placeholderFrame(box, rotationDegrees, this.frame.height)),
    );
    if (opacity < 1) this.push(setGraphicsState(this.opacityName(opacity)));
    try {
      draw({ width: box.width, height: box.height });
    } finally {
      this.push(popGraphicsState());
    }
  }

  /** The resource name of a font on this page. */
  fontName(font: PDFFont): PDFName {
    let name = this.fontNames.get(font);
    if (!name) {
      name = this.page.node.newFontDictionary(font.name, font.ref);
      this.fontNames.set(font, name);
    }
    return name;
  }

  /** The resource name of an image on this page. */
  imageName(image: PDFImage): PDFName {
    let name = this.imageNames.get(image);
    if (!name) {
      name = this.page.node.newXObject('Image', image.ref);
      this.imageNames.set(image, name);
    }
    return name;
  }

  private opacityName(opacity: number): PDFName {
    const alpha = Math.min(1, Math.max(0, round(opacity)));
    let name = this.opacityNames.get(alpha);
    if (!name) {
      // `ca` is the alpha for fills (text, images, QR modules); `CA` for strokes (borders).
      const state = this.document.context.obj({ Type: 'ExtGState', ca: alpha, CA: alpha });
      name = this.page.node.newExtGState('GS', state);
      this.opacityNames.set(alpha, name);
    }
    return name;
  }
}
