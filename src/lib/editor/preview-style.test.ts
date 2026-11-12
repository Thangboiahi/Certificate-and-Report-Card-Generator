import { describe, expect, it } from 'vitest';

import type { TextPlaceholder } from '@/lib/template';

import { cssFontFor, fontFaceName, previewText } from './preview-style';

const NAME: TextPlaceholder = {
  id: 'name',
  type: 'text',
  label: 'Name',
  pageIndex: 0,
  box: { x: 0, y: 0, width: 100, height: 20 },
  binding: { kind: 'column', column: 'Student Name' },
  fallbackText: '—',
  style: {
    fontId: 'f',
    fontSize: 12,
    color: '#000000',
    align: 'left',
    verticalAlign: 'top',
    lineHeight: 1.2,
  },
  fit: { wrap: false, shrinkToFit: true, minFontSize: 6, overflow: 'ellipsis' },
};

describe('preview style', () => {
  it('maps the standard PDF fonts to similar CSS faces', () => {
    expect(
      cssFontFor({ id: 'a', label: '', source: { kind: 'standard', name: 'Times-BoldItalic' } }),
    ).toMatchObject({ fontWeight: 700, fontStyle: 'italic' });
    expect(
      cssFontFor({ id: 'a', label: '', source: { kind: 'standard', name: 'Courier' } }).fontFamily,
    ).toContain('monospace');
  });

  it('uses the registered face and catalogue weight for library fonts', () => {
    const css = cssFontFor({
      id: 'deva bold',
      label: '',
      source: { kind: 'library', key: 'noto-sans-devanagari/700' },
    });
    expect(css.fontFamily).toContain(fontFaceName('deva bold'));
    expect(fontFaceName('deva bold')).toBe('template-font-deva_bold');
    expect(css.fontWeight).toBe(700);
  });

  it('shows the row value, then the fallback, then where the value comes from', () => {
    expect(previewText(NAME, { 'Student Name': 'आरव शर्मा' })).toBe('आरव शर्मा');
    expect(previewText(NAME, { 'Student Name': '  ' })).toBe('—');
    expect(previewText(NAME, undefined)).toBe('{{Student Name}}');
    expect(
      previewText({ ...NAME, binding: { kind: 'template', template: 'Roll {{Roll}}' } }, undefined),
    ).toBe('Roll {{Roll}}');
  });
});
