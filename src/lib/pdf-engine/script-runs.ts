/**
 * Split text into runs of a single writing system.
 *
 * A text shaper applies the rules of ONE script per call: Devanagari needs its conjunct and
 * vowel-sign rules, Latin needs none of them. fontkit guesses the script from the first letter of
 * whatever it is given, so "Class 10 कक्षा" would be shaped entirely as Latin and the Hindi would
 * come out broken (see docs/DECISIONS.md, ADR-007). Shaping each run separately fixes that.
 *
 * Digits, punctuation and spaces belong to no script; they join the run before them, or the run
 * after them when they come first.
 */

/** OpenType-style script tags for the scripts we tell apart. */
export type Script =
  | 'latn'
  | 'grek'
  | 'cyrl'
  | 'hebr'
  | 'arab'
  | 'deva'
  | 'beng'
  | 'guru'
  | 'gujr'
  | 'orya'
  | 'taml'
  | 'telu'
  | 'knda'
  | 'mlym'
  | 'sinh';

export interface ScriptRun {
  text: string;
  script: Script;
}

/** Inclusive code point ranges, sorted by start. */
const SCRIPT_RANGES: ReadonlyArray<readonly [start: number, end: number, script: Script]> = [
  [0x0041, 0x005a, 'latn'],
  [0x0061, 0x007a, 'latn'],
  [0x00c0, 0x00d6, 'latn'],
  [0x00d8, 0x00f6, 'latn'],
  [0x00f8, 0x024f, 'latn'],
  [0x0370, 0x03ff, 'grek'],
  [0x0400, 0x052f, 'cyrl'],
  [0x0591, 0x05f4, 'hebr'],
  [0x0600, 0x06ff, 'arab'],
  [0x0750, 0x077f, 'arab'],
  [0x08a0, 0x08ff, 'arab'],
  [0x0900, 0x0963, 'deva'],
  // U+0964 and U+0965 (danda, double danda) are shared by many Indic scripts: neutral.
  [0x0966, 0x097f, 'deva'],
  [0x0980, 0x09ff, 'beng'],
  [0x0a00, 0x0a7f, 'guru'],
  [0x0a80, 0x0aff, 'gujr'],
  [0x0b00, 0x0b7f, 'orya'],
  [0x0b80, 0x0bff, 'taml'],
  [0x0c00, 0x0c7f, 'telu'],
  [0x0c80, 0x0cff, 'knda'],
  [0x0d00, 0x0d7f, 'mlym'],
  [0x0d80, 0x0dff, 'sinh'],
  [0x1e00, 0x1eff, 'latn'],
  [0xa8e0, 0xa8ff, 'deva'],
  [0xfb1d, 0xfb4f, 'hebr'],
  [0xfb50, 0xfdff, 'arab'],
  [0xfe70, 0xfefc, 'arab'],
];

/** The script a code point belongs to, or `null` for script-neutral characters. */
export function scriptOf(codePoint: number): Script | null {
  let low = 0;
  let high = SCRIPT_RANGES.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = SCRIPT_RANGES[middle] as (typeof SCRIPT_RANGES)[number];
    if (codePoint < range[0]) high = middle - 1;
    else if (codePoint > range[1]) low = middle + 1;
    else return range[2];
  }
  return null;
}

/** Scripts written right to left. The engine does not lay these out yet and says so. */
export function isRightToLeft(script: Script): boolean {
  return script === 'arab' || script === 'hebr';
}

/**
 * Splits `text` into maximal runs that each contain letters of at most one script. Text without
 * any letters is returned as a single Latin run.
 */
export function splitScriptRuns(text: string): ScriptRun[] {
  const runs: ScriptRun[] = [];
  let start = 0;
  let current: Script | null = null;
  let index = 0;

  for (const character of text) {
    const script = scriptOf(character.codePointAt(0) as number);
    if (script !== null && script !== current) {
      if (current !== null) {
        runs.push({ text: text.slice(start, index), script: current });
        start = index;
      }
      current = script;
    }
    index += character.length;
  }

  if (start < text.length) runs.push({ text: text.slice(start), script: current ?? 'latn' });
  return runs;
}
