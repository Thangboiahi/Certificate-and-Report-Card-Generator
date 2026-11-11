import { describe, expect, it } from 'vitest';

import { computePageFrame, fitImageInBox, normalizeRotation, placeholderFrame } from './geometry';
import { applyToPoint, chain, IDENTITY, invert, isIdentity, rotation, translation } from './matrix';

const close = (actual: [number, number], expected: [number, number]) => {
  expect(actual[0]).toBeCloseTo(expected[0], 6);
  expect(actual[1]).toBeCloseTo(expected[1], 6);
};

type RectLike = { x: number; y: number; width: number; height: number };
const expectRect = (actual: RectLike, expected: RectLike) => {
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(actual[key], key).toBeCloseTo(expected[key], 6);
  }
};

describe('matrix', () => {
  it('chains transforms left to right', () => {
    // Move right by 10, then rotate a quarter turn counter-clockwise: (1, 0) → (11, 0) → (0, 11).
    const matrix = chain(translation(10, 0), rotation(Math.PI / 2));
    close(applyToPoint(matrix, 1, 0), [0, 11]);
  });

  it('inverts', () => {
    const matrix = chain(rotation(0.7), translation(12, -5), [2, 0, 0, 3, 0, 0]);
    expect(isIdentity(chain(matrix, invert(matrix)), 1e-9)).toBe(true);
    close(applyToPoint(invert(matrix), ...applyToPoint(matrix, 4, 9)), [4, 9]);
  });

  it('recognises the identity', () => {
    expect(isIdentity(IDENTITY)).toBe(true);
    expect(isIdentity(translation(0.001, 0))).toBe(false);
  });
});

describe('normalizeRotation', () => {
  it('accepts quarter turns in any form', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(-180)).toBe(180);
  });

  it('treats anything else as unrotated', () => {
    expect(normalizeRotation(45)).toBe(0);
    expect(normalizeRotation(Number.NaN)).toBe(0);
  });
});

describe('computePageFrame', () => {
  // A portrait page 200 wide and 300 tall whose coordinates start at (10, 20).
  const crop = { x: 10, y: 20, width: 200, height: 300 };
  const corners = {
    bottomLeft: [10, 20],
    bottomRight: [210, 20],
    topLeft: [10, 320],
    topRight: [210, 320],
  } as const;

  /** Where the four corners of the DISPLAYED page lie in the PDF's own coordinates. */
  function displayedCorners(rotate: number) {
    const frame = computePageFrame(crop, rotate);
    const at = (x: number, y: number) =>
      applyToPoint(frame.toUserSpace, x, y).map((value) => Math.round(value));
    return {
      size: [frame.width, frame.height],
      bottomLeft: at(0, 0),
      bottomRight: at(frame.width, 0),
      topLeft: at(0, frame.height),
      topRight: at(frame.width, frame.height),
    };
  }

  it('only offsets an unrotated page', () => {
    expect(displayedCorners(0)).toEqual({ size: [200, 300], ...corners });
  });

  it('turns the page clockwise for /Rotate 90', () => {
    // The stored bottom-left corner is shown at the top-left.
    expect(displayedCorners(90)).toEqual({
      size: [300, 200],
      topLeft: corners.bottomLeft,
      topRight: corners.topLeft,
      bottomRight: corners.topRight,
      bottomLeft: corners.bottomRight,
    });
  });

  it('turns the page upside down for /Rotate 180', () => {
    expect(displayedCorners(180)).toEqual({
      size: [200, 300],
      topLeft: corners.bottomRight,
      topRight: corners.bottomLeft,
      bottomRight: corners.topLeft,
      bottomLeft: corners.topRight,
    });
  });

  it('turns the page counter-clockwise for /Rotate 270', () => {
    expect(displayedCorners(270)).toEqual({
      size: [300, 200],
      topLeft: corners.topRight,
      topRight: corners.bottomRight,
      bottomRight: corners.bottomLeft,
      bottomLeft: corners.topLeft,
    });
  });
});

describe('placeholderFrame', () => {
  const box = { x: 50, y: 100, width: 80, height: 40 };

  it('puts the box origin at its bottom-left corner, measured from the top of the page', () => {
    const frame = placeholderFrame(box, 0, 500);
    close(applyToPoint(frame, 0, 0), [50, 360]); // 500 − 100 − 40
    close(applyToPoint(frame, 80, 40), [130, 400]);
  });

  it('rotates clockwise about the centre of the box', () => {
    const frame = placeholderFrame(box, 90, 500);
    const centre: [number, number] = [90, 380];
    close(applyToPoint(frame, 40, 20), centre);
    // The middle of the box's top edge swings to the right of the centre.
    close(applyToPoint(frame, 40, 40), [centre[0] + 20, centre[1]]);
    // The middle of its right edge swings below the centre.
    close(applyToPoint(frame, 80, 20), [centre[0], centre[1] - 40]);
  });
});

describe('fitImageInBox', () => {
  const landscape = { width: 300, height: 200 };
  const portrait = { width: 200, height: 300 };
  const square = { width: 100, height: 100 };

  it('contain: shows the whole image, centred, with bands', () => {
    expectRect(fitImageInBox(landscape, square, 'contain'), {
      x: 0,
      y: 100 / 6,
      width: 100,
      height: 200 / 3,
    });
    expectRect(fitImageInBox(portrait, square, 'contain'), {
      x: 100 / 6,
      y: 0,
      width: 200 / 3,
      height: 100,
    });
  });

  it('cover: fills the box and overflows on one axis, centred', () => {
    expectRect(fitImageInBox(landscape, square, 'cover'), {
      x: -25,
      y: 0,
      width: 150,
      height: 100,
    });
    expectRect(fitImageInBox(portrait, square, 'cover'), { x: 0, y: -25, width: 100, height: 150 });
  });

  it('fill: stretches to the box', () => {
    expectRect(fitImageInBox(landscape, square, 'fill'), { x: 0, y: 0, width: 100, height: 100 });
  });

  it('never distorts for cover and contain', () => {
    for (const fit of ['cover', 'contain'] as const) {
      for (const image of [landscape, portrait, square]) {
        const rect = fitImageInBox(image, { width: 173, height: 61 }, fit);
        expect(rect.width / rect.height).toBeCloseTo(image.width / image.height, 9);
      }
    }
  });

  it('position chooses which part of a covered image is kept', () => {
    // y = 0 keeps the top: the overflow hangs below the box (negative y in a y-up frame).
    expect(fitImageInBox(portrait, square, 'cover', { x: 0.5, y: 0 })).toMatchObject({
      x: 0,
      y: -50,
    });
    // y = 1 keeps the bottom.
    expect(fitImageInBox(portrait, square, 'cover', { x: 0.5, y: 1 }).y).toBeCloseTo(0);
    // x = 0 keeps the left edge, x = 1 the right.
    expect(fitImageInBox(landscape, square, 'cover', { x: 0, y: 0.5 }).x).toBeCloseTo(0);
    expect(fitImageInBox(landscape, square, 'cover', { x: 1, y: 0.5 }).x).toBeCloseTo(-50);
  });

  it('position chooses where a contained image sits', () => {
    expect(fitImageInBox(landscape, square, 'contain', { x: 0.5, y: 0 }).y).toBeCloseTo(100 / 3);
    expect(fitImageInBox(landscape, square, 'contain', { x: 0.5, y: 1 }).y).toBeCloseTo(0);
  });

  it('survives an image without dimensions', () => {
    expectRect(fitImageInBox({ width: 0, height: 0 }, square, 'cover'), {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
  });
});
