/**
 * Builds the first `TemplateDefinition` for a freshly uploaded background, so the editor has
 * something to open: one text field per CSV column, stacked down the first page, ready to be
 * dragged into place (Tap-to-Place). Geometry is in PDF points (ADR-003).
 */
import {
  TEMPLATE_SCHEMA_VERSION,
  type Placeholder,
  type TemplateDefinition,
  type TemplatePage,
  type TemplateSource,
} from '@/lib/template';

const PHOTO_COLUMN = /photo|image|picture|logo|signature/i;
const ROW_HEIGHT = 40;
const GAP = 8;
const PHOTO_SIZE = 90;

export interface StarterTemplateInput {
  source: Pick<TemplateSource, 'fileName' | 'byteSize' | 'sha256'>;
  pages: TemplatePage[];
  /** CSV headers; empty to start with no fields. */
  columns?: string[];
}

/** A unique, stable id for a column's field. */
function placeholderId(column: string, taken: Set<string>): string {
  const base = `col-${
    column
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'field'
  }`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** Fields for the given columns, stacked from `startY` down page `pageIndex`. */
export function placeholdersForColumns(
  columns: string[],
  page: TemplatePage,
  takenIds: Set<string> = new Set(),
  startY = page.height * 0.2,
  pageIndex = 0,
): Placeholder[] {
  const width = Math.min(page.width * 0.6, page.width - 40);
  const x = (page.width - width) / 2;
  const maxY = page.height - ROW_HEIGHT;
  let y = startY;
  return columns.map((column): Placeholder => {
    const isImage = PHOTO_COLUMN.test(column);
    const height = isImage ? PHOTO_SIZE : ROW_HEIGHT;
    // Wrap to the top of the stack rather than run off the page with many columns.
    if (y + height > maxY) y = GAP;
    const box = isImage
      ? { x: (page.width - PHOTO_SIZE) / 2, y, width: PHOTO_SIZE, height }
      : { x, y, width, height };
    y += height + GAP;
    const base = {
      id: placeholderId(column, takenIds),
      label: column,
      pageIndex,
      box,
      binding: { kind: 'column', column } as const,
    };
    return isImage
      ? { ...base, type: 'image', fit: 'cover' }
      : {
          ...base,
          type: 'text',
          style: {
            fontId: 'sans',
            fontSize: 18,
            color: '#26262E',
            align: 'center',
            verticalAlign: 'middle',
            lineHeight: 1.2,
          },
          fit: { wrap: false, shrinkToFit: true, minFontSize: 8, overflow: 'ellipsis' },
        };
  });
}

export function buildStarterTemplate({
  source,
  pages,
  columns = [],
}: StarterTemplateInput): TemplateDefinition {
  const first = pages[0];
  return {
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    kind: 'certificate',
    source: { storagePath: '', ...source },
    pages,
    fonts: [{ id: 'sans', label: 'Helvetica', source: { kind: 'standard', name: 'Helvetica' } }],
    placeholders: first ? placeholdersForColumns(columns, first) : [],
    output: {
      fileNameTemplate: columns[0] ? `{{${columns[0]}}}` : source.fileName.replace(/\.[^.]+$/, ''),
    },
  };
}

/** The template's display name: the uploaded file's name without its extension. */
export function templateTitle(template: TemplateDefinition): string {
  return template.source.fileName.replace(/\.[^.]+$/, '') || 'Untitled template';
}
