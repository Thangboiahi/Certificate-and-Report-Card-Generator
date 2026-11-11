/**
 * Drawing a QR code as vector squares.
 *
 * Vector modules stay perfectly sharp at any print size and cost a few hundred bytes. All dark
 * modules go into ONE path that is filled once: renderers anti-alias a path as a whole, so
 * neighbouring modules join without the hairline gaps that separately filled squares show.
 */
import qrcode from 'qrcode-generator';
import { fill, rectangle, setFillingColor, type PDFOperator } from 'pdf-lib';

import type { QrPlaceholder } from '@/lib/template/types';

import { hexToRgb } from './draw-text';
import { round, type PageCanvas } from './page-canvas';

/** The dark/light grid of a QR code. `isDark(row, column)`, row 0 at the top. */
export interface QrMatrix {
  size: number;
  isDark(row: number, column: number): boolean;
}

/**
 * Encodes `value` (as UTF-8, so any language works). Returns `null` when the value is too long
 * for a QR code at this error-correction level.
 */
export function createQrMatrix(
  value: string,
  errorCorrection: QrPlaceholder['errorCorrection'],
): QrMatrix | null {
  // The library's byte mode takes one byte per character code; feeding it UTF-8 bytes this way
  // avoids switching its global string encoder.
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);

  try {
    const code = qrcode(0, errorCorrection);
    code.addData(binary, 'Byte');
    code.make();
    return { size: code.getModuleCount(), isDark: (row, column) => code.isDark(row, column) };
  } catch {
    return null;
  }
}

/** Paints a QR matrix centred in the placeholder's box, as large as fits. */
export function drawQr(canvas: PageCanvas, placeholder: QrPlaceholder, matrix: QrMatrix): void {
  canvas.drawInBox(
    placeholder.box,
    placeholder.rotation ?? 0,
    placeholder.opacity ?? 1,
    ({ width, height }) => {
      const side = Math.min(width, height);
      const left = (width - side) / 2;
      const bottom = (height - side) / 2;
      const moduleSize = side / (matrix.size + 2 * placeholder.quietZone);
      const inset = placeholder.quietZone * moduleSize;

      const operators: PDFOperator[] = [];
      if (placeholder.background) {
        operators.push(
          setFillingColor(hexToRgb(placeholder.background)),
          rectangle(round(left), round(bottom), round(side), round(side)),
          fill(),
        );
      }

      operators.push(setFillingColor(hexToRgb(placeholder.foreground)));
      for (let row = 0; row < matrix.size; row++) {
        // Row 0 is the top of the code; the box's y axis points up.
        const y = bottom + side - inset - (row + 1) * moduleSize;
        let column = 0;
        while (column < matrix.size) {
          if (!matrix.isDark(row, column)) {
            column++;
            continue;
          }
          // Merge a horizontal run of dark modules into one rectangle.
          const start = column;
          while (column < matrix.size && matrix.isDark(row, column)) column++;
          operators.push(
            rectangle(
              round(left + inset + start * moduleSize),
              round(y),
              round((column - start) * moduleSize),
              round(moduleSize),
            ),
          );
        }
      }
      operators.push(fill());
      canvas.push(...operators);
    },
  );
}
