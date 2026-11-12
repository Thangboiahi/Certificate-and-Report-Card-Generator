/**
 * Conversions between the template's page space (PDF points from the top-left of the displayed
 * page, ADR-003) and what the editor works with on screen: percentages of the rendered page.
 *
 * Percentages make the canvas independent of screen size — a box at `left: 26.25%` sits on the same
 * spot of the artwork on a 360 px phone and a 1440 px monitor — while the stored template stays in
 * points, which is what the PDF Web Worker draws with. Nothing here touches PDF user space; the
 * engine alone converts page space to it (`src/lib/pdf-engine/geometry.ts`).
 *
 * Pure functions: shared by the store, the canvas and tests.
 */
import type { Box, Points, TemplatePage } from '@/lib/template';

/** Millimetres in one PDF point (1 pt = 1/72 in). */
export const MM_PER_POINT = 25.4 / 72;

/**
 * Stored coordinates are rounded to 1/100 pt (≈ 0.0035 mm — far below what a printer resolves) so
 * that repeated percent ↔ point conversions do not leave long floating-point tails in Firestore.
 */
export function roundPoints(value: Points): Points {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** A box expressed in percent of its page: `left`/`width` of the page width, `top`/`height` of its height. */
export interface PercentBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where a box sits on the rendered page, as CSS percentages. */
export function boxToPercent(box: Box, page: TemplatePage): PercentBox {
  return {
    left: (box.x / page.width) * 100,
    top: (box.y / page.height) * 100,
    width: (box.width / page.width) * 100,
    height: (box.height / page.height) * 100,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Keeps a box's top-left corner on the page so that the whole (unrotated) box stays inside it. A
 * box larger than the page is pinned to the top-left edge. Returns rounded points.
 */
export function clampBoxPosition(
  x: Points,
  y: Points,
  size: Pick<Box, 'width' | 'height'>,
  page: TemplatePage,
): Pick<Box, 'x' | 'y'> {
  return {
    x: roundPoints(clamp(x, 0, Math.max(0, page.width - size.width))),
    y: roundPoints(clamp(y, 0, Math.max(0, page.height - size.height))),
  };
}

/**
 * Turns a top-left position given in percent of the page into page-space points, clamped so the
 * box stays on the page.
 */
export function percentToPoints(
  xPercent: number,
  yPercent: number,
  size: Pick<Box, 'width' | 'height'>,
  page: TemplatePage,
): Pick<Box, 'x' | 'y'> {
  if (!Number.isFinite(xPercent) || !Number.isFinite(yPercent)) {
    throw new RangeError('Placeholder coordinates must be finite numbers');
  }
  return clampBoxPosition(
    (xPercent / 100) * page.width,
    (yPercent / 100) * page.height,
    size,
    page,
  );
}

/**
 * The top-left position, in percent of the page, that puts a box's centre on a point given in
 * percent of the page — what "tap the page to move the field here" needs.
 */
export function centredAtPercent(
  xPercent: number,
  yPercent: number,
  size: Pick<Box, 'width' | 'height'>,
  page: TemplatePage,
): { xPercent: number; yPercent: number } {
  return {
    xPercent: xPercent - ((size.width / page.width) * 100) / 2,
    yPercent: yPercent - ((size.height / page.height) * 100) / 2,
  };
}

/** A pointer position inside a rendered page element, in percent of that element. */
export function clientToPercent(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
): { xPercent: number; yPercent: number } {
  return {
    xPercent: ((clientX - rect.left) / rect.width) * 100,
    yPercent: ((clientY - rect.top) / rect.height) * 100,
  };
}

/** Formats points as millimetres for people, e.g. `"78.0 mm"`. */
export function formatMillimetres(value: Points): string {
  return `${(value * MM_PER_POINT).toFixed(1)} mm`;
}
