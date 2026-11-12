/**
 * How the editor previews a placeholder's content in HTML/CSS. A preview, not a rendering: the
 * position and box are exact, but shrink-to-fit, Indic shaping and line breaking are done by the
 * engine when the PDF is generated, and may differ slightly from the browser's.
 */
import {
  resolveBinding,
  type DataRow,
  type Placeholder,
  type StandardFontName,
  type TemplateFont,
} from '@/lib/template';

export interface CssFont {
  fontFamily: string;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
}

const STANDARD_FAMILIES: Record<'Helvetica' | 'Times' | 'Courier', string> = {
  Helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  Times: '"Times New Roman", Times, "Liberation Serif", serif',
  Courier: '"Courier New", Courier, "Liberation Mono", monospace',
};

function standardFont(name: StandardFontName): CssFont {
  const family = name.startsWith('Times')
    ? 'Times'
    : name.startsWith('Courier')
      ? 'Courier'
      : 'Helvetica';
  return {
    fontFamily: STANDARD_FAMILIES[family],
    fontWeight: name.includes('Bold') ? 700 : 400,
    fontStyle: /Oblique|Italic/.test(name) ? 'italic' : 'normal',
  };
}

/** CSS family name under which the editor registers a template font's file (`FontFace`). */
export function fontFaceName(fontId: string): string {
  return `template-font-${fontId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** CSS font settings for a template font. Library and uploaded fonts use their registered face. */
export function cssFontFor(font: TemplateFont | undefined): CssFont {
  if (!font) return standardFont('Helvetica');
  if (font.source.kind === 'standard') return standardFont(font.source.name);
  const weight = /\/(\d{3})$/.exec(font.source.kind === 'library' ? font.source.key : '');
  return {
    fontFamily: `"${fontFaceName(font.id)}", sans-serif`,
    fontWeight: weight ? Number(weight[1]) : 400,
    fontStyle: 'normal',
  };
}

/**
 * The text shown inside a placeholder on the canvas: the value from the preview row when there is
 * one, otherwise a stand-in that says where the value comes from.
 */
export function previewText(placeholder: Placeholder, row: DataRow | undefined): string {
  const { binding } = placeholder;
  if (row) {
    const value = resolveBinding(binding, row).trim();
    if (value) return value;
    if (placeholder.type === 'text' && placeholder.fallbackText) return placeholder.fallbackText;
  }
  switch (binding.kind) {
    case 'column':
      return `{{${binding.column}}}`;
    case 'template':
      return binding.template;
    case 'static':
      return binding.value || placeholder.label;
  }
}
