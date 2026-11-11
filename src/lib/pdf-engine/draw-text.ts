/**
 * Drawing a text placeholder.
 *
 * Layout (`text-layout.ts`) decides the size and the line breaks; this file turns the result into
 * PDF text operators. Each glyph is placed where the shaper put it: runs of glyphs go into one
 * `TJ` array with kerning adjustments between them, and a glyph that sits above or below the
 * baseline (an Indic vowel sign, say) gets its own text position.
 */
import {
  beginText,
  clip,
  endPath,
  endText,
  PDFArray,
  PDFHexString,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  rectangle,
  rgb,
  setFillingColor,
  setFontAndSize,
  setTextMatrix,
  showText,
  type PDFContext,
} from 'pdf-lib';

import type { HexColor, TextPlaceholder, TextTransform } from '@/lib/template/types';

import type { DocumentFont, ShapedRun } from './fonts';
import { round, type PageCanvas } from './page-canvas';
import { baselineOffsets, layoutText, type TextMetrics } from './text-layout';
import type { WarningCode } from './types';

export type Warn = (code: WarningCode, message: string) => void;

export function hexToRgb(color: HexColor) {
  const value = Number.parseInt(color.slice(1), 16);
  return rgb(((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255);
}

/**
 * Cleans a cell value for typesetting: canonical Unicode form, uniform line breaks, no control
 * characters, then the placeholder's case conversion.
 */
export function prepareText(value: string, textTransform: TextTransform = 'none'): string {
  const text = value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    // Control characters other than the line feed have no glyph and would show as boxes.
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '');

  switch (textTransform) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    case 'capitalize':
      return text.replace(
        /(^|[\s ])(\p{L})/gu,
        (_match, before: string, letter: string) => before + letter.toUpperCase(),
      );
    case 'none':
      return text;
  }
}

/** A glyph with the code it has in the current document. Distances in em. */
interface PlacedGlyph {
  code: string;
  advance: number;
  naturalAdvance: number;
  xOffset: number;
  yOffset: number;
}

/** A stretch of glyphs on one baseline: hex strings interleaved with `TJ` adjustments. */
interface TextSegment {
  /** Start position relative to the line's origin, in em. */
  x: number;
  y: number;
  items: Array<string | number>;
}

function placeGlyphs(font: DocumentFont, runs: readonly ShapedRun[]): PlacedGlyph[] {
  const placed: PlacedGlyph[] = [];
  for (const run of runs) {
    const codes = font.encode(run);
    run.glyphs.forEach((glyph, index) => {
      placed.push({
        code: codes[index] as string,
        advance: glyph.advance,
        naturalAdvance: glyph.naturalAdvance,
        xOffset: glyph.xOffset,
        yOffset: glyph.yOffset,
      });
    });
  }
  return placed;
}

/**
 * Groups glyphs into segments. `pen` is where layout wants the next glyph; `cursor` is where the
 * PDF viewer's own text cursor will be, given that it advances by each glyph's natural width.
 * Wherever the two differ (kerning, a shaping adjustment) a `TJ` number closes the gap.
 */
function buildSegments(glyphs: readonly PlacedGlyph[]): TextSegment[] {
  const segments: TextSegment[] = [];
  let segment: TextSegment | undefined;
  let pen = 0;
  let cursor = 0;

  for (const glyph of glyphs) {
    const x = pen + glyph.xOffset;
    const y = glyph.yOffset;

    if (!segment || Math.abs(y - segment.y) > 1e-6) {
      segment = { x, y, items: [] };
      segments.push(segment);
      cursor = x;
    } else {
      // TJ numbers are in thousandths of an em and move the cursor LEFT when positive.
      const adjustment = Math.round((cursor - x) * 100_000) / 100;
      if (adjustment !== 0) {
        segment.items.push(adjustment);
        // Track the cursor as the viewer will compute it, so rounding never accumulates.
        cursor -= adjustment / 1000;
      }
    }

    const last = segment.items.length - 1;
    const previous = segment.items[last];
    if (typeof previous === 'string') segment.items[last] = previous + glyph.code;
    else segment.items.push(glyph.code);

    cursor += glyph.naturalAdvance;
    pen += glyph.advance;
  }
  return segments;
}

function showSegment(context: PDFContext, items: ReadonlyArray<string | number>): PDFOperator {
  const [only] = items;
  if (items.length === 1 && typeof only === 'string') return showText(PDFHexString.of(only));

  const array = PDFArray.withContext(context);
  for (const item of items) {
    array.push(typeof item === 'string' ? PDFHexString.of(item) : PDFNumber.of(item));
  }
  return PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [array]);
}

function describeCharacters(characters: readonly string[]): string {
  const shown = characters.slice(0, 8).join(' ');
  return characters.length > 8 ? `${shown} …` : shown;
}

/**
 * Lays out `value` in the placeholder's box and draws it. Reports anything the user should check
 * through `warn`. `value` must be non-empty.
 */
export function drawText(
  canvas: PageCanvas,
  placeholder: TextPlaceholder,
  font: DocumentFont,
  value: string,
  warn: Warn,
): void {
  const { face } = font;
  const { style, fit, box } = placeholder;
  const text = prepareText(value, style.textTransform);

  const unsupported = face.unsupportedCharacters(text);
  if (unsupported.length > 0) {
    warn(
      'UNSUPPORTED_CHARACTERS',
      `The font "${face.label}" cannot show these characters: ${describeCharacters(unsupported)}`,
    );
  }

  const metrics: TextMetrics = {
    measureWord: (word) => face.shapeWord(word).width,
    spaceWidth: face.space.glyphs.reduce((total, glyph) => total + glyph.advance, 0),
    ascent: face.ascent,
    descent: face.descent,
  };

  const layout = layoutText(text, metrics, {
    boxWidth: box.width,
    boxHeight: box.height,
    fontSize: style.fontSize,
    minFontSize: Math.min(fit.minFontSize, style.fontSize),
    lineHeight: style.lineHeight,
    wrap: fit.wrap,
    shrinkToFit: fit.shrinkToFit,
    maxLines: fit.maxLines,
    overflow: fit.overflow,
    ellipsis: face.unsupportedCharacters('…').length === 0 ? '…' : '...',
  });
  if (layout.lines.length === 0) return;

  if (layout.overflowed) {
    const outcome =
      fit.overflow === 'ellipsis'
        ? 'It was shortened with "…".'
        : fit.overflow === 'clip'
          ? 'It was cut off at the edge of its box.'
          : 'It runs outside its box.';
    warn('TEXT_OVERFLOW', `The text is too long for "${placeholder.label}". ${outcome}`);
  }

  const size = layout.fontSize;
  const baselines = baselineOffsets(
    layout,
    metrics,
    style.lineHeight,
    box.height,
    style.verticalAlign,
  );
  let hasRightToLeft = false;
  let hasDegradedShaping = false;

  canvas.drawInBox(
    box,
    placeholder.rotation ?? 0,
    placeholder.opacity ?? 1,
    ({ width, height }) => {
      if (layout.overflowed && fit.overflow === 'clip') {
        canvas.push(rectangle(0, 0, round(width), round(height)), clip(), endPath());
      }

      const operators: PDFOperator[] = [
        setFillingColor(hexToRgb(style.color)),
        beginText(),
        setFontAndSize(canvas.fontName(font.pdfFont), round(size)),
      ];

      layout.lines.forEach((line, lineIndex) => {
        if (line.words.length === 0) return;

        const runs: ShapedRun[] = [];
        line.words.forEach((word, wordIndex) => {
          if (wordIndex > 0) runs.push(face.space);
          const shaped = face.shapeWord(word);
          hasRightToLeft ||= shaped.rightToLeft;
          hasDegradedShaping ||= shaped.degraded;
          runs.push(...shaped.runs);
        });

        let lineX = 0;
        if (style.align === 'center') lineX = (width - line.width) / 2;
        else if (style.align === 'right') lineX = width - line.width;
        const lineY = height - (baselines[lineIndex] as number);

        for (const segment of buildSegments(placeGlyphs(font, runs))) {
          operators.push(
            setTextMatrix(
              1,
              0,
              0,
              1,
              round(lineX + segment.x * size),
              round(lineY + segment.y * size),
            ),
            showSegment(canvas.document.context, segment.items),
          );
        }
      });

      operators.push(endText());
      canvas.push(...operators);
    },
  );

  if (hasDegradedShaping) {
    warn(
      'TEXT_SHAPING_DEGRADED',
      `The font "${face.label}" could not be fully applied to this text; some letters may be slightly misplaced.`,
    );
  }
  if (hasRightToLeft) {
    warn(
      'RIGHT_TO_LEFT_TEXT',
      'Right-to-left scripts (Urdu, Arabic, Hebrew) are not supported yet and may appear reversed.',
    );
  }
}
