import { describe, expect, it } from 'vitest';

import { validateTemplate } from './schema';
import { TEMPLATE_SCHEMA_VERSION, type TemplateDefinition } from './types';

function validTemplate(): TemplateDefinition {
  return {
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    kind: 'certificate',
    source: {
      storagePath: 'templates/u1/t1/source.pdf',
      fileName: 'cert.pdf',
      byteSize: 1024,
      sha256: 'ab',
    },
    pages: [
      { width: 842, height: 595 },
      { width: 842, height: 595 },
    ],
    fonts: [{ id: 'body', label: 'Helvetica', source: { kind: 'standard', name: 'Helvetica' } }],
    placeholders: [
      {
        id: 'name',
        type: 'text',
        label: 'Name',
        pageIndex: 0,
        box: { x: 100, y: 200, width: 400, height: 60 },
        binding: { kind: 'column', column: 'Name' },
        style: {
          fontId: 'body',
          fontSize: 36,
          color: '#112233',
          align: 'center',
          verticalAlign: 'middle',
          lineHeight: 1.2,
        },
        fit: { wrap: false, shrinkToFit: true, minFontSize: 12, overflow: 'ellipsis' },
      },
      {
        id: 'photo',
        type: 'image',
        label: 'Photo',
        pageIndex: 1,
        box: { x: 50, y: 50, width: 90, height: 110 },
        binding: { kind: 'column', column: 'Photo URL' },
        fit: 'cover',
        position: { x: 0.5, y: 0.2 },
        shape: { kind: 'rounded', radius: 6 },
      },
      {
        id: 'qr',
        type: 'qr',
        label: 'Verify',
        pageIndex: 1,
        box: { x: 700, y: 450, width: 100, height: 100 },
        binding: { kind: 'template', template: 'https://verify.example.in/c/{{ID}}' },
        errorCorrection: 'M',
        foreground: '#000000',
        quietZone: 4,
      },
    ],
    output: { fileNameTemplate: '{{Name}}' },
  };
}

function issuePaths(input: unknown): string[] {
  const result = validateTemplate(input);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
}

describe('validateTemplate', () => {
  it('accepts a well-formed multi-page template with all three placeholder types', () => {
    const result = validateTemplate(validTemplate());
    expect(result.ok).toBe(true);
  });

  it('drops unknown keys so newer documents stay readable', () => {
    const input = { ...validTemplate(), somethingFromTheFuture: true };
    const result = validateTemplate(input);
    expect(result.ok && 'somethingFromTheFuture' in result.template).toBe(false);
  });

  it('rejects a different schema version', () => {
    expect(issuePaths({ ...validTemplate(), schemaVersion: 2 })).toContain('schemaVersion');
  });

  it('rejects malformed colours, with the path of the offending field', () => {
    const template = validTemplate();
    (template.placeholders[0] as { style: { color: string } }).style.color = 'red';
    expect(issuePaths(template)).toEqual(['placeholders.0.style.color']);
  });

  it('rejects boxes without area', () => {
    const template = validTemplate();
    template.placeholders[0]!.box.width = 0;
    expect(issuePaths(template)).toEqual(['placeholders.0.box.width']);
  });

  it('rejects an unknown placeholder type', () => {
    const template = validTemplate() as unknown as { placeholders: { type: string }[] };
    template.placeholders[0]!.type = 'barcode';
    expect(issuePaths(template)).toEqual(['placeholders.0.type']);
  });

  it('rejects a placeholder on a page that does not exist', () => {
    const template = validTemplate();
    template.placeholders[1]!.pageIndex = 2;
    expect(issuePaths(template)).toEqual(['placeholders.1.pageIndex']);
  });

  it('rejects a box that is entirely off its page, but allows one that overhangs', () => {
    const off = validTemplate();
    off.placeholders[0]!.box = { x: 900, y: 10, width: 50, height: 20 };
    expect(issuePaths(off)).toEqual(['placeholders.0.box']);

    const overhanging = validTemplate();
    overhanging.placeholders[0]!.box = { x: 800, y: 10, width: 100, height: 20 };
    expect(validateTemplate(overhanging).ok).toBe(true);
  });

  it('rejects text that references a font the template does not declare', () => {
    const template = validTemplate();
    template.fonts = [];
    expect(issuePaths(template)).toEqual(['placeholders.0.style.fontId']);
  });

  it('rejects minFontSize above fontSize', () => {
    const template = validTemplate();
    const text = template.placeholders[0];
    if (text?.type === 'text') text.fit.minFontSize = 40;
    expect(issuePaths(template)).toEqual(['placeholders.0.fit.minFontSize']);
  });

  it('rejects duplicate placeholder and font ids', () => {
    const template = validTemplate();
    template.placeholders[2]!.id = 'name';
    template.fonts.push({
      id: 'body',
      label: 'Again',
      source: { kind: 'standard', name: 'Courier' },
    });
    expect(issuePaths(template).sort()).toEqual(['fonts.1.id', 'placeholders.2.id']);
  });

  it('rejects out-of-range numbers', () => {
    const template = validTemplate();
    template.placeholders[0]!.opacity = 1.5;
    const image = template.placeholders[1];
    if (image?.type === 'image') image.position = { x: 2, y: 0 };
    const qr = template.placeholders[2];
    if (qr?.type === 'qr') qr.quietZone = 40;
    expect(issuePaths(template).sort()).toEqual([
      'placeholders.0.opacity',
      'placeholders.1.position.x',
      'placeholders.2.quietZone',
    ]);
  });

  it('rejects non-objects without throwing', () => {
    expect(validateTemplate(null).ok).toBe(false);
    expect(validateTemplate('template').ok).toBe(false);
  });
});
