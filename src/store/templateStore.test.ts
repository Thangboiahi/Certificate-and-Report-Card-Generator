import { beforeEach, describe, expect, it } from 'vitest';

import { boxToPercent } from '@/lib/editor/coordinates';
import type { TextPlaceholder } from '@/lib/template';
import { HAS_POPPLER, extractWords } from '../../tests/support/poppler';
import {
  createTemplate,
  createTemplatePdf,
  runEngine,
  textBox,
  type TemplatePageSpec,
} from '../../tests/support/engine-fixtures';

import { selectSelectedPlaceholder, useTemplateStore } from './templateStore';

const PAGES: TemplatePageSpec[] = [
  { width: 842, height: 595 },
  // Stored portrait, displayed landscape: the editor must not care.
  { width: 595, height: 842, rotate: 90 },
];

function template() {
  return createTemplate(PAGES, [
    textBox({ id: 'name', box: { x: 100, y: 100, width: 300, height: 40 } }),
    textBox({
      id: 'rotated-page',
      pageIndex: 1,
      box: { x: 50, y: 60, width: 200, height: 30 },
      fit: { wrap: false, shrinkToFit: true, minFontSize: 12, overflow: 'visible' },
    }),
    {
      id: 'qr',
      type: 'qr',
      label: 'QR',
      pageIndex: 0,
      box: { x: 700, y: 450, width: 100, height: 100 },
      binding: { kind: 'static', value: 'x' },
      errorCorrection: 'M',
      foreground: '#000000',
      quietZone: 4,
    },
  ]);
}

const store = () => useTemplateStore.getState();
const placeholder = (id: string) =>
  store().activeTemplate!.placeholders.find((entry) => entry.id === id)!;

describe('templateStore', () => {
  beforeEach(() => {
    store().reset();
    store().loadTemplate(template(), [{ Name: 'Asha' }]);
  });

  it('loads a template with no selection and keeps rows', () => {
    expect(store().selectedPlaceholderId).toBeNull();
    expect(store().dataRows).toEqual([{ Name: 'Asha' }]);
  });

  it('selects existing placeholders only', () => {
    store().selectPlaceholder('name');
    expect(selectSelectedPlaceholder(store())?.id).toBe('name');
    store().selectPlaceholder('missing');
    expect(store().selectedPlaceholderId).toBe('name');
    store().selectPlaceholder(null);
    expect(selectSelectedPlaceholder(store())).toBeNull();
  });

  it('stores percent coordinates as points of the placeholder’s own page', () => {
    store().updatePlaceholderCoords('name', 50, 25);
    expect(placeholder('name').box).toEqual({ x: 421, y: 148.75, width: 300, height: 40 });
    // Page 2 is displayed 842 × 595 although stored 595 × 842.
    store().updatePlaceholderCoords('rotated-page', 10, 10);
    expect(placeholder('rotated-page').box).toMatchObject({ x: 84.2, y: 59.5 });
  });

  it('clamps moves to the page', () => {
    store().updatePlaceholderCoords('name', 120, -3);
    expect(placeholder('name').box).toMatchObject({ x: 542, y: 0 });
    store().nudgePlaceholder('qr', 500, 500);
    expect(placeholder('qr').box).toMatchObject({ x: 742, y: 495 });
  });

  it('nudges in points', () => {
    store().nudgePlaceholder('name', 1, 0);
    store().nudgePlaceholder('name', 0, -10);
    expect(placeholder('name').box).toMatchObject({ x: 101, y: 90 });
  });

  it('only replaces the edited placeholder and skips no-op updates', () => {
    const before = store().activeTemplate!;
    store().nudgePlaceholder('name', 1, 0);
    const after = store().activeTemplate!;
    expect(after).not.toBe(before);
    expect(after.placeholders[1]).toBe(before.placeholders[1]);
    expect(after.placeholders[2]).toBe(before.placeholders[2]);
    store().nudgePlaceholder('name', 0, 0);
    expect(store().activeTemplate).toBe(after);
    store().nudgePlaceholder('unknown', 5, 5);
    expect(store().activeTemplate).toBe(after);
  });

  it('sets text font sizes within limits and keeps minFontSize ≤ fontSize', () => {
    store().setFontSize('name', 30);
    expect((placeholder('name') as TextPlaceholder).style.fontSize).toBe(30);
    store().setFontSize('rotated-page', 8);
    const rotated = placeholder('rotated-page') as TextPlaceholder;
    expect(rotated.style.fontSize).toBe(8);
    expect(rotated.fit.minFontSize).toBe(8);
    store().setFontSize('name', 0);
    expect((placeholder('name') as TextPlaceholder).style.fontSize).toBe(4);
    const qrBefore = placeholder('qr');
    store().setFontSize('qr', 20);
    expect(placeholder('qr')).toBe(qrBefore);
  });

  it.skipIf(!HAS_POPPLER)(
    'what the editor places is where the engine prints, on plain and rotated pages',
    async () => {
      // Drag-like edits in percent, plus a nudge, as the canvas would send them.
      const page = template().pages[0]!;
      const target = boxToPercent({ x: 210.5, y: 333.25, width: 300, height: 40 }, page);
      store().updatePlaceholderCoords('name', target.left, target.top);
      store().nudgePlaceholder('name', 10, 0);
      store().updatePlaceholderCoords('rotated-page', 40, 50);
      const edited = store().activeTemplate!;
      expect(placeholder('name').box).toMatchObject({ x: 220.5, y: 333.25 });

      const { documents } = await runEngine({
        template: edited,
        templatePdf: await createTemplatePdf(PAGES),
        rows: [{ Name: 'Asha' }],
      });
      const pdf = documents[0]!.bytes;
      // Left-aligned, top-aligned text starts at the box's left edge, just below its top edge.
      const [first] = extractWords(pdf, 1).filter((word) => word.text === 'Asha');
      expect(first!.xMin).toBeCloseTo(220.5, 0);
      expect(first!.yMin).toBeGreaterThanOrEqual(333.25 - 0.5);
      expect(first!.yMin).toBeLessThan(333.25 + 6);

      const rotatedBox = placeholder('rotated-page').box;
      expect(rotatedBox).toMatchObject({ x: 336.8, y: 297.5 });
      const [second] = extractWords(pdf, 2).filter((word) => word.text === 'Asha');
      expect(second!.xMin).toBeCloseTo(rotatedBox.x, 0);
      expect(second!.yMin).toBeGreaterThanOrEqual(rotatedBox.y - 0.5);
      expect(second!.yMin).toBeLessThan(rotatedBox.y + 6);
    },
  );
});
