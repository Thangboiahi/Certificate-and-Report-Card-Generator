import { describe, expect, it } from 'vitest';

import {
  cellToString,
  listTemplateColumns,
  listTokenColumns,
  renderTokens,
  resolveBinding,
} from './bindings';

describe('cellToString', () => {
  it('renders blanks as empty and trims text', () => {
    expect(cellToString(null)).toBe('');
    expect(cellToString(undefined)).toBe('');
    expect(cellToString('  Asha Rao ')).toBe('Asha Rao');
  });

  it('renders numbers and booleans the way a sheet shows them', () => {
    expect(cellToString(42)).toBe('42');
    expect(cellToString(91.5)).toBe('91.5');
    expect(cellToString(true)).toBe('TRUE');
    expect(cellToString(Number.NaN)).toBe('');
  });
});

describe('renderTokens', () => {
  const row = { 'First Name': 'Asha', Last: 'Rao', Roll: 17 };

  it('substitutes tokens, ignoring whitespace inside the braces', () => {
    expect(renderTokens('{{First Name}} {{ Last }} ({{Roll}})', row)).toBe('Asha Rao (17)');
  });

  it('renders unknown columns as empty', () => {
    expect(renderTokens('ID: {{Missing}}', row)).toBe('ID: ');
  });

  it('leaves text without tokens untouched', () => {
    expect(renderTokens('Certificate of Merit', row)).toBe('Certificate of Merit');
    expect(renderTokens('{not a token}', row)).toBe('{not a token}');
  });
});

describe('resolveBinding', () => {
  const row = { Name: ' Asha ', ID: 'C-9' };

  it('resolves each binding kind', () => {
    expect(resolveBinding({ kind: 'column', column: 'Name' }, row)).toBe('Asha');
    expect(resolveBinding({ kind: 'column', column: 'Nope' }, row)).toBe('');
    expect(resolveBinding({ kind: 'template', template: 'https://v.in/{{ID}}' }, row)).toBe(
      'https://v.in/C-9',
    );
    expect(resolveBinding({ kind: 'static', value: 'Principal' }, row)).toBe('Principal');
  });
});

describe('column discovery', () => {
  it('lists token columns once, in order of first appearance', () => {
    expect(listTokenColumns('{{B}} {{A}} {{ B }}')).toEqual(['B', 'A']);
  });

  it('collects every column a template reads, including the file name', () => {
    const columns = listTemplateColumns({
      placeholders: [
        {
          id: 'a',
          type: 'qr',
          label: '',
          pageIndex: 0,
          box: { x: 0, y: 0, width: 1, height: 1 },
          binding: { kind: 'template', template: '{{ID}}/{{Name}}' },
          errorCorrection: 'M',
          foreground: '#000000',
          quietZone: 4,
        },
        {
          id: 'b',
          type: 'image',
          label: '',
          pageIndex: 0,
          box: { x: 0, y: 0, width: 1, height: 1 },
          binding: { kind: 'column', column: 'Photo' },
          fit: 'cover',
        },
      ],
      output: { fileNameTemplate: '{{Roll}} - {{Name}}' },
    });
    expect(columns).toEqual(['ID', 'Name', 'Photo', 'Roll']);
  });
});
