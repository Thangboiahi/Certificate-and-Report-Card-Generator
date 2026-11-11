/**
 * Test support: look at a generated PDF through an INDEPENDENT renderer (poppler's command-line
 * tools), so the tests check what a viewer shows rather than what our own code believes it drew.
 *
 * Needs `pdftoppm` and `pdftotext` (Debian/Ubuntu: `apt-get install poppler-utils`). Suites that
 * depend on it use `describe.skipIf(!HAS_POPPLER)`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const HAS_POPPLER =
  spawnSync('pdftoppm', ['-v']).status === 0 && spawnSync('pdftotext', ['-v']).status === 0;

/** Rendered pages are also written here (git-ignored) so a person can look at them. */
const OUTPUT_DIRECTORY = join(process.cwd(), 'tests', 'output');

export type Rgb = [red: number, green: number, blue: number];

export interface RenderedPage {
  /** Pixels per PDF point. */
  scale: number;
  width: number;
  height: number;
  /** Colour at a position given in PDF points from the page's top-left corner. */
  colorAt(xPoints: number, yPoints: number): Rgb;
}

function withTemporaryPdf<T>(pdf: Uint8Array, run: (path: string, directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'engine-test-'));
  try {
    const path = join(directory, 'document.pdf');
    writeFileSync(path, pdf);
    return run(path, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Rasterises one page (1-based) of a PDF. `name`, if given, also saves a PNG for inspection. */
export function renderPage(
  pdf: Uint8Array,
  pageNumber = 1,
  options: { dpi?: number; name?: string } = {},
): RenderedPage {
  const dpi = options.dpi ?? 72;

  if (options.name) {
    mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
    withTemporaryPdf(pdf, (path) => {
      const page = String(pageNumber);
      const target = join(OUTPUT_DIRECTORY, options.name as string);
      execFileSync('pdftoppm', [
        '-r',
        '110',
        '-f',
        page,
        '-l',
        page,
        '-png',
        '-singlefile',
        path,
        target,
      ]);
    });
  }

  return withTemporaryPdf(pdf, (path, directory) => {
    const page = String(pageNumber);
    const prefix = join(directory, 'page');
    execFileSync('pdftoppm', [
      '-r',
      String(dpi),
      '-f',
      page,
      '-l',
      page,
      '-singlefile',
      path,
      prefix,
    ]);
    const ppm = readFileSync(`${prefix}.ppm`);

    // Binary PPM: "P6\n<width> <height>\n<max>\n" followed by RGB triples.
    let offset = 0;
    const token = (): string => {
      while (ppm[offset] === 0x0a || ppm[offset] === 0x20) offset++;
      const start = offset;
      while (ppm[offset] !== 0x0a && ppm[offset] !== 0x20) offset++;
      return ppm.toString('latin1', start, offset);
    };
    if (token() !== 'P6') throw new Error('Unexpected pdftoppm output');
    const width = Number(token());
    const height = Number(token());
    token(); // max colour value
    const data = ppm.subarray(offset + 1);
    const scale = dpi / 72;

    return {
      scale,
      width,
      height,
      colorAt(xPoints, yPoints) {
        const x = Math.min(width - 1, Math.max(0, Math.round(xPoints * scale)));
        const y = Math.min(height - 1, Math.max(0, Math.round(yPoints * scale)));
        const index = (y * width + x) * 3;
        return [data[index] as number, data[index + 1] as number, data[index + 2] as number];
      },
    };
  });
}

export interface ExtractedWord {
  text: string;
  /** Bounding box in PDF points from the page's top-left corner. */
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/** The words a viewer finds on one page (1-based), with their positions. */
export function extractWords(pdf: Uint8Array, pageNumber = 1): ExtractedWord[] {
  return withTemporaryPdf(pdf, (path) => {
    const page = String(pageNumber);
    const xhtml = execFileSync('pdftotext', ['-bbox', '-f', page, '-l', page, path, '-'], {
      encoding: 'utf8',
    });
    const words: ExtractedWord[] = [];
    const pattern =
      /<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([^<]*)<\/word>/g;
    for (const match of xhtml.matchAll(pattern)) {
      words.push({
        xMin: Number(match[1]),
        yMin: Number(match[2]),
        xMax: Number(match[3]),
        yMax: Number(match[4]),
        text: (match[5] ?? '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'"),
      });
    }
    return words;
  });
}

/** All text of a page as a viewer would copy it. */
export function extractText(pdf: Uint8Array, pageNumber = 1): string {
  return withTemporaryPdf(pdf, (path) => {
    const page = String(pageNumber);
    return execFileSync('pdftotext', ['-f', page, '-l', page, path, '-'], { encoding: 'utf8' });
  });
}

/** True when two colours are within `tolerance` on every channel (JPEG noise, anti-aliasing). */
export function colorsMatch(actual: Rgb, expected: Rgb, tolerance = 28): boolean {
  return actual.every(
    (channel, index) => Math.abs(channel - (expected[index] as number)) <= tolerance,
  );
}
