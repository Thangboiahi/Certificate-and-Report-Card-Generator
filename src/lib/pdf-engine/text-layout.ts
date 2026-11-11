/**
 * Text layout: decide the font size and the line breaks for a piece of text in a box.
 *
 * Pure arithmetic — no pdf-lib, no fonts. Callers supply a `TextMetrics` that knows how wide a
 * word is; this module wraps, shrinks and truncates. Keeping it pure is what lets one definition
 * of "does it fit" serve both the generated PDF and (later) the editor's live preview.
 *
 * All font metrics are in em: multiples of the font size. A word 4.2 em wide is 42 pt wide at
 * 10 pt. Because widths scale linearly with size, a word is measured once and reused at every
 * candidate size.
 */
import type { TextOverflow } from '@/lib/template/types';

export interface TextMetrics {
  /** Width in em of a word (a run of text containing no breaking whitespace). */
  measureWord(word: string): number;
  /** Width in em of the space between two words. */
  spaceWidth: number;
  /** Height in em of the tallest glyph above the baseline. */
  ascent: number;
  /** Depth in em of the lowest glyph below the baseline (a positive number). */
  descent: number;
}

export interface TextLayoutOptions {
  boxWidth: number;
  boxHeight: number;
  /** Preferred (maximum) font size, in points. */
  fontSize: number;
  /** Floor for `shrinkToFit`, in points. */
  minFontSize: number;
  /** Line pitch as a multiple of the font size. */
  lineHeight: number;
  wrap: boolean;
  shrinkToFit: boolean;
  maxLines?: number;
  overflow: TextOverflow;
  /** Appended when `overflow` is `ellipsis` and text is dropped. */
  ellipsis: string;
}

export interface LaidOutLine {
  /** The words of the line, in order. Drawn separated by one space. */
  words: string[];
  /** Width of the line in points at the chosen font size. */
  width: number;
}

export interface TextLayout {
  /** The font size to draw at, in points. */
  fontSize: number;
  lines: LaidOutLine[];
  /** True when the text does not fit its box even after wrapping and shrinking. */
  overflowed: boolean;
  /** True when part of the text was dropped and replaced by an ellipsis. */
  truncated: boolean;
}

/** Slack for floating-point noise, in points. Far below anything visible in print. */
const EPSILON = 0.01;

/** Smallest step the shrink search resolves, in points. */
const SIZE_STEP = 0.01;

type GraphemeSegmenter = { segment(input: string): Iterable<{ segment: string }> };

let graphemeSegmenter: GraphemeSegmenter | null | undefined;

/**
 * Splits text into user-perceived characters, so that a forced break never lands between a base
 * letter and its combining marks (essential for Indic scripts and emoji).
 */
export function splitGraphemes(text: string): string[] {
  if (graphemeSegmenter === undefined) {
    graphemeSegmenter =
      typeof Intl !== 'undefined' && 'Segmenter' in Intl
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  }
  if (!graphemeSegmenter) return Array.from(text);
  return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
}

/**
 * Splits text into paragraphs (at line breaks) and words (at spaces and tabs). Runs of spaces
 * collapse; blank lines in the middle are kept as empty paragraphs; a non-breaking space stays
 * inside its word, which is how authors forbid a break ("Dr. Rao").
 */
export function splitIntoParagraphs(text: string): string[][] {
  const paragraphs = text.split(/\r\n|\r|\n/).map((line) => line.split(/[ \t]+/).filter(Boolean));
  while (paragraphs.length > 0 && paragraphs[0]?.length === 0) paragraphs.shift();
  while (paragraphs.length > 0 && paragraphs[paragraphs.length - 1]?.length === 0) paragraphs.pop();
  return paragraphs;
}

/** Lays out `text` in a box. See `TextFit` in the template schema for the behaviours. */
export function layoutText(
  text: string,
  metrics: TextMetrics,
  options: TextLayoutOptions,
): TextLayout {
  const paragraphs = splitIntoParagraphs(text);
  if (paragraphs.length === 0) {
    return { fontSize: options.fontSize, lines: [], overflowed: false, truncated: false };
  }

  const { boxWidth, boxHeight, lineHeight, wrap, maxLines } = options;
  const contentHeight = metrics.ascent + metrics.descent;

  const lineWidth = (words: readonly string[]): number =>
    words.reduce((total, word) => total + metrics.measureWord(word), 0) +
    metrics.spaceWidth * Math.max(0, words.length - 1);

  /** Splits a word that is wider than a whole line into pieces that fit (last resort). */
  const breakWord = (word: string, maxWidth: number): string[] => {
    const pieces: string[] = [];
    let piece = '';
    for (const grapheme of splitGraphemes(word)) {
      const candidate = piece + grapheme;
      if (piece !== '' && metrics.measureWord(candidate) > maxWidth) {
        pieces.push(piece);
        piece = grapheme;
      } else {
        piece = candidate;
      }
    }
    if (piece !== '') pieces.push(piece);
    return pieces;
  };

  /** Greedy line breaking of one paragraph. Widths are in em. */
  const wrapParagraph = (
    words: readonly string[],
    maxWidth: number,
    breakLongWords: boolean,
  ): string[][] => {
    if (words.length === 0) return [[]];
    const lines: string[][] = [];
    let current: string[] = [];
    let currentWidth = 0;

    const startLineWith = (word: string) => {
      const width = metrics.measureWord(word);
      if (breakLongWords && width > maxWidth) {
        const pieces = breakWord(word, maxWidth);
        const last = pieces.pop() ?? word;
        for (const piece of pieces) lines.push([piece]);
        current = [last];
        currentWidth = metrics.measureWord(last);
      } else {
        current = [word];
        currentWidth = width;
      }
    };

    for (const word of words) {
      if (current.length === 0) {
        startLineWith(word);
        continue;
      }
      const width = metrics.measureWord(word);
      if (currentWidth + metrics.spaceWidth + width <= maxWidth) {
        current.push(word);
        currentWidth += metrics.spaceWidth + width;
      } else {
        lines.push(current);
        startLineWith(word);
      }
    }
    lines.push(current);
    return lines;
  };

  const linesAt = (size: number, breakLongWords: boolean): string[][] => {
    if (!wrap) return paragraphs.map((words) => [...words]);
    // The tolerance is expressed in em so that it stays a fixed fraction of a point.
    const maxWidth = (boxWidth + EPSILON) / size;
    return paragraphs.flatMap((words) => wrapParagraph(words, maxWidth, breakLongWords));
  };

  const blockHeight = (lineCount: number, size: number): number =>
    ((lineCount - 1) * lineHeight + contentHeight) * size;

  const fits = (lines: readonly string[][], size: number): boolean => {
    if (maxLines !== undefined && lines.length > maxLines) return false;
    if (blockHeight(lines.length, size) > boxHeight + EPSILON) return false;
    return lines.every((words) => lineWidth(words) * size <= boxWidth + EPSILON);
  };

  const fitsAt = (size: number): boolean => fits(linesAt(size, false), size);

  // ── Choose the font size ─────────────────────────────────────────────────────────────────────
  let fontSize = options.fontSize;
  if (options.shrinkToFit && options.minFontSize < fontSize && !fitsAt(fontSize)) {
    if (!fitsAt(options.minFontSize)) {
      fontSize = options.minFontSize;
    } else {
      // Invariant: `low` fits, `high` does not. Narrow until the gap is below one step.
      let low = options.minFontSize;
      let high = fontSize;
      while (high - low > SIZE_STEP) {
        const middle = (low + high) / 2;
        if (fitsAt(middle)) low = middle;
        else high = middle;
      }
      const rounded = Math.max(options.minFontSize, Math.floor(low / SIZE_STEP) * SIZE_STEP);
      fontSize = fitsAt(rounded) ? rounded : low;
    }
  }

  // ── Break lines at the chosen size ───────────────────────────────────────────────────────────
  let lines = linesAt(fontSize, true);
  const overflowed = !fits(lines, fontSize);
  let truncated = false;

  if (overflowed && options.overflow === 'ellipsis') {
    const maxWidth = boxWidth / fontSize;
    const linePitch = lineHeight * fontSize;
    const fitVertically = Math.max(
      1,
      Math.floor((boxHeight - contentHeight * fontSize + EPSILON) / linePitch) + 1,
    );
    const limit = Math.min(fitVertically, maxLines ?? Number.POSITIVE_INFINITY);

    const withEllipsis = (words: readonly string[]): string[] => {
      let remaining = [...words];
      while (remaining.length > 0) {
        const head = remaining.slice(0, -1);
        const graphemes = splitGraphemes(remaining[remaining.length - 1] ?? '');
        for (let keep = graphemes.length; keep >= 1; keep--) {
          const candidate = [...head, graphemes.slice(0, keep).join('') + options.ellipsis];
          if (lineWidth(candidate) <= maxWidth + EPSILON / fontSize) return candidate;
        }
        remaining = head;
      }
      return [options.ellipsis];
    };

    if (lines.length > limit) {
      lines = lines.slice(0, limit);
      const last = lines.length - 1;
      lines[last] = withEllipsis(lines[last] ?? []);
      truncated = true;
    }
    lines = lines.map((words) => {
      if (lineWidth(words) * fontSize <= boxWidth + EPSILON) return words;
      truncated = true;
      return withEllipsis(words);
    });
  }

  return {
    fontSize,
    lines: lines.map((words) => ({ words, width: lineWidth(words) * fontSize })),
    overflowed,
    truncated,
  };
}

/**
 * Distance from the top of the box to the baseline of each line, for a layout placed in a box of
 * `boxHeight`. The text block spans from the first line's ascent to the last line's descent, and
 * `verticalAlign` positions that block.
 */
export function baselineOffsets(
  layout: Pick<TextLayout, 'fontSize' | 'lines'>,
  metrics: Pick<TextMetrics, 'ascent' | 'descent'>,
  lineHeight: number,
  boxHeight: number,
  verticalAlign: 'top' | 'middle' | 'bottom',
): number[] {
  const count = layout.lines.length;
  const size = layout.fontSize;
  const linePitch = lineHeight * size;
  const block = (count - 1) * linePitch + (metrics.ascent + metrics.descent) * size;

  let top = 0;
  if (verticalAlign === 'middle') top = (boxHeight - block) / 2;
  else if (verticalAlign === 'bottom') top = boxHeight - block;

  return layout.lines.map((_line, index) => top + metrics.ascent * size + index * linePitch);
}
