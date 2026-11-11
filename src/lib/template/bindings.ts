/**
 * Turning a data row into the content of a placeholder.
 *
 * Token syntax is `{{Column Header}}`. Whitespace inside the braces is ignored, so
 * `{{ Student Name }}` and `{{Student Name}}` are the same token. A token naming a column the row
 * does not have resolves to an empty string — `listTemplateColumns` lets callers detect that
 * before a batch starts instead of discovering blanks afterwards.
 */
import type { CellValue, DataBinding, DataRow, TemplateDefinition } from './types';

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** The text a cell contributes to a document. Sheets-style: blanks are empty, booleans upper-case. */
export function cellToString(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return value.trim();
}

/** Replaces every `{{Column}}` token with that column's value for this row. */
export function renderTokens(template: string, row: DataRow): string {
  return template.replace(TOKEN, (_match, column: string) => cellToString(row[column]));
}

/** Column headers referenced by a token template, in order of first appearance. */
export function listTokenColumns(template: string): string[] {
  const columns = new Set<string>();
  for (const match of template.matchAll(TOKEN)) {
    if (match[1] !== undefined) columns.add(match[1]);
  }
  return [...columns];
}

/** The content a binding produces for one row. */
export function resolveBinding(binding: DataBinding, row: DataRow): string {
  switch (binding.kind) {
    case 'column':
      return cellToString(row[binding.column]);
    case 'template':
      return renderTokens(binding.template, row).trim();
    case 'static':
      return binding.value;
  }
}

/** Column headers a binding reads. */
export function listBindingColumns(binding: DataBinding): string[] {
  switch (binding.kind) {
    case 'column':
      return [binding.column];
    case 'template':
      return listTokenColumns(binding.template);
    case 'static':
      return [];
  }
}

/**
 * Every column header a template needs from the data source, including the ones used in the
 * output file name. Compare against the sheet's headers to warn about missing columns up front.
 */
export function listTemplateColumns(
  template: Pick<TemplateDefinition, 'placeholders' | 'output'>,
): string[] {
  const columns = new Set<string>();
  for (const placeholder of template.placeholders) {
    for (const column of listBindingColumns(placeholder.binding)) columns.add(column);
  }
  for (const column of listTokenColumns(template.output.fileNameTemplate)) columns.add(column);
  return [...columns];
}
