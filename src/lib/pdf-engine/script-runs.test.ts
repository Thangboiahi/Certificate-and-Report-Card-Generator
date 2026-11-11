import { describe, expect, it } from 'vitest';

import { isRightToLeft, scriptOf, splitScriptRuns } from './script-runs';

const runs = (text: string) => splitScriptRuns(text).map((run) => [run.script, run.text]);

describe('scriptOf', () => {
  it.each([
    ['A', 'latn'],
    ['é', 'latn'],
    ['क', 'deva'],
    ['ক', 'beng'],
    ['ਕ', 'guru'],
    ['ક', 'gujr'],
    ['କ', 'orya'],
    ['க', 'taml'],
    ['క', 'telu'],
    ['ಕ', 'knda'],
    ['ക', 'mlym'],
    ['ک', 'arab'],
    ['א', 'hebr'],
  ])('classifies %s as %s', (character, script) => {
    expect(scriptOf(character.codePointAt(0)!)).toBe(script);
  });

  it.each([' ', '7', '-', '.', '₹', '—', '\u200D', '।', '×'])(
    'treats %j as script-neutral',
    (character) => {
      expect(scriptOf(character.codePointAt(0)!)).toBeNull();
    },
  );
});

describe('splitScriptRuns', () => {
  it('keeps single-script text in one run', () => {
    expect(runs('Certificate')).toEqual([['latn', 'Certificate']]);
    expect(runs('प्रियंका')).toEqual([['deva', 'प्रियंका']]);
  });

  it('splits where the script changes', () => {
    expect(runs('Classकक्षा')).toEqual([
      ['latn', 'Class'],
      ['deva', 'कक्षा'],
    ]);
    expect(runs('தமிழ்हिंदीEnglish')).toEqual([
      ['taml', 'தமிழ்'],
      ['deva', 'हिंदी'],
      ['latn', 'English'],
    ]);
  });

  it('attaches digits and punctuation to the run before them', () => {
    expect(runs('कक्षा-10(A)')).toEqual([
      ['deva', 'कक्षा-10('],
      ['latn', 'A)'],
    ]);
  });

  it('attaches leading neutrals to the first run', () => {
    expect(runs('(हिंदी)')).toEqual([['deva', '(हिंदी)']]);
    expect(runs('₹500')).toEqual([['latn', '₹500']]);
  });

  it('keeps joiners inside their run so conjunct control still works', () => {
    expect(runs('क्\u200Dष')).toEqual([['deva', 'क्\u200Dष']]);
  });

  it('returns nothing for empty text and never drops characters', () => {
    expect(runs('')).toEqual([]);
    const text = 'A1 क2 ক3 😀 Z';
    expect(
      splitScriptRuns(text)
        .map((run) => run.text)
        .join(''),
    ).toBe(text);
  });
});

describe('isRightToLeft', () => {
  it('flags Arabic-script and Hebrew text only', () => {
    expect(isRightToLeft('arab')).toBe(true);
    expect(isRightToLeft('hebr')).toBe(true);
    expect(isRightToLeft('deva')).toBe(false);
    expect(isRightToLeft('latn')).toBe(false);
  });
});
