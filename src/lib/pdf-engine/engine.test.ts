/**
 * End-to-end tests of the engine. Each one generates real PDFs and — wherever the claim is about
 * what ends up on the page — inspects them with poppler, an independent renderer: pixel colours
 * for images and QR codes, word positions for text.
 */
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import type { ImagePlaceholder, Placeholder, QrPlaceholder } from '@/lib/template';

import {
  BACKGROUND_GREY,
  createFixtureLoader,
  createTemplate,
  createTemplatePdf,
  fixtureImage,
  HELVETICA,
  libraryFont,
  notoFont,
  runEngine,
  textBox,
  type TemplatePageSpec,
} from '../../../tests/support/engine-fixtures';
import {
  colorsMatch,
  extractText,
  extractWords,
  HAS_POPPLER,
  renderPage,
  type Rgb,
} from '../../../tests/support/poppler';
import { createQrMatrix } from './draw-qr';
import { EngineError } from './errors';
import { FontRegistry } from './fonts';
import { generateDocuments, readPdfPages } from './engine';

const RED: Rgb = [220, 40, 40];
const GREEN: Rgb = [40, 170, 70];
const BLUE: Rgb = [40, 80, 220];
const YELLOW: Rgb = [240, 200, 40];
const WHITE: Rgb = [255, 255, 255];

/** A white page: anything a test draws stands out, and "nothing drawn" is plain white. */
const BLANK: TemplatePageSpec = { width: 400, height: 300, blank: true };
const GREY_PAGE: TemplatePageSpec = { width: 400, height: 300 };

const image = (
  overrides: Partial<ImagePlaceholder> & Pick<ImagePlaceholder, 'id' | 'box'>,
): ImagePlaceholder => ({
  type: 'image',
  label: overrides.id,
  pageIndex: 0,
  binding: { kind: 'column', column: 'Photo' },
  fit: 'cover',
  ...overrides,
});

const photo = (name: string) => `https://img.test/${name}`;

async function generateOne(
  placeholders: Placeholder[],
  row: Record<string, string> = { Name: 'Asha Rao' },
  pages: TemplatePageSpec[] = [BLANK],
) {
  const run = await runEngine({
    template: createTemplate(pages, placeholders),
    templatePdf: await createTemplatePdf(pages),
    rows: [row],
  });
  return { ...run, pdf: run.documents[0]?.bytes };
}

/** Asserts the four quadrant colours of the fixture photo at the corners of a displayed box. */
function expectUprightQuadrants(
  page: ReturnType<typeof renderPage>,
  box: { x: number; y: number; width: number; height: number },
  label = '',
) {
  const inset = Math.min(box.width, box.height) * 0.12;
  const corners: Array<[string, number, number, Rgb]> = [
    ['top-left', box.x + inset, box.y + inset, RED],
    ['top-right', box.x + box.width - inset, box.y + inset, GREEN],
    ['bottom-left', box.x + inset, box.y + box.height - inset, BLUE],
    ['bottom-right', box.x + box.width - inset, box.y + box.height - inset, YELLOW],
  ];
  for (const [corner, x, y, expected] of corners) {
    const actual = page.colorAt(x, y);
    expect(colorsMatch(actual, expected), `${label} ${corner}: got rgb(${actual.join(',')})`).toBe(
      true,
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_POPPLER)('text', () => {
  it('aligns text left, centre and right inside its box', async () => {
    const box = (y: number) => ({ x: 100, y, width: 200, height: 30 });
    const { pdf } = await generateOne(
      (['left', 'center', 'right'] as const).map((align, index) =>
        textBox({
          id: align,
          box: box(20 + index * 40),
          binding: { kind: 'static', value: 'Hamburg' },
          style: {
            fontId: 'helvetica',
            fontSize: 20,
            color: '#000000',
            align,
            verticalAlign: 'top',
            lineHeight: 1.2,
          },
        }),
      ),
    );
    const [left, centre, right] = extractWords(pdf!);

    expect(left!.xMin).toBeCloseTo(100, 0);
    expect((centre!.xMin + centre!.xMax) / 2).toBeCloseTo(200, 0);
    expect(right!.xMax).toBeCloseTo(300, 0);
    // Same word, same size: the three are equally wide.
    expect(centre!.xMax - centre!.xMin).toBeCloseTo(left!.xMax - left!.xMin, 1);
  });

  it('places text at the top, middle and bottom of its box', async () => {
    const { pdf } = await generateOne(
      (['top', 'middle', 'bottom'] as const).map((verticalAlign, index) =>
        textBox({
          id: verticalAlign,
          box: { x: 20 + index * 120, y: 50, width: 110, height: 100 },
          binding: { kind: 'static', value: 'Hxg' },
          style: {
            fontId: 'helvetica',
            fontSize: 20,
            color: '#000000',
            align: 'left',
            verticalAlign,
            lineHeight: 1.2,
          },
        }),
      ),
    );
    const [top, middle, bottom] = extractWords(pdf!).sort((a, b) => a.xMin - b.xMin);

    // The block spans ascent to descent: 18.5 pt tall for 20 pt Helvetica.
    expect(top!.yMin).toBeCloseTo(50, 0);
    expect((middle!.yMin + middle!.yMax) / 2).toBeCloseTo(100, 0);
    expect(bottom!.yMax).toBeCloseTo(150, 0);
  });

  it('shrinks a long name onto one line that exactly fits', async () => {
    const box = { x: 50, y: 40, width: 300, height: 40 };
    const { pdf, result } = await generateOne(
      [
        textBox({
          id: 'name',
          box,
          style: {
            fontId: 'helvetica',
            fontSize: 32,
            color: '#000000',
            align: 'center',
            verticalAlign: 'middle',
            lineHeight: 1.2,
          },
          fit: { wrap: false, shrinkToFit: true, minFontSize: 6, overflow: 'ellipsis' },
        }),
      ],
      { Name: 'Venkata Subramanian Ramachandran Iyengar Krishnamurthy' },
    );
    const words = extractWords(pdf!);

    expect(words.map((word) => word.text).join(' ')).toBe(
      'Venkata Subramanian Ramachandran Iyengar Krishnamurthy',
    );
    expect(new Set(words.map((word) => Math.round(word.yMin))).size).toBe(1);
    expect(words[0]!.xMin).toBeGreaterThanOrEqual(box.x - 0.5);
    expect(words.at(-1)!.xMax).toBeLessThanOrEqual(box.x + box.width + 0.5);
    // "Exactly": it uses the full width rather than stopping at some coarse step below it.
    expect(words.at(-1)!.xMax - words[0]!.xMin).toBeGreaterThan(box.width - 2);
    expect(result.problemRows).toEqual([]);
  });

  it('wraps a paragraph inside its box and shrinks it until it fits', async () => {
    const box = { x: 40, y: 30, width: 180, height: 90 };
    const { pdf, result } = await generateOne(
      [
        textBox({
          id: 'remarks',
          box,
          style: {
            fontId: 'helvetica',
            fontSize: 18,
            color: '#000000',
            align: 'left',
            verticalAlign: 'top',
            lineHeight: 1.25,
          },
          fit: { wrap: true, shrinkToFit: true, minFontSize: 6, overflow: 'ellipsis' },
        }),
      ],
      {
        Name: 'Asha has shown remarkable progress in mathematics this year and takes part in every class discussion with real enthusiasm.',
      },
    );
    const words = extractWords(pdf!);
    const lines = new Set(words.map((word) => Math.round(word.yMin)));

    expect(lines.size).toBeGreaterThan(3);
    for (const word of words) {
      expect(word.xMin, word.text).toBeGreaterThanOrEqual(box.x - 0.5);
      expect(word.xMax, word.text).toBeLessThanOrEqual(box.x + box.width + 0.5);
      expect(word.yMin, word.text).toBeGreaterThanOrEqual(box.y - 1);
      expect(word.yMax, word.text).toBeLessThanOrEqual(box.y + box.height + 1);
    }
    expect(result.problemRows).toEqual([]);
  });

  it('warns when text cannot fit even at the smallest size, and shortens it', async () => {
    const { pdf, result } = await generateOne(
      [
        textBox({
          id: 'name',
          box: { x: 20, y: 20, width: 80, height: 20 },
          style: {
            fontId: 'helvetica',
            fontSize: 14,
            color: '#000000',
            align: 'left',
            verticalAlign: 'top',
            lineHeight: 1.2,
          },
          fit: { wrap: false, shrinkToFit: true, minFontSize: 12, overflow: 'ellipsis' },
        }),
      ],
      { Name: 'Venkata Subramanian Ramachandran' },
    );

    expect(result.succeededRows).toBe(1);
    expect(result.problemRows[0]!.warnings.map((warning) => warning.code)).toEqual([
      'TEXT_OVERFLOW',
    ]);
    const text = extractText(pdf!).trim();
    expect(text.endsWith('…')).toBe(true);
    expect(extractWords(pdf!).at(-1)!.xMax).toBeLessThanOrEqual(100.5);
  });

  it('draws kerned text exactly as wide as it was measured', async () => {
    const { pdf } = await generateOne([
      textBox({
        id: 'kerned',
        box: { x: 20, y: 20, width: 360, height: 60 },
        binding: { kind: 'static', value: 'AVATAR' },
        style: {
          fontId: 'helvetica',
          fontSize: 40,
          color: '#000000',
          align: 'left',
          verticalAlign: 'top',
          lineHeight: 1.2,
        },
      }),
    ]);
    const [word] = extractWords(pdf!);
    const face = (await FontRegistry.create([HELVETICA], {})).get('helvetica');
    const shaped = face.shapeWord('AVATAR');
    const unkerned = shaped.runs[0]!.glyphs.reduce(
      (total, glyph) => total + glyph.naturalAdvance,
      0,
    );

    expect(word!.xMax - word!.xMin).toBeCloseTo(shaped.width * 40, 0);
    expect(shaped.width * 40).toBeLessThan(unkerned * 40 - 8);
  });

  it('applies the case conversion and the fallback text', async () => {
    const { pdf } = await generateOne(
      [
        textBox({
          id: 'name',
          box: { x: 20, y: 20, width: 300, height: 30 },
          style: {
            fontId: 'helvetica',
            fontSize: 16,
            color: '#000000',
            align: 'left',
            verticalAlign: 'top',
            lineHeight: 1.2,
            textTransform: 'uppercase',
          },
        }),
        textBox({
          id: 'marks',
          box: { x: 20, y: 60, width: 300, height: 30 },
          binding: { kind: 'column', column: 'Marks' },
          fallbackText: 'ABSENT',
        }),
      ],
      { Name: 'asha rao', Marks: '' },
    );
    expect(extractText(pdf!)).toContain('ASHA RAO');
    expect(extractText(pdf!)).toContain('ABSENT');
  });

  it('rotates a placeholder about the centre of its box', async () => {
    const { pdf } = await generateOne([
      textBox({
        id: 'spine',
        box: { x: 150, y: 130, width: 100, height: 24 },
        rotation: 90,
        binding: { kind: 'static', value: 'Sideways' },
        style: {
          fontId: 'helvetica',
          fontSize: 18,
          color: '#000000',
          align: 'center',
          verticalAlign: 'middle',
          lineHeight: 1.2,
        },
      }),
    ]);
    const [word] = extractWords(pdf!);
    expect(word!.yMax - word!.yMin).toBeGreaterThan(word!.xMax - word!.xMin);
    expect((word!.xMin + word!.xMax) / 2).toBeCloseTo(200, 0);
    expect((word!.yMin + word!.yMax) / 2).toBeCloseTo(142, -1);
  });

  it('writes Indian-script text that a viewer can read back, without crashing on any of it', async () => {
    const fonts = [
      HELVETICA,
      libraryFont('devanagari'),
      libraryFont('bengali'),
      libraryFont('tamil'),
    ];
    const lines: Array<[string, string]> = [
      ['devanagari', 'नमस्ते भारत'],
      ['bengali', 'বাংলা ভাষা'],
      ['tamil', 'தமிழ் மொழி'],
    ];
    const run = await runEngine({
      template: createTemplate(
        [BLANK],
        lines.map(([fontId, value], index) =>
          textBox({
            id: fontId,
            box: { x: 20, y: 20 + index * 50, width: 360, height: 40 },
            binding: { kind: 'static', value },
            style: {
              fontId,
              fontSize: 24,
              color: '#000000',
              align: 'left',
              verticalAlign: 'middle',
              lineHeight: 1.2,
            },
          }),
        ),
        fonts,
      ),
      templatePdf: await createTemplatePdf([BLANK]),
      rows: [{}],
      fonts: {
        devanagari: notoFont('devanagari'),
        bengali: notoFont('bengali'),
        tamil: notoFont('tamil'),
      },
    });

    expect(run.result.problemRows).toEqual([]);
    const text = extractText(run.documents[0]!.bytes);
    // Simple syllables survive a copy-paste round trip; that proves glyphs are mapped back to
    // characters. (Reordered vowel signs legitimately come back in visual order.)
    expect(text).toContain('भारत');
    expect(text).toContain('বাংলা');
    expect(text).toContain('தமிழ்');
    // Subset fonts: three scripts add only a few kilobytes.
    expect(run.documents[0]!.bytes.byteLength).toBeLessThan(40_000);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_POPPLER)('images', () => {
  // The fixture photo is 300 × 200: four quadrants, red / green on top, blue / yellow below.

  it('cover fills the box and crops the overflow, without distortion', async () => {
    const box = { x: 100, y: 50, width: 100, height: 100 };
    const { pdf } = await generateOne([image({ id: 'p', box, fit: 'cover' })], {
      Photo: photo('landscape.jpg'),
    });
    const page = renderPage(pdf!);

    expectUprightQuadrants(page, box);
    // Nothing spills outside the box although the scaled image is 150 pt wide.
    expect(colorsMatch(page.colorAt(box.x - 6, 100), WHITE)).toBe(true);
    expect(colorsMatch(page.colorAt(box.x + box.width + 6, 100), WHITE)).toBe(true);
    // Undistorted: the white arrow is still centred.
    expect(colorsMatch(page.colorAt(150, 115), WHITE)).toBe(true);
  });

  it('contain shows the whole image and leaves the rest of the box empty', async () => {
    const box = { x: 100, y: 50, width: 100, height: 100 };
    const { pdf } = await generateOne([image({ id: 'p', box, fit: 'contain' })], {
      Photo: photo('landscape.jpg'),
    });
    const page = renderPage(pdf!);

    // The image is 100 × 66.7, centred: bands of 16.7 pt above and below.
    expect(colorsMatch(page.colorAt(150, 56), WHITE)).toBe(true);
    expect(colorsMatch(page.colorAt(150, 144), WHITE)).toBe(true);
    expectUprightQuadrants(page, { x: 100, y: 50 + 100 / 6, width: 100, height: 200 / 3 });
  });

  it('fill stretches the image to the box', async () => {
    const box = { x: 100, y: 50, width: 60, height: 180 };
    const { pdf } = await generateOne([image({ id: 'p', box, fit: 'fill' })], {
      Photo: photo('landscape.jpg'),
    });
    expectUprightQuadrants(renderPage(pdf!), box);
  });

  it('position chooses which part of a cropped photo is kept', async () => {
    // Portrait photo (200 × 300) in a wide box: only a horizontal slice is visible.
    const box = (x: number) => ({ x, y: 100, width: 100, height: 50 });
    const { pdf } = await generateOne(
      [
        image({ id: 'top', box: box(20), position: { x: 0.5, y: 0 } }),
        image({ id: 'centre', box: box(150) }),
        image({ id: 'bottom', box: box(280), position: { x: 0.5, y: 1 } }),
      ],
      { Photo: photo('portrait.jpg') },
    );
    const page = renderPage(pdf!);
    const leftEdge = (x: number, y: number) => page.colorAt(x + 10, y);

    // Keeping the top shows only the red/green half; keeping the bottom only blue/yellow.
    expect(colorsMatch(leftEdge(20, 105), RED)).toBe(true);
    expect(colorsMatch(leftEdge(20, 145), RED)).toBe(true);
    expect(colorsMatch(leftEdge(280, 105), BLUE)).toBe(true);
    expect(colorsMatch(leftEdge(280, 145), BLUE)).toBe(true);
    // Centred shows the boundary between them.
    expect(colorsMatch(leftEdge(150, 105), RED)).toBe(true);
    expect(colorsMatch(leftEdge(150, 145), BLUE)).toBe(true);
  });

  it('shows photos the right way up for every EXIF orientation', async () => {
    const boxes = [1, 2, 3, 4, 5, 6, 7, 8].map((orientation, index) => ({
      orientation,
      box: { x: 20 + (index % 4) * 95, y: 20 + Math.floor(index / 4) * 130, width: 75, height: 50 },
    }));
    const { pdf, result } = await generateOne(
      boxes.map(({ orientation, box }) =>
        image({
          id: `exif-${orientation}`,
          box,
          fit: 'contain',
          binding: { kind: 'static', value: photo(`exif-${orientation}.jpg`) },
        }),
      ),
    );
    const page = renderPage(pdf!, 1, { dpi: 144, name: 'engine-exif' });

    expect(result.problemRows).toEqual([]);
    for (const { orientation, box } of boxes)
      expectUprightQuadrants(page, box, `orientation ${orientation}`);
  });

  it('masks an image to an ellipse or to rounded corners', async () => {
    const ellipse = { x: 40, y: 40, width: 120, height: 120 };
    const rounded = { x: 220, y: 40, width: 120, height: 120 };
    const { pdf } = await generateOne(
      [
        image({ id: 'ellipse', box: ellipse, shape: { kind: 'ellipse' } }),
        image({ id: 'rounded', box: rounded, shape: { kind: 'rounded', radius: 30 } }),
      ],
      { Photo: photo('landscape.jpg') },
    );
    const page = renderPage(pdf!, 1, { name: 'engine-shapes' });

    for (const box of [ellipse, rounded]) {
      // The very corners of the box are cut away…
      expect(colorsMatch(page.colorAt(box.x + 3, box.y + 3), WHITE)).toBe(true);
      expect(colorsMatch(page.colorAt(box.x + box.width - 3, box.y + box.height - 3), WHITE)).toBe(
        true,
      );
      // …while the picture reaches almost to the middle of each side.
      expect(colorsMatch(page.colorAt(box.x + 10, box.y + 40), RED)).toBe(true);
      expect(colorsMatch(page.colorAt(box.x + box.width - 10, box.y + 80), YELLOW)).toBe(true);
    }
    // A 30 pt radius leaves this point inside the rounded box but outside the ellipse.
    expect(colorsMatch(page.colorAt(rounded.x + 18, rounded.y + 18), RED)).toBe(true);
    expect(colorsMatch(page.colorAt(ellipse.x + 12, ellipse.y + 12), WHITE)).toBe(true);
  });

  it('keeps PNG transparency, showing the background colour through it', async () => {
    const box = { x: 100, y: 50, width: 200, height: 100 };
    const { pdf } = await generateOne(
      [image({ id: 'logo', box, fit: 'contain', background: '#FFE9A8' })],
      { Photo: photo('logo.png') },
    );
    const page = renderPage(pdf!);

    expect(colorsMatch(page.colorAt(110, 60), [255, 233, 168])).toBe(true); // transparent corner
    expect(colorsMatch(page.colorAt(200, 100), [20, 40, 90])).toBe(true); // the disc
  });

  it('draws the border inside the box and applies opacity', async () => {
    const box = { x: 100, y: 50, width: 100, height: 100 };
    const { pdf } = await generateOne(
      [
        image({ id: 'bordered', box, fit: 'fill', border: { width: 6, color: '#000000' } }),
        image({ id: 'faded', box: { ...box, x: 250 }, fit: 'fill', opacity: 0.5 }),
      ],
      { Photo: photo('landscape.jpg') },
    );
    const page = renderPage(pdf!);

    expect(colorsMatch(page.colorAt(103, 100), [0, 0, 0])).toBe(true); // on the border
    expect(colorsMatch(page.colorAt(97, 100), WHITE)).toBe(true); // just outside the box
    expect(colorsMatch(page.colorAt(112, 62), RED)).toBe(true); // inside the border
    // Half-transparent red over white paper.
    expect(colorsMatch(page.colorAt(262, 62), [238, 148, 148])).toBe(true);
  });

  it('leaves the placeholder blank and warns when an image cannot be used', async () => {
    const box = (x: number) => ({ x, y: 50, width: 60, height: 60 });
    const { pdf, result } = await generateOne([
      image({
        id: 'missing',
        label: 'Photo',
        box: box(20),
        binding: { kind: 'static', value: photo('nope.jpg') },
      }),
      image({
        id: 'webp',
        label: 'Logo',
        box: box(100),
        binding: { kind: 'static', value: photo('landscape.webp') },
      }),
      image({
        id: 'corrupt',
        label: 'Sign',
        box: box(180),
        binding: { kind: 'static', value: photo('corrupt.jpg') },
      }),
      image({
        id: 'bad-link',
        label: 'Seal',
        box: box(260),
        binding: { kind: 'static', value: 'not a link' },
      }),
      image({
        id: 'fine',
        box: box(330),
        fit: 'fill',
        binding: { kind: 'static', value: photo('landscape.jpg') },
      }),
    ]);

    expect(result.succeededRows).toBe(1);
    expect(
      result.problemRows[0]!.warnings.map((warning) => [warning.placeholderId, warning.code]),
    ).toEqual([
      ['missing', 'IMAGE_LOAD_FAILED'],
      ['webp', 'IMAGE_UNSUPPORTED_FORMAT'],
      ['corrupt', 'IMAGE_INVALID'],
      ['bad-link', 'IMAGE_LOAD_FAILED'],
    ]);
    expect(result.problemRows[0]!.warnings[0]!.message).toBe(
      '"Photo": The image host answered with HTTP 404.',
    );

    const page = renderPage(pdf!);
    for (const x of [20, 100, 180, 260])
      expect(colorsMatch(page.colorAt(x + 30, 80), WHITE)).toBe(true);
    expectUprightQuadrants(page, box(330));
  });

  it('uses an image processor to convert formats pdf-lib cannot embed', async () => {
    const loader = createFixtureLoader();
    const box = { x: 100, y: 50, width: 150, height: 100 };
    const requests: Array<{ format: string; targetWidth: number; targetHeight: number }> = [];
    loader.dependencies.processImage = async ({ format, targetWidth, targetHeight }) => {
      requests.push({ format, targetWidth, targetHeight });
      // Stand-in for the browser's canvas conversion.
      return format === 'webp' ? { bytes: fixtureImage('landscape.jpg'), format: 'jpeg' } : null;
    };

    const run = await runEngine({
      template: createTemplate([BLANK], [image({ id: 'p', box, fit: 'fill' })]),
      templatePdf: await createTemplatePdf([BLANK]),
      rows: [{ Photo: photo('landscape.webp') }],
      loader,
      options: { imageDpi: 144 },
    });

    expect(run.result.problemRows).toEqual([]);
    // 150 × 100 pt at 144 dpi.
    expect(requests).toEqual([{ format: 'webp', targetWidth: 300, targetHeight: 200 }]);
    expectUprightQuadrants(renderPage(run.documents[0]!.bytes), box);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_POPPLER)('QR codes', () => {
  const qr = (overrides: Partial<QrPlaceholder> = {}): QrPlaceholder => ({
    id: 'qr',
    type: 'qr',
    label: 'Verification code',
    pageIndex: 0,
    box: { x: 100, y: 40, width: 200, height: 200 },
    binding: { kind: 'template', template: 'https://verify.example.in/c/{{ID}}' },
    errorCorrection: 'M',
    foreground: '#000000',
    quietZone: 4,
    ...overrides,
  });

  it('draws every module of the code where a scanner expects it', async () => {
    const value = 'https://verify.example.in/c/प्रमाण-2026-0001';
    const { pdf } = await generateOne([qr({ binding: { kind: 'static', value } })]);
    const page = renderPage(pdf!, 1, { dpi: 144, name: 'engine-qr' });

    const matrix = createQrMatrix(value, 'M')!;
    const moduleSize = 200 / (matrix.size + 8);
    let mismatches = 0;
    for (let row = 0; row < matrix.size; row++) {
      for (let column = 0; column < matrix.size; column++) {
        const centre = page.colorAt(
          100 + (4 + column + 0.5) * moduleSize,
          40 + (4 + row + 0.5) * moduleSize,
        );
        const isDark = centre[0] < 128;
        if (isDark !== matrix.isDark(row, column)) mismatches++;
      }
    }
    expect(matrix.size).toBeGreaterThanOrEqual(29);
    expect(mismatches).toBe(0);
    // The quiet zone stays empty.
    expect(colorsMatch(page.colorAt(100 + moduleSize * 2, 140), WHITE)).toBe(true);
  });

  it('centres a square code in a non-square box and honours the colours', async () => {
    const { pdf } = await generateOne(
      [
        qr({
          box: { x: 50, y: 100, width: 300, height: 100 },
          background: '#FFE9A8',
          foreground: '#1A2B6D',
        }),
      ],
      { ID: 'C-1' },
    );
    const page = renderPage(pdf!);

    // A 100 pt square in the middle of a 300 pt wide box: x from 150 to 250.
    expect(colorsMatch(page.colorAt(100, 150), WHITE)).toBe(true);
    expect(colorsMatch(page.colorAt(300, 150), WHITE)).toBe(true);
    expect(colorsMatch(page.colorAt(153, 103), [255, 233, 168])).toBe(true);
    // Top-left finder pattern: its outer ring is 4 modules in from the corner.
    const moduleSize = 100 / (createQrMatrix('https://verify.example.in/c/C-1', 'M')!.size + 8);
    expect(
      colorsMatch(page.colorAt(150 + 4.5 * moduleSize, 100 + 4.5 * moduleSize), [26, 43, 109], 40),
    ).toBe(true);
  });

  it('warns instead of drawing when the value is too long', async () => {
    const { result } = await generateOne([
      qr({ binding: { kind: 'static', value: 'x'.repeat(4000) } }),
    ]);
    expect(result.succeededRows).toBe(1);
    expect(result.problemRows[0]!.warnings).toEqual([
      {
        code: 'QR_TOO_LONG',
        placeholderId: 'qr',
        message: '"Verification code": the value is too long for a QR code.',
      },
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_POPPLER)('pages', () => {
  it('draws each placeholder on its own page and copies pages without placeholders unchanged', async () => {
    const pages = [GREY_PAGE, GREY_PAGE, GREY_PAGE];
    const { pdf } = await generateOne(
      [
        textBox({
          id: 'first',
          pageIndex: 0,
          box: { x: 20, y: 20, width: 300, height: 30 },
          binding: { kind: 'static', value: 'Front' },
        }),
        textBox({
          id: 'third',
          pageIndex: 2,
          box: { x: 20, y: 20, width: 300, height: 30 },
          binding: { kind: 'static', value: 'Back' },
        }),
      ],
      {},
      pages,
    );

    expect((await PDFDocument.load(pdf!)).getPageCount()).toBe(3);
    expect(extractText(pdf!, 1).trim()).toBe('Front');
    expect(extractText(pdf!, 2).trim()).toBe('');
    expect(extractText(pdf!, 3).trim()).toBe('Back');
    // The background came along on every page.
    for (const pageNumber of [1, 2, 3]) {
      expect(colorsMatch(renderPage(pdf!, pageNumber).colorAt(200, 250), BACKGROUND_GREY, 6)).toBe(
        true,
      );
    }
  });

  const AWKWARD_PAGES: Array<[string, TemplatePageSpec]> = [
    ['unrotated', { width: 300, height: 400 }],
    ['rotated 90°', { width: 300, height: 400, rotate: 90 }],
    ['rotated 180°', { width: 300, height: 400, rotate: 180 }],
    ['rotated 270°', { width: 300, height: 400, rotate: 270 }],
    ['with an offset origin', { width: 300, height: 400, origin: { x: -150, y: 60 } }],
    [
      'rotated 90° with an offset origin',
      { width: 300, height: 400, rotate: 90, origin: { x: 40, y: -25 } },
    ],
  ];

  describe.each(['separate', 'merged'] as const)('%s output', (mode) => {
    it.each(AWKWARD_PAGES)(
      'places content where the template says on a page %s',
      async (label, spec) => {
        // Positions are given for the page as displayed, whatever the PDF stores underneath.
        const photoBox = { x: 30, y: 20, width: 90, height: 60 };
        const textBoxAt = { x: 150, y: 100, width: 120, height: 30 };
        const run = await runEngine({
          template: createTemplate(
            [spec],
            [
              image({
                id: 'photo',
                box: photoBox,
                fit: 'fill',
                binding: { kind: 'static', value: photo('landscape.jpg') },
              }),
              textBox({
                id: 'label',
                box: textBoxAt,
                binding: { kind: 'static', value: 'Upright' },
              }),
            ],
          ),
          templatePdf: await createTemplatePdf([spec]),
          rows: [{}],
          options: { mode },
        });
        const pdf = run.documents[0]!.bytes;
        const displayed = spec.rotate === 90 || spec.rotate === 270 ? [400, 300] : [300, 400];
        const page = renderPage(pdf, 1, {
          name: `engine-page-${mode}-${label.replace(/\W+/g, '-')}`,
        });

        expect([page.width, page.height]).toEqual(displayed);
        expectUprightQuadrants(page, photoBox, label);

        const [word] = extractWords(pdf);
        expect(word!.text).toBe('Upright');
        expect(word!.xMin).toBeCloseTo(textBoxAt.x, 0);
        expect(word!.yMin).toBeCloseTo(textBoxAt.y, 0);
        // Reads left to right: wider than tall.
        expect(word!.xMax - word!.xMin).toBeGreaterThan(word!.yMax - word!.yMin);
        // The template's own content is still there, the right way round.
        expect(
          colorsMatch(page.colorAt(displayed[0]! / 2, displayed[1]! - 30), BACKGROUND_GREY, 6),
        ).toBe(true);
      },
    );
  });

  it('reads the displayed size of every page of a PDF', async () => {
    const pdf = await createTemplatePdf([
      { width: 595, height: 842 },
      { width: 595, height: 842, rotate: 90 },
      { width: 243, height: 153, origin: { x: 10, y: 10 } },
    ]);
    expect(await readPdfPages(pdf)).toEqual([
      { width: 595, height: 842 },
      { width: 842, height: 595 },
      { width: 243, height: 153 },
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────

describe('output files', () => {
  const NAME = textBox({ id: 'name', box: { x: 20, y: 20, width: 300, height: 30 } });

  it('separate: one file per row, named from the row, safe and unique', async () => {
    const run = await runEngine({
      template: createTemplate([GREY_PAGE], [NAME]),
      templatePdf: await createTemplatePdf([GREY_PAGE]),
      rows: [
        { Name: 'Asha Rao' },
        { Name: 'Class 10/A: Rahul' },
        { Name: 'asha rao' },
        { Name: '' },
      ],
    });

    expect(run.documents.map((document) => document.fileName)).toEqual([
      'Asha Rao.pdf',
      'Class 10-A- Rahul.pdf',
      'asha rao (2).pdf',
      'Document 4.pdf',
    ]);
    expect(run.documents.map((document) => document.rowIndexes)).toEqual([[0], [1], [2], [3]]);
    expect(run.result).toMatchObject({
      totalRows: 4,
      succeededRows: 4,
      failedRows: 0,
      documentCount: 4,
      cancelled: false,
    });
  });

  it('separate: the file name template can be overridden per job', async () => {
    const run = await runEngine({
      template: createTemplate([GREY_PAGE], [NAME]),
      templatePdf: await createTemplatePdf([GREY_PAGE]),
      rows: [{ Name: 'Asha', Roll: 7 }],
      options: { fileNameTemplate: '{{Roll}} - {{Name}}' },
    });
    expect(run.documents[0]!.fileName).toBe('7 - Asha.pdf');
  });

  it('merged: every row in one file, with the template stored only once', async () => {
    // Like a real certificate, each page carries artwork that dwarfs the text added per row.
    const withArtwork = { ...GREY_PAGE, artwork: fixtureImage('landscape.jpg') };
    const pages = [withArtwork, withArtwork];
    const templatePdf = await createTemplatePdf(pages);
    const rows = Array.from({ length: 40 }, (_, index) => ({ Name: `Student ${index + 1}` }));
    const template = createTemplate(pages, [NAME, { ...NAME, id: 'again', pageIndex: 1 }]);

    const merged = await runEngine({
      template,
      templatePdf,
      rows,
      options: { mode: 'merged', mergedFileName: 'Class 10' },
    });
    const separate = await runEngine({ template, templatePdf, rows });

    expect(merged.documents.map((document) => [document.fileName, document.pageCount])).toEqual([
      ['Class 10.pdf', 80],
    ]);
    expect(merged.documents[0]!.rowIndexes).toEqual(rows.map((_, index) => index));
    const separateTotal = separate.documents.reduce(
      (total, document) => total + document.bytes.byteLength,
      0,
    );
    // Forty separate files each repeat the artwork; the merged file holds it once.
    expect(merged.documents[0]!.bytes.byteLength).toBeLessThan(separateTotal / 8);
    expect(merged.documents[0]!.bytes.byteLength).toBeLessThan(templatePdf.byteLength + 40 * 1200);
  });

  it.skipIf(!HAS_POPPLER)(
    'merged: pages come out in row order, each with its own content',
    async () => {
      const pages = [GREY_PAGE, GREY_PAGE];
      const merged = await runEngine({
        template: createTemplate(pages, [
          NAME,
          {
            ...NAME,
            id: 'back',
            pageIndex: 1,
            binding: { kind: 'template', template: 'Back of {{Name}}' },
          },
        ]),
        templatePdf: await createTemplatePdf(pages),
        rows: [{ Name: 'Asha' }, { Name: 'Bala' }, { Name: 'Chitra' }],
        options: { mode: 'merged' },
      });
      const pdf = merged.documents[0]!.bytes;
      const texts = [1, 2, 3, 4, 5, 6].map((pageNumber) => extractText(pdf, pageNumber).trim());
      expect(texts).toEqual([
        'Asha',
        'Back of Asha',
        'Bala',
        'Back of Bala',
        'Chitra',
        'Back of Chitra',
      ]);
      expect(merged.documents[0]!.fileName).toBe('Documents.pdf');
    },
  );

  it('merged: splits into several files when asked', async () => {
    const run = await runEngine({
      template: createTemplate([GREY_PAGE], [NAME]),
      templatePdf: await createTemplatePdf([GREY_PAGE]),
      rows: Array.from({ length: 7 }, (_, index) => ({ Name: `Student ${index + 1}` })),
      options: { mode: 'merged', mergedFileName: 'Batch', rowsPerFile: 3 },
    });
    expect(run.documents.map((document) => [document.fileName, document.rowIndexes])).toEqual([
      ['Batch (1-3).pdf', [0, 1, 2]],
      ['Batch (4-6).pdf', [3, 4, 5]],
      ['Batch (7-7).pdf', [6]],
    ]);
    expect(run.result.documentCount).toBe(3);
  });

  it('merged: a template page without any content still produces a page', async () => {
    const pages = [GREY_PAGE, BLANK];
    const run = await runEngine({
      template: createTemplate(pages, [{ ...NAME, pageIndex: 1 }]),
      templatePdf: await createTemplatePdf(pages),
      rows: [{ Name: 'Asha' }, { Name: 'Bala' }],
      options: { mode: 'merged' },
    });
    expect(run.result.failedRows).toBe(0);
    expect(run.documents[0]!.pageCount).toBe(4);
  });

  it('produces nothing for an empty list of rows', async () => {
    for (const mode of ['separate', 'merged'] as const) {
      const run = await runEngine({
        template: createTemplate([GREY_PAGE], [NAME]),
        templatePdf: await createTemplatePdf([GREY_PAGE]),
        rows: [],
        options: { mode },
      });
      expect(run.documents).toEqual([]);
      expect(run.result).toMatchObject({ totalRows: 0, documentCount: 0, cancelled: false });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────

describe('rows that cannot be produced', () => {
  const placeholders: Placeholder[] = [
    textBox({
      id: 'name',
      label: 'Student name',
      box: { x: 20, y: 20, width: 300, height: 30 },
      required: true,
    }),
    image({
      id: 'photo',
      label: 'Photo',
      box: { x: 20, y: 80, width: 60, height: 60 },
      required: true,
    }),
  ];
  const rows = [
    { Name: 'Asha', Photo: photo('portrait.jpg') },
    { Name: '', Photo: photo('portrait.jpg') },
    { Name: 'Chitra', Photo: photo('missing.jpg') },
    { Name: 'Dev', Photo: photo('landscape.jpg') },
  ];

  it.each(['separate', 'merged'] as const)(
    '%s: skips the row, explains why, and carries on',
    async (mode) => {
      const run = await runEngine({
        template: createTemplate([GREY_PAGE], placeholders),
        templatePdf: await createTemplatePdf([GREY_PAGE]),
        rows,
        options: { mode },
      });

      expect(run.result).toMatchObject({
        totalRows: 4,
        succeededRows: 2,
        failedRows: 2,
        cancelled: false,
      });
      expect(run.result.problemRows).toEqual([
        {
          rowIndex: 1,
          status: 'failed',
          warnings: [],
          failure: {
            code: 'REQUIRED_VALUE_MISSING',
            placeholderId: 'name',
            message: '"Student name" is required but empty.',
          },
        },
        {
          rowIndex: 2,
          status: 'failed',
          warnings: [],
          failure: {
            code: 'REQUIRED_VALUE_MISSING',
            placeholderId: 'photo',
            message: '"Photo": The image host answered with HTTP 404.',
          },
        },
      ]);
      // Progress is reported for every row, failed or not.
      expect(
        run.progress.map((update) => [update.completedRows, update.failedRows, update.row.status]),
      ).toEqual([
        [1, 0, 'ok'],
        [2, 1, 'failed'],
        [3, 2, 'failed'],
        [4, 2, 'ok'],
      ]);

      if (mode === 'separate') {
        expect(run.documents.map((document) => document.rowIndexes)).toEqual([[0], [3]]);
      } else {
        // The failed rows left no pages behind.
        expect(run.documents).toHaveLength(1);
        expect(run.documents[0]!.rowIndexes).toEqual([0, 3]);
        expect(run.documents[0]!.pageCount).toBe(2);
      }
    },
  );

  it('never downloads photos for a row that is already known to fail', async () => {
    const run = await runEngine({
      template: createTemplate([GREY_PAGE], placeholders),
      templatePdf: await createTemplatePdf([GREY_PAGE]),
      rows: [{ Name: '', Photo: photo('exif-2.jpg') }],
    });
    expect(run.result.failedRows).toBe(1);
    expect(run.loader.requests).toEqual([]);
  });

  it('can stop at the first failure instead', async () => {
    const run = runEngine({
      template: createTemplate([GREY_PAGE], placeholders),
      templatePdf: await createTemplatePdf([GREY_PAGE]),
      rows,
      options: { stopOnRowFailure: true },
    });
    await expect(run).rejects.toMatchObject({
      code: 'ROW_FAILED',
      message: 'Row 2: "Student name" is required but empty.',
    });
  });
});

describe('warnings', () => {
  it('reports characters the font cannot show, and still produces the document', async () => {
    const { result, documents } = await generateOne(
      [textBox({ id: 'name', box: { x: 20, y: 20, width: 300, height: 30 } })],
      { Name: 'Asha आशा ₹500' },
    );
    expect(documents).toHaveLength(1);
    expect(result.problemRows[0]!.warnings).toEqual([
      {
        code: 'UNSUPPORTED_CHARACTERS',
        placeholderId: 'name',
        message: 'The font "Helvetica" cannot show these characters: आ श ा ₹',
      },
    ]);
  });

  it('reports right-to-left text', async () => {
    const run = await runEngine({
      template: createTemplate(
        [BLANK],
        [
          textBox({
            id: 'name',
            box: { x: 20, y: 20, width: 300, height: 30 },
            style: {
              fontId: 'devanagari',
              fontSize: 16,
              color: '#000000',
              align: 'left',
              verticalAlign: 'top',
              lineHeight: 1.2,
            },
          }),
        ],
        [libraryFont('devanagari')],
      ),
      templatePdf: await createTemplatePdf([BLANK]),
      rows: [{ Name: 'اردو' }],
      fonts: { devanagari: notoFont('devanagari') },
    });
    expect(run.result.problemRows[0]!.warnings.map((warning) => warning.code)).toEqual([
      'UNSUPPORTED_CHARACTERS',
      'RIGHT_TO_LEFT_TEXT',
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────

describe('image loading during a job', () => {
  const placeholders: Placeholder[] = [
    image({
      id: 'logo',
      box: { x: 20, y: 20, width: 60, height: 40 },
      binding: { kind: 'static', value: photo('logo.png') },
    }),
    image({ id: 'photo', box: { x: 100, y: 20, width: 60, height: 60 } }),
  ];
  const photos = ['portrait.jpg', 'landscape.jpg', 'exif-3.jpg', 'exif-6.jpg', 'portrait.png'];
  const rows = Array.from({ length: 30 }, (_, index) => ({
    Name: `Student ${index}`,
    Photo: photo(photos[index % photos.length]!),
  }));

  it.each(['separate', 'merged'] as const)(
    '%s: downloads each distinct image once',
    async (mode) => {
      const run = await runEngine({
        template: createTemplate([GREY_PAGE], placeholders),
        templatePdf: await createTemplatePdf([GREY_PAGE]),
        rows,
        options: { mode },
      });
      expect(run.result.failedRows).toBe(0);
      expect([...run.loader.requests].sort()).toEqual(['logo.png', ...photos].map(photo).sort());
    },
  );

  it('merged: embeds a shared image once, not once per row', async () => {
    const template = createTemplate([GREY_PAGE], [placeholders[0]!]);
    const templatePdf = await createTemplatePdf([GREY_PAGE]);
    const one = await runEngine({
      template,
      templatePdf,
      rows: rows.slice(0, 1),
      options: { mode: 'merged' },
    });
    const thirty = await runEngine({ template, templatePdf, rows, options: { mode: 'merged' } });
    const logoBytes = fixtureImage('logo.png').byteLength;
    expect(thirty.documents[0]!.bytes.byteLength - one.documents[0]!.bytes.byteLength).toBeLessThan(
      logoBytes * 10,
    );
  });

  it('respects the download concurrency limit while prefetching ahead', async () => {
    const loader = createFixtureLoader({ delayMs: 3 });
    // A distinct link per row, so nothing is served from the cache.
    const unique = Array.from({ length: 24 }, (_, index) => ({
      Name: `Student ${index}`,
      Photo: `${photo('portrait.jpg')}?student=${index}`,
    }));

    const run = await runEngine({
      template: createTemplate([GREY_PAGE], [placeholders[1]!]),
      templatePdf: await createTemplatePdf([GREY_PAGE]),
      rows: unique,
      loader,
      options: { imageConcurrency: 3 },
    });
    expect(run.result.failedRows).toBe(0);
    expect(loader.peakConcurrency()).toBeLessThanOrEqual(3);
    // More than one at a time: later rows' photos were already on their way.
    expect(loader.peakConcurrency()).toBeGreaterThan(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────

describe('stopping and delivery', () => {
  const NAME = textBox({ id: 'name', box: { x: 20, y: 20, width: 300, height: 30 } });
  const rows = Array.from({ length: 12 }, (_, index) => ({ Name: `Student ${index + 1}` }));

  it.each(['separate', 'merged'] as const)('%s: stops when the job is cancelled', async (mode) => {
    const controller = new AbortController();
    const template = createTemplate([GREY_PAGE], [NAME]);
    const templatePdf = await createTemplatePdf([GREY_PAGE]);
    const delivered: number[][] = [];

    const result = await generateDocuments(
      {
        template,
        assets: { templatePdf, fonts: {} },
        rows,
        options: { mode, rowsPerFile: 2, signal: controller.signal },
      },
      createFixtureLoader().dependencies,
      {
        onDocument: (document) => void delivered.push(document.rowIndexes),
        onProgress: (progress) => {
          if (progress.completedRows === 5) controller.abort();
        },
      },
    );

    expect(result.cancelled).toBe(true);
    expect(result.succeededRows).toBe(5);
    // Nothing after the cancellation point was delivered.
    expect(delivered.flat().every((rowIndex) => rowIndex < 5)).toBe(true);
    expect(delivered.length).toBe(mode === 'separate' ? 5 : 2);
  });

  it('does nothing at all when cancelled before it starts', async () => {
    const run = await runEngine({
      template: createTemplate([GREY_PAGE], [NAME]),
      templatePdf: await createTemplatePdf([GREY_PAGE]),
      rows,
      options: { signal: AbortSignal.abort() },
    });
    expect(run.documents).toEqual([]);
    expect(run.result).toMatchObject({ cancelled: true, succeededRows: 0 });
  });

  it('waits for each file to be taken before producing the next', async () => {
    const template = createTemplate([GREY_PAGE], [NAME]);
    const templatePdf = await createTemplatePdf([GREY_PAGE]);
    const events: string[] = [];

    await generateDocuments(
      {
        template,
        assets: { templatePdf, fonts: {} },
        rows: rows.slice(0, 3),
        options: { mode: 'separate' },
      },
      createFixtureLoader().dependencies,
      {
        async onDocument(document) {
          events.push(`start ${document.rowIndexes[0]}`);
          await new Promise((resolve) => setTimeout(resolve, 15));
          events.push(`end ${document.rowIndexes[0]}`);
        },
      },
    );
    expect(events).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('stops and rethrows when a file cannot be delivered', async () => {
    const template = createTemplate([GREY_PAGE], [NAME]);
    const templatePdf = await createTemplatePdf([GREY_PAGE]);
    const uploadFailed = new Error('Drive quota exceeded');
    let attempts = 0;

    const run = generateDocuments(
      { template, assets: { templatePdf, fonts: {} }, rows, options: { mode: 'separate' } },
      createFixtureLoader().dependencies,
      {
        onDocument() {
          attempts++;
          if (attempts === 2) throw uploadFailed;
        },
      },
    );
    await expect(run).rejects.toBe(uploadFailed);
    expect(attempts).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────

describe('jobs that cannot run', () => {
  const NAME = textBox({ id: 'name', box: { x: 20, y: 20, width: 300, height: 30 } });
  const run = async (overrides: {
    template?: ReturnType<typeof createTemplate>;
    templatePdf?: Uint8Array;
    fonts?: Record<string, Uint8Array>;
  }) =>
    runEngine({
      template: overrides.template ?? createTemplate([GREY_PAGE], [NAME]),
      templatePdf: overrides.templatePdf ?? (await createTemplatePdf([GREY_PAGE])),
      rows: [{ Name: 'Asha' }],
      fonts: overrides.fonts,
    }).then(
      () => null,
      (error: unknown) => error as EngineError,
    );

  it('rejects an invalid template and lists what is wrong with it', async () => {
    const template = createTemplate(
      [GREY_PAGE],
      [
        { ...NAME, pageIndex: 3 },
        { ...NAME, id: 'other', style: { ...NAME.style, fontId: 'missing' } },
      ],
    );
    const error = await run({ template });
    expect(error).toBeInstanceOf(EngineError);
    expect(error!.code).toBe('INVALID_TEMPLATE');
    expect(error!.details).toEqual([
      'placeholders.0.pageIndex: Page 4 does not exist — the template has 1 page(s)',
      'placeholders.1.style.fontId: Unknown font "missing" — add it to the template\'s fonts',
    ]);
  });

  it('rejects a file that is not a PDF', async () => {
    const error = await run({
      templatePdf: new TextEncoder().encode('This is a Word document, honest.'),
    });
    expect(error!.code).toBe('TEMPLATE_PDF_UNREADABLE');
  });

  it('rejects a password-protected PDF with a message the user can act on', async () => {
    const plain = await (
      await PDFDocument.load(await createTemplatePdf([GREY_PAGE]))
    ).save({ useObjectStreams: false });
    // Mark the file as encrypted the way a protected PDF does: an /Encrypt entry in its trailer.
    const text = Buffer.from(plain).toString('latin1');
    const trailer = text.lastIndexOf('trailer');
    const marked = `${text.slice(0, trailer)}${text.slice(trailer).replace('<<', '<<\n/Encrypt 1 0 R')}`;
    const error = await run({ templatePdf: new Uint8Array(Buffer.from(marked, 'latin1')) });
    expect(error!.code).toBe('TEMPLATE_PDF_ENCRYPTED');
    expect(error!.message).toContain('password');
  });

  it('rejects a PDF that does not match the template it is used with', async () => {
    const twoPages = await createTemplatePdf([GREY_PAGE, GREY_PAGE]);
    const pageCount = await run({ templatePdf: twoPages });
    expect(pageCount!.code).toBe('TEMPLATE_PDF_MISMATCH');
    expect(pageCount!.message).toBe('The template was set up for 1 page(s) but the PDF has 2.');

    const otherSize = await run({
      templatePdf: await createTemplatePdf([{ width: 595, height: 842 }]),
    });
    expect(otherSize!.code).toBe('TEMPLATE_PDF_MISMATCH');
  });

  it('rejects a job whose font file is missing', async () => {
    const template = createTemplate([GREY_PAGE], [NAME], [HELVETICA, libraryFont('devanagari')]);
    const error = await run({ template });
    expect(error!.code).toBe('FONT_NOT_PROVIDED');
  });
});
