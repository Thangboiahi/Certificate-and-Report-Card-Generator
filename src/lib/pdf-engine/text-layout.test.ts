import { describe, expect, it } from 'vitest';

import {
  baselineOffsets,
  layoutText,
  splitGraphemes,
  splitIntoParagraphs,
  type TextLayoutOptions,
  type TextMetrics,
} from './text-layout';

/** Every character is half an em wide: at 10 pt, a 6-letter word is 30 pt. */
const MONO: TextMetrics = {
  measureWord: (word) => Array.from(word).length * 0.5,
  spaceWidth: 0.5,
  ascent: 0.8,
  descent: 0.2,
};

const BASE: TextLayoutOptions = {
  boxWidth: 100,
  boxHeight: 100,
  fontSize: 10,
  minFontSize: 4,
  lineHeight: 1.2,
  wrap: false,
  shrinkToFit: false,
  overflow: 'visible',
  ellipsis: '…',
};

const linesOf = (text: string, options: Partial<TextLayoutOptions>) =>
  layoutText(text, MONO, { ...BASE, ...options }).lines.map((line) => line.words.join(' '));

describe('splitIntoParagraphs', () => {
  it('collapses spaces, keeps inner blank lines and trims outer ones', () => {
    expect(splitIntoParagraphs('  a   b\t c \r\n\r\n d \n\n')).toEqual([
      ['a', 'b', 'c'],
      [],
      ['d'],
    ]);
  });

  it('keeps a non-breaking space inside its word', () => {
    expect(splitIntoParagraphs('Dr. Rao MBBS')).toEqual([['Dr. Rao', 'MBBS']]);
  });

  it('returns nothing for blank text', () => {
    expect(splitIntoParagraphs('   \n  ')).toEqual([]);
  });
});

describe('splitGraphemes', () => {
  it('keeps combining marks with their base letter', () => {
    expect(splitGraphemes('कि')).toEqual(['कि']);
    expect(splitGraphemes('éa')).toEqual(['é', 'a']);
  });
});

describe('layoutText — single line', () => {
  it('keeps the preferred size when the text fits', () => {
    const layout = layoutText('Asha Rao', MONO, { ...BASE, shrinkToFit: true });
    expect(layout.fontSize).toBe(10);
    expect(layout.lines).toEqual([{ words: ['Asha', 'Rao'], width: 40 }]);
    expect(layout.overflowed).toBe(false);
  });

  it('shrinks a long name to exactly fill the width', () => {
    // 37 letters + 3 spaces = 40 characters = 20 em. A 100 pt box allows 5 pt.
    const layout = layoutText('Venkata Subramanian Ramachandran Iyengar', MONO, {
      ...BASE,
      shrinkToFit: true,
    });
    expect(layout.fontSize).toBeCloseTo(5, 1);
    expect(layout.fontSize).toBeLessThanOrEqual(5);
    expect(layout.lines).toHaveLength(1);
    expect(layout.lines[0]!.width).toBeLessThanOrEqual(100.01);
    expect(layout.overflowed).toBe(false);
  });

  it('shrinks to respect the box height as well as its width', () => {
    // Content height is 1 em; a 6 pt tall box caps the size at 6 pt.
    const layout = layoutText('Hi', MONO, { ...BASE, boxHeight: 6, shrinkToFit: true });
    expect(layout.fontSize).toBeCloseTo(6, 1);
    expect(layout.overflowed).toBe(false);
  });

  it('stops at the minimum size and reports overflow', () => {
    const text = 'x'.repeat(100); // 50 em: needs 2 pt
    const layout = layoutText(text, MONO, { ...BASE, shrinkToFit: true, minFontSize: 6 });
    expect(layout.fontSize).toBe(6);
    expect(layout.overflowed).toBe(true);
    expect(layout.truncated).toBe(false);
  });

  it('never grows beyond the preferred size', () => {
    expect(layoutText('a', MONO, { ...BASE, shrinkToFit: true }).fontSize).toBe(10);
  });

  it('leaves the size alone when shrinking is off', () => {
    const layout = layoutText('x'.repeat(100), MONO, BASE);
    expect(layout.fontSize).toBe(10);
    expect(layout.overflowed).toBe(true);
  });

  it('truncates with an ellipsis when asked', () => {
    // 20 chars fit in 100 pt at 10 pt. The ellipsis takes one of them.
    const layout = layoutText('abcdefghij klmnopqrstuvwxyz', MONO, {
      ...BASE,
      overflow: 'ellipsis',
    });
    expect(layout.lines.map((line) => line.words.join(' '))).toEqual(['abcdefghij klmnopqr…']);
    expect(layout.lines[0]!.width).toBeLessThanOrEqual(100);
    expect(layout.truncated).toBe(true);
  });

  it('drops a whole word when not even one of its letters fits before the ellipsis', () => {
    // "aaaaaaaaaaaaaaaaaa b": 18 chars + space + 1 = 20 chars fits exactly; add more to overflow.
    const layout = layoutText('aaaaaaaaaaaaaaaaaaa bcd', MONO, { ...BASE, overflow: 'ellipsis' });
    expect(layout.lines[0]!.words.join(' ')).toBe('aaaaaaaaaaaaaaaaaaa…');
  });

  it('honours explicit line breaks even without wrapping', () => {
    expect(linesOf('First line\nSecond line', {})).toEqual(['First line', 'Second line']);
  });
});

describe('layoutText — wrapping', () => {
  it('breaks at word boundaries when a line is full', () => {
    // 20 characters per line at 10 pt.
    expect(linesOf('the quick brown fox jumps over the lazy dog', { wrap: true })).toEqual([
      'the quick brown fox',
      'jumps over the lazy',
      'dog',
    ]);
  });

  it('fills a line exactly to the edge', () => {
    expect(linesOf('aaaaaaaaaa bbbbbbbbb c', { wrap: true })).toEqual([
      'aaaaaaaaaa bbbbbbbbb',
      'c',
    ]);
  });

  it('breaks a word that is longer than a whole line, without splitting characters', () => {
    expect(linesOf('x'.repeat(45), { wrap: true })).toEqual([
      'x'.repeat(20),
      'x'.repeat(20),
      'x'.repeat(5),
    ]);
  });

  it('wraps then shrinks until the paragraph fits the box height', () => {
    const text = Array.from({ length: 30 }, () => 'word').join(' '); // 149 chars
    const layout = layoutText(text, MONO, {
      ...BASE,
      wrap: true,
      shrinkToFit: true,
      boxHeight: 40,
    });
    const block = ((layout.lines.length - 1) * 1.2 + 1) * layout.fontSize;
    expect(layout.overflowed).toBe(false);
    expect(layout.fontSize).toBeLessThan(10);
    expect(layout.fontSize).toBeGreaterThan(4);
    expect(block).toBeLessThanOrEqual(40.01);
    for (const line of layout.lines) expect(line.width).toBeLessThanOrEqual(100.01);
    // The search must land on the largest size that fits: slightly larger must not fit.
    const larger = layoutText(text, MONO, {
      ...BASE,
      wrap: true,
      boxHeight: 40,
      fontSize: layout.fontSize + 0.05,
    });
    expect(larger.overflowed).toBe(true);
  });

  it('prefers shrinking over splitting a long word', () => {
    // One 25-letter word: fits on a line at 8 pt, so it should shrink rather than break.
    const layout = layoutText('y'.repeat(25), MONO, { ...BASE, wrap: true, shrinkToFit: true });
    expect(layout.lines).toHaveLength(1);
    expect(layout.fontSize).toBeCloseTo(8, 1);
  });

  it('limits the number of lines and marks the cut with an ellipsis', () => {
    const layout = layoutText(
      'one two three four five six seven eight nine ten eleven twelve',
      MONO,
      {
        ...BASE,
        wrap: true,
        maxLines: 2,
        overflow: 'ellipsis',
      },
    );
    // Like CSS text-overflow, the cut is made at the last character that leaves room for the "…".
    expect(layout.lines.map((line) => line.words.join(' '))).toEqual([
      'one two three four',
      'five six seven eigh…',
    ]);
    expect(layout.truncated).toBe(true);
    expect(layout.overflowed).toBe(true);
  });

  it('drops lines that do not fit the box height when truncating', () => {
    // Line pitch 12 pt, content 10 pt: a 25 pt box holds two lines (10 + 12 = 22).
    const layout = layoutText('aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll', MONO, {
      ...BASE,
      wrap: true,
      boxHeight: 25,
      overflow: 'ellipsis',
    });
    expect(layout.lines).toHaveLength(2);
    expect(layout.lines[1]!.words.at(-1)).toMatch(/…$/);
  });

  it('keeps blank lines between paragraphs', () => {
    expect(linesOf('Dear parent,\n\nRegards', { wrap: true })).toEqual([
      'Dear parent,',
      '',
      'Regards',
    ]);
  });
});

describe('layoutText — edge cases', () => {
  it('returns no lines for empty text', () => {
    expect(layoutText('', MONO, BASE)).toEqual({
      fontSize: 10,
      lines: [],
      overflowed: false,
      truncated: false,
    });
  });

  it('shows just the ellipsis when nothing else fits', () => {
    const layout = layoutText('abc', MONO, { ...BASE, boxWidth: 6, overflow: 'ellipsis' });
    expect(layout.lines[0]!.words).toEqual(['…']);
  });
});

describe('baselineOffsets', () => {
  const layout = {
    fontSize: 10,
    lines: [
      { words: ['a'], width: 5 },
      { words: ['b'], width: 5 },
    ],
  };
  // Block height: one line pitch (12) + content height (10) = 22.

  it('places the first baseline one ascent below the top', () => {
    expect(baselineOffsets(layout, MONO, 1.2, 100, 'top')).toEqual([8, 20]);
  });

  it('centres the block vertically', () => {
    expect(baselineOffsets(layout, MONO, 1.2, 100, 'middle')).toEqual([47, 59]);
  });

  it('rests the last descent on the bottom edge', () => {
    expect(baselineOffsets(layout, MONO, 1.2, 100, 'bottom')).toEqual([86, 98]);
  });
});
