/**
 * Test support for the engine: fixture files, throwaway template PDFs, and a helper that runs a
 * job and collects everything it produced.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { degrees, PDFDocument, rgb } from 'pdf-lib';

import {
  generateDocuments,
  type EngineDependencies,
  type GeneratedDocument,
  type GenerationOptions,
  type GenerationProgress,
  type GenerationResult,
} from '@/lib/pdf-engine';
import {
  TEMPLATE_SCHEMA_VERSION,
  type DataRow,
  type Placeholder,
  type TemplateDefinition,
  type TemplateFont,
  type TextPlaceholder,
} from '@/lib/template';

const ROOT = process.cwd();

/** Bytes of a file in `tests/fixtures/images`. */
export function fixtureImage(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(ROOT, 'tests', 'fixtures', 'images', name)));
}

const NOTO_FONTS = {
  devanagari:
    '@expo-google-fonts/noto-sans-devanagari/400Regular/NotoSansDevanagari_400Regular.ttf',
  bengali: '@expo-google-fonts/noto-sans-bengali/400Regular/NotoSansBengali_400Regular.ttf',
  tamil: '@expo-google-fonts/noto-sans-tamil/400Regular/NotoSansTamil_400Regular.ttf',
} as const;

export type NotoFont = keyof typeof NOTO_FONTS;

/** A Noto Sans font file (each also covers Latin). Installed as a dev dependency for tests. */
export function notoFont(name: NotoFont): Uint8Array {
  return new Uint8Array(readFileSync(join(ROOT, 'node_modules', NOTO_FONTS[name])));
}

export interface TemplatePageSpec {
  /** Size of the page as stored, before rotation. */
  width: number;
  height: number;
  /** The page's /Rotate entry. */
  rotate?: 0 | 90 | 180 | 270;
  /** Shifts the page's coordinate origin, as some PDF producers do. */
  origin?: { x: number; y: number };
  /** Leave the page without any content stream. */
  blank?: boolean;
}

/** Light grey: easy to tell apart from white paper and from anything a test draws. */
export const BACKGROUND_GREY: [number, number, number] = [235, 235, 235];

/**
 * Builds a background PDF. Every non-blank page is filled light grey with a darker frame, so a
 * rendered output shows whether the background was carried over.
 */
export async function createTemplatePdf(pages: readonly TemplatePageSpec[]): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  for (const spec of pages) {
    const page = document.addPage([spec.width, spec.height]);
    const x = spec.origin?.x ?? 0;
    const y = spec.origin?.y ?? 0;
    if (spec.origin) {
      page.setMediaBox(x, y, spec.width, spec.height);
      page.setCropBox(x, y, spec.width, spec.height);
    }
    if (spec.rotate) page.setRotation(degrees(spec.rotate));
    if (!spec.blank) {
      const grey = BACKGROUND_GREY[0] / 255;
      page.drawRectangle({
        x,
        y,
        width: spec.width,
        height: spec.height,
        color: rgb(grey, grey, grey),
      });
      page.drawRectangle({
        x: x + 6,
        y: y + 6,
        width: spec.width - 12,
        height: spec.height - 12,
        borderColor: rgb(0.55, 0.55, 0.55),
        borderWidth: 1,
      });
    }
  }
  return document.save();
}

/** The size at which a page is displayed (rotation applied). */
export function displayedSize(spec: TemplatePageSpec): { width: number; height: number } {
  return spec.rotate === 90 || spec.rotate === 270
    ? { width: spec.height, height: spec.width }
    : { width: spec.width, height: spec.height };
}

export const HELVETICA: TemplateFont = {
  id: 'helvetica',
  label: 'Helvetica',
  source: { kind: 'standard', name: 'Helvetica' },
};

export function libraryFont(id: NotoFont): TemplateFont {
  return { id, label: `Noto Sans ${id}`, source: { kind: 'library', key: `noto-sans-${id}/400` } };
}

/** A template over the given pages. */
export function createTemplate(
  pages: readonly TemplatePageSpec[],
  placeholders: Placeholder[],
  fonts: TemplateFont[] = [HELVETICA],
): TemplateDefinition {
  return {
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    kind: 'certificate',
    source: { storagePath: 'test/template.pdf', fileName: 'template.pdf', byteSize: 0, sha256: '' },
    pages: pages.map(displayedSize),
    fonts,
    placeholders,
    output: { fileNameTemplate: '{{Name}}' },
  };
}

/** A text placeholder with sensible defaults; override what a test cares about. */
export function textBox(
  overrides: Partial<TextPlaceholder> & Pick<TextPlaceholder, 'id' | 'box'>,
): TextPlaceholder {
  return {
    type: 'text',
    label: overrides.id,
    pageIndex: 0,
    binding: { kind: 'column', column: 'Name' },
    ...overrides,
    style: {
      fontId: 'helvetica',
      fontSize: 20,
      color: '#000000',
      align: 'left',
      verticalAlign: 'top',
      lineHeight: 1.2,
      ...overrides.style,
    },
    fit: { wrap: false, shrinkToFit: false, minFontSize: 6, overflow: 'visible', ...overrides.fit },
  };
}

export interface FixtureLoader {
  dependencies: EngineDependencies;
  /** Every source requested, in order. */
  requests: string[];
  /** Highest number of downloads that were in flight at the same time. */
  peakConcurrency(): number;
}

/**
 * An image loader that serves `https://img.test/<file>` from `tests/fixtures/images`, the way the
 * proxy would, and fails like a 404 for anything else.
 */
export function createFixtureLoader(options: { delayMs?: number } = {}): FixtureLoader {
  const requests: string[] = [];
  let active = 0;
  let peak = 0;

  return {
    requests,
    peakConcurrency: () => peak,
    dependencies: {
      async loadImage(source, signal) {
        requests.push(source);
        active++;
        peak = Math.max(peak, active);
        try {
          if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
          if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
          const name = /^https:\/\/img\.test\/([\w.-]+)$/.exec(source)?.[1];
          if (!name) throw new Error('The image host answered with HTTP 404.');
          try {
            return fixtureImage(name);
          } catch {
            throw new Error('The image host answered with HTTP 404.');
          }
        } finally {
          active--;
        }
      },
    },
  };
}

export interface EngineRun {
  result: GenerationResult;
  documents: GeneratedDocument[];
  progress: GenerationProgress[];
  loader: FixtureLoader;
}

/** Runs a job against the fixture loader and collects its output. */
export async function runEngine(input: {
  template: TemplateDefinition;
  templatePdf: Uint8Array;
  rows: DataRow[];
  fonts?: Record<string, Uint8Array>;
  options?: Partial<GenerationOptions>;
  loader?: FixtureLoader;
}): Promise<EngineRun> {
  const loader = input.loader ?? createFixtureLoader();
  const documents: GeneratedDocument[] = [];
  const progress: GenerationProgress[] = [];

  const result = await generateDocuments(
    {
      template: input.template,
      assets: { templatePdf: input.templatePdf, fonts: input.fonts ?? {} },
      rows: input.rows,
      options: { mode: 'separate', ...input.options },
    },
    loader.dependencies,
    {
      onDocument: (document) => void documents.push(document),
      onProgress: (update) => void progress.push(update),
    },
  );
  return { result, documents, progress, loader };
}
