/**
 * A whole-engine smoke test that doubles as a picture book.
 *
 * It builds a two-page document exercising every feature at once and saves what a PDF viewer
 * shows to `tests/output/showcase-*.png`. The assertions are deliberately coarse — precise
 * behaviour is pinned down in `src/lib/pdf-engine/*.test.ts` — but the images are what a person
 * (or a coding agent) should look at after changing anything about rendering.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Placeholder } from '@/lib/template';

import {
  createTemplate,
  createTemplatePdf,
  HELVETICA,
  libraryFont,
  notoFont,
  runEngine,
  textBox,
  type TemplatePageSpec,
} from './support/engine-fixtures';
import { HAS_POPPLER, renderPage } from './support/poppler';

const PAGES: TemplatePageSpec[] = [
  { width: 595, height: 842 }, // A4 portrait
  { width: 595, height: 842, rotate: 90 }, // stored portrait, displayed landscape
];

const PLACEHOLDERS: Placeholder[] = [
  // ── Page 1 ──
  textBox({
    id: 'title',
    box: { x: 60, y: 50, width: 475, height: 50 },
    binding: { kind: 'static', value: 'Certificate of Merit — AVATAR Today' },
    style: {
      fontId: 'helvetica',
      fontSize: 30,
      color: '#1A2B6D',
      align: 'center',
      verticalAlign: 'middle',
      lineHeight: 1.2,
    },
    fit: { wrap: false, shrinkToFit: true, minFontSize: 10, overflow: 'ellipsis' },
  }),
  textBox({
    id: 'name',
    box: { x: 100, y: 120, width: 395, height: 46 },
    style: {
      fontId: 'devanagari',
      fontSize: 34,
      color: '#000000',
      align: 'center',
      verticalAlign: 'middle',
      lineHeight: 1.2,
    },
    fit: { wrap: false, shrinkToFit: true, minFontSize: 10, overflow: 'ellipsis' },
  }),
  textBox({
    id: 'remarks',
    box: { x: 60, y: 190, width: 300, height: 110 },
    binding: { kind: 'column', column: 'Remarks' },
    style: {
      fontId: 'devanagari',
      fontSize: 16,
      color: '#333333',
      align: 'left',
      verticalAlign: 'top',
      lineHeight: 1.35,
    },
    fit: { wrap: true, shrinkToFit: true, minFontSize: 8, overflow: 'ellipsis' },
  }),
  {
    id: 'photo',
    type: 'image',
    label: 'Photo',
    pageIndex: 0,
    box: { x: 400, y: 190, width: 110, height: 140 },
    binding: { kind: 'column', column: 'Photo' },
    fit: 'cover',
    position: { x: 0.5, y: 0.3 },
    shape: { kind: 'rounded', radius: 12 },
    border: { width: 2, color: '#1A2B6D' },
  },
  textBox({
    id: 'bengali',
    box: { x: 60, y: 330, width: 300, height: 40 },
    binding: { kind: 'static', value: 'শ্রী কৃষ্ণ পশ্চিমবঙ্গ' },
    style: {
      fontId: 'bengali',
      fontSize: 26,
      color: '#000000',
      align: 'left',
      verticalAlign: 'middle',
      lineHeight: 1.2,
    },
  }),
  textBox({
    id: 'tamil',
    box: { x: 60, y: 380, width: 300, height: 40 },
    binding: { kind: 'static', value: 'தமிழ்நாடு பள்ளி ஸ்ரீ' },
    style: {
      fontId: 'tamil',
      fontSize: 26,
      color: '#000000',
      align: 'left',
      verticalAlign: 'middle',
      lineHeight: 1.2,
    },
  }),
  textBox({
    id: 'mixed',
    box: { x: 60, y: 430, width: 475, height: 40 },
    binding: { kind: 'template', template: 'Class {{Class}} कक्षा दसवीं — ₹ 1,25,000' },
    style: {
      fontId: 'devanagari',
      fontSize: 24,
      color: '#7A1F1F',
      align: 'left',
      verticalAlign: 'middle',
      lineHeight: 1.2,
    },
  }),
  {
    id: 'circle',
    type: 'image',
    label: 'Round photo',
    pageIndex: 0,
    box: { x: 60, y: 500, width: 120, height: 120 },
    binding: { kind: 'static', value: 'https://img.test/exif-6.jpg' },
    fit: 'cover',
    shape: { kind: 'ellipse' },
    border: { width: 3, color: '#C0392B' },
  },
  {
    id: 'contain',
    type: 'image',
    label: 'Contained',
    pageIndex: 0,
    box: { x: 210, y: 500, width: 120, height: 120 },
    binding: { kind: 'static', value: 'https://img.test/exif-8.jpg' },
    fit: 'contain',
    background: '#FFFFFF',
    border: { width: 1, color: '#888888' },
  },
  {
    id: 'logo',
    type: 'image',
    label: 'Logo',
    pageIndex: 0,
    box: { x: 360, y: 500, width: 150, height: 120 },
    binding: { kind: 'static', value: 'https://img.test/logo.png' },
    fit: 'contain',
    background: '#FFE9A8',
  },
  {
    id: 'qr',
    type: 'qr',
    label: 'Verify',
    pageIndex: 0,
    box: { x: 60, y: 660, width: 120, height: 120 },
    binding: { kind: 'template', template: 'https://verify.example.in/c/{{ID}}' },
    errorCorrection: 'M',
    foreground: '#000000',
    background: '#FFFFFF',
    quietZone: 4,
  },
  textBox({
    id: 'rotated',
    box: { x: 250, y: 690, width: 260, height: 40 },
    rotation: -12,
    opacity: 0.6,
    binding: { kind: 'static', value: 'Rotated, 60% opaque' },
    style: {
      fontId: 'helvetica',
      fontSize: 22,
      color: '#C0392B',
      align: 'center',
      verticalAlign: 'middle',
      lineHeight: 1.2,
    },
  }),
  // ── Page 2 (displayed landscape: 842 × 595) ──
  textBox({
    id: 'p2-title',
    pageIndex: 1,
    box: { x: 40, y: 40, width: 762, height: 50 },
    binding: { kind: 'template', template: 'Page 2 — {{Name}}' },
    style: {
      fontId: 'devanagari',
      fontSize: 28,
      color: '#1A2B6D',
      align: 'right',
      verticalAlign: 'middle',
      lineHeight: 1.2,
    },
    fit: { wrap: false, shrinkToFit: true, minFontSize: 10, overflow: 'ellipsis' },
  }),
  {
    id: 'p2-photo',
    type: 'image',
    label: 'Landscape photo',
    pageIndex: 1,
    box: { x: 40, y: 120, width: 300, height: 200 },
    binding: { kind: 'static', value: 'https://img.test/landscape.jpg' },
    fit: 'cover',
  },
];

const ROWS = [
  {
    Name: 'प्रियंका त्रिपाठी',
    Class: '10',
    ID: 'CERT-2026-0001',
    Photo: 'https://img.test/portrait.jpg',
    Remarks:
      'विद्यार्थी ने पूरे वर्ष उत्कृष्ट प्रदर्शन किया। Excellent in Mathematics and Science.',
  },
  {
    Name: 'Venkata Subramanian Ramachandran Iyengar Krishnamurthy',
    Class: '9',
    ID: 'CERT-2026-0002',
    Photo: 'https://img.test/exif-3.jpg',
    Remarks:
      'A very long remark that has to wrap across several lines and then shrink until the whole paragraph fits inside its box, however much the class teacher decided to write about this particular student this year.',
  },
];

describe.skipIf(!HAS_POPPLER)('showcase', () => {
  const fonts = [
    HELVETICA,
    libraryFont('devanagari'),
    libraryFont('bengali'),
    libraryFont('tamil'),
  ];
  const fontFiles = {
    devanagari: notoFont('devanagari'),
    bengali: notoFont('bengali'),
    tamil: notoFont('tamil'),
  };

  it('renders every feature in separate and merged output', async () => {
    const templatePdf = await createTemplatePdf(PAGES);
    const template = createTemplate(PAGES, PLACEHOLDERS, fonts);
    const outputDirectory = join(process.cwd(), 'tests', 'output');
    mkdirSync(outputDirectory, { recursive: true });

    const separate = await runEngine({ template, templatePdf, rows: ROWS, fonts: fontFiles });
    expect(separate.result.failedRows).toBe(0);
    expect(separate.result.problemRows).toEqual([]);
    expect(separate.documents).toHaveLength(2);

    separate.documents.forEach((document, index) => {
      writeFileSync(join(outputDirectory, `showcase-row${index + 1}.pdf`), document.bytes);
      expect(renderPage(document.bytes, 1, { name: `showcase-row${index + 1}-page1` }).width).toBe(
        595,
      );
      expect(renderPage(document.bytes, 2, { name: `showcase-row${index + 1}-page2` }).width).toBe(
        842,
      );
    });

    const merged = await runEngine({
      template,
      templatePdf,
      rows: ROWS,
      fonts: fontFiles,
      options: { mode: 'merged', mergedFileName: 'Showcase' },
    });
    expect(merged.result.failedRows).toBe(0);
    expect(merged.documents.map((document) => [document.fileName, document.pageCount])).toEqual([
      ['Showcase.pdf', 4],
    ]);
    const [file] = merged.documents;
    writeFileSync(join(outputDirectory, 'showcase-merged.pdf'), file!.bytes);
    expect(renderPage(file!.bytes, 1, { name: 'showcase-merged-page1' }).width).toBe(595);
    expect(renderPage(file!.bytes, 4, { name: 'showcase-merged-page4' }).width).toBe(842);
  });
});
