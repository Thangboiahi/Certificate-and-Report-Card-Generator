import { describe, expect, it } from 'vitest';

import { validateTemplate } from '@/lib/template/schema';

import { buildStarterTemplate, placeholdersForColumns, templateTitle } from './starter-template';

const A4_LANDSCAPE = { width: 842, height: 595 };
const SOURCE = { fileName: 'Annual Day.pdf', byteSize: 1234, sha256: 'ab'.repeat(32) };

describe('buildStarterTemplate', () => {
  it('produces a template the engine accepts, with one field per column', () => {
    const template = buildStarterTemplate({
      source: SOURCE,
      pages: [A4_LANDSCAPE],
      columns: ['Student Name', 'Roll No', 'Photo'],
    });
    const result = validateTemplate(template);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(template.placeholders.map((p) => [p.type, p.binding])).toEqual([
      ['text', { kind: 'column', column: 'Student Name' }],
      ['text', { kind: 'column', column: 'Roll No' }],
      ['image', { kind: 'column', column: 'Photo' }],
    ]);
    expect(template.output.fileNameTemplate).toBe('{{Student Name}}');
  });

  it('starts with no fields and a file-name based output name when there is no CSV', () => {
    const template = buildStarterTemplate({ source: SOURCE, pages: [A4_LANDSCAPE] });
    expect(validateTemplate(template).ok).toBe(true);
    expect(template.placeholders).toEqual([]);
    expect(template.output.fileNameTemplate).toBe('Annual Day');
  });

  it('keeps every field on the page, wrapping the stack when there are many columns', () => {
    const columns = Array.from({ length: 30 }, (_, index) => `Column ${index}`);
    const fields = placeholdersForColumns(columns, A4_LANDSCAPE);
    for (const { box } of fields) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(A4_LANDSCAPE.width);
      expect(box.y + box.height).toBeLessThanOrEqual(A4_LANDSCAPE.height);
    }
  });

  it('gives columns whose names collapse to the same id distinct ids', () => {
    const ids = placeholdersForColumns(['Name', 'name', 'NAME!'], A4_LANDSCAPE).map((p) => p.id);
    expect(new Set(ids).size).toBe(3);
    const taken = new Set(ids);
    const more = placeholdersForColumns(['Name'], A4_LANDSCAPE, taken);
    expect(taken.has(more[0]!.id)).toBe(true);
    expect(ids).not.toContain(more[0]!.id);
  });

  it('titles a template by its file name without the extension', () => {
    expect(templateTitle(buildStarterTemplate({ source: SOURCE, pages: [A4_LANDSCAPE] }))).toBe(
      'Annual Day',
    );
  });
});
