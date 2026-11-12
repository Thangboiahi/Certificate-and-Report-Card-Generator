import { describe, expect, it } from 'vitest';

import {
  boxToPercent,
  centredAtPercent,
  clampBoxPosition,
  clientToPercent,
  formatMillimetres,
  percentToPoints,
  roundPoints,
} from './coordinates';

const A4_LANDSCAPE = { width: 842, height: 595 };
const BOX = { x: 221, y: 204, width: 400, height: 54 };

describe('editor coordinates', () => {
  it('expresses a box in percent of its page', () => {
    const percent = boxToPercent(BOX, A4_LANDSCAPE);
    expect(percent.left).toBeCloseTo((221 / 842) * 100, 10);
    expect(percent.top).toBeCloseTo((204 / 595) * 100, 10);
    expect(percent.width).toBeCloseTo((400 / 842) * 100, 10);
    expect(percent.height).toBeCloseTo((54 / 595) * 100, 10);
  });

  it('round-trips percent → points exactly for every whole-point position', () => {
    for (let x = 0; x <= A4_LANDSCAPE.width - BOX.width; x += 1) {
      const y = (x * 7) % (A4_LANDSCAPE.height - BOX.height);
      const percent = boxToPercent({ ...BOX, x, y }, A4_LANDSCAPE);
      expect(percentToPoints(percent.left, percent.top, BOX, A4_LANDSCAPE)).toEqual({ x, y });
    }
  });

  it('keeps the whole box on the page', () => {
    expect(percentToPoints(-10, -5, BOX, A4_LANDSCAPE)).toEqual({ x: 0, y: 0 });
    expect(percentToPoints(99, 99, BOX, A4_LANDSCAPE)).toEqual({ x: 442, y: 541 });
    // A box wider than the page is pinned to the left edge.
    expect(clampBoxPosition(30, 10, { width: 900, height: 10 }, A4_LANDSCAPE)).toEqual({
      x: 0,
      y: 10,
    });
  });

  it('rounds stored points to 1/100 pt and never produces -0', () => {
    expect(roundPoints(12.345678)).toBe(12.35);
    expect(Object.is(roundPoints(-0.001), 0)).toBe(true);
  });

  it('rejects non-finite input', () => {
    expect(() => percentToPoints(Number.NaN, 0, BOX, A4_LANDSCAPE)).toThrow(RangeError);
  });

  it('centres a box on a tapped point', () => {
    const tap = { xPercent: 50, yPercent: 50 };
    const corner = centredAtPercent(tap.xPercent, tap.yPercent, BOX, A4_LANDSCAPE);
    const points = percentToPoints(corner.xPercent, corner.yPercent, BOX, A4_LANDSCAPE);
    expect(points.x + BOX.width / 2).toBeCloseTo(421, 2);
    expect(points.y + BOX.height / 2).toBeCloseTo(297.5, 2);
  });

  it('maps a pointer position inside the rendered page to percent', () => {
    const rect = { left: 12, top: 100, width: 366, height: 258.66 };
    expect(clientToPercent(12 + 183, 100 + 129.33, rect)).toEqual({ xPercent: 50, yPercent: 50 });
  });

  it('formats millimetres for people', () => {
    expect(formatMillimetres(72)).toBe('25.4 mm');
  });
});
