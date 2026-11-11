import { describe, expect, it } from 'vitest';

import { FileNamer, sanitizeFileName } from './file-names';

describe('sanitizeFileName', () => {
  it('leaves ordinary names alone, in any script', () => {
    expect(sanitizeFileName('Asha Rao - Class 10')).toBe('Asha Rao - Class 10');
    expect(sanitizeFileName('प्रियंका त्रिपाठी')).toBe('प्रियंका त्रिपाठी');
  });

  it('replaces characters that file systems forbid', () => {
    expect(sanitizeFileName('10/A: "Asha" <Rao>|?*')).toBe('10-A- -Asha- -Rao----');
    expect(sanitizeFileName('a\\b\u0000c\nd')).toBe('a-b-c-d');
  });

  it('collapses whitespace and trims dots and spaces from the ends', () => {
    expect(sanitizeFileName('  Asha    Rao .. ')).toBe('Asha Rao');
    expect(sanitizeFileName('...')).toBe('');
  });

  it('avoids names Windows reserves', () => {
    expect(sanitizeFileName('CON')).toBe('CON_');
    expect(sanitizeFileName('lpt1')).toBe('lpt1_');
    expect(sanitizeFileName('Console')).toBe('Console');
  });

  it('limits the length without splitting a character', () => {
    const long = sanitizeFileName('😀'.repeat(300));
    expect(Array.from(long)).toHaveLength(120);
    expect(long.endsWith('😀')).toBe(true);
  });
});

describe('FileNamer', () => {
  it('appends .pdf', () => {
    expect(new FileNamer().next('Asha Rao', 'Document 1')).toBe('Asha Rao.pdf');
  });

  it('uses the fallback when the name is empty or unusable', () => {
    const namer = new FileNamer();
    expect(namer.next('', 'Document 1')).toBe('Document 1.pdf');
    expect(namer.next('???', 'Document 2')).toBe('---.pdf');
    expect(namer.next(' . ', 'Document 3')).toBe('Document 3.pdf');
  });

  it('numbers duplicates, ignoring case', () => {
    const namer = new FileNamer();
    expect(namer.next('Rahul Kumar', 'x')).toBe('Rahul Kumar.pdf');
    expect(namer.next('Rahul Kumar', 'x')).toBe('Rahul Kumar (2).pdf');
    expect(namer.next('rahul kumar', 'x')).toBe('rahul kumar (3).pdf');
    expect(namer.next('Rahul Kumar', 'x')).toBe('Rahul Kumar (4).pdf');
  });

  it('does not collide with a name that already looks numbered', () => {
    const namer = new FileNamer();
    expect(namer.next('Asha (2)', 'x')).toBe('Asha (2).pdf');
    expect(namer.next('Asha', 'x')).toBe('Asha.pdf');
    expect(namer.next('Asha', 'x')).toBe('Asha (3).pdf');
  });

  it('hands out unique names for a large batch of identical names', () => {
    const namer = new FileNamer();
    const names = new Set(
      Array.from({ length: 2000 }, () => namer.next('Certificate', 'x').toLowerCase()),
    );
    expect(names.size).toBe(2000);
  });
});
