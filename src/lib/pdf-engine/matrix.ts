/**
 * 2-D affine transforms in the order PDF writes them: `[a b c d e f]`, meaning
 *
 *     x' = a·x + c·y + e
 *     y' = b·x + d·y + f
 *
 * The engine never does per-shape coordinate maths. It sets up a transform for the page (undoing
 * the PDF's rotation and crop offset) and one for each placeholder (position and rotation), then
 * draws in simple local coordinates. These helpers build those transforms.
 */

export type Matrix = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function translation(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty];
}

/** Counter-clockwise rotation about the origin, in a y-up coordinate system. */
export function rotation(radians: number): Matrix {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [cos, sin, -sin, cos, 0, 0];
}

/** The transform that applies `first`, then `second`. */
function compose(first: Matrix, second: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = first;
  const [a2, b2, c2, d2, e2, f2] = second;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

/** The transform that applies each matrix in turn, left to right. */
export function chain(...matrices: Matrix[]): Matrix {
  return matrices.reduce(compose, IDENTITY);
}

/** The transform that undoes `matrix`. Throws if it collapses the plane (zero determinant). */
export function invert(matrix: Matrix): Matrix {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * d - b * c;
  if (determinant === 0) throw new Error('Matrix is not invertible');
  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ];
}

export function applyToPoint(matrix: Matrix, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = matrix;
  return [a * x + c * y + e, b * x + d * y + f];
}

export function isIdentity(matrix: Matrix, epsilon = 1e-9): boolean {
  return matrix.every((value, index) => Math.abs(value - (IDENTITY[index] as number)) <= epsilon);
}
