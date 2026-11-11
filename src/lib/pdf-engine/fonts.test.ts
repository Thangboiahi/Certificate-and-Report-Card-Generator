/**
 * These tests pin down the assumptions the engine makes about pdf-lib and fontkit (both pinned to
 * exact versions — docs/DECISIONS.md, ADR-006 to ADR-008). If one fails after a dependency
 * change, the engine's text rendering is at risk: read the ADRs before "fixing" the test.
 */
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { HELVETICA, libraryFont, notoFont } from '../../../tests/support/engine-fixtures';
import { EngineError } from './errors';
import { FontRegistry, type FontFace, type ShapedGlyph } from './fonts';

const DEVANAGARI = notoFont('devanagari');
const BENGALI = notoFont('bengali');
const TAMIL = notoFont('tamil');

async function faces() {
  const registry = await FontRegistry.create(
    [HELVETICA, libraryFont('devanagari'), libraryFont('bengali'), libraryFont('tamil')],
    { devanagari: DEVANAGARI, bengali: BENGALI, tamil: TAMIL },
  );
  return {
    helvetica: registry.get('helvetica'),
    devanagari: registry.get('devanagari'),
    bengali: registry.get('bengali'),
    tamil: registry.get('tamil'),
  };
}

const glyphsOf = (face: FontFace, word: string): ShapedGlyph[] =>
  face.shapeWord(word).runs.flatMap((run) => run.glyphs);

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

describe('FontRegistry', () => {
  it('rejects a template font whose file was not supplied', async () => {
    await expect(FontRegistry.create([libraryFont('devanagari')], {})).rejects.toMatchObject({
      code: 'FONT_NOT_PROVIDED',
    });
  });

  it('rejects bytes that are not a font', async () => {
    const garbage = new TextEncoder().encode('this is not a font file at all');
    const error = await FontRegistry.create([libraryFont('devanagari')], {
      devanagari: garbage,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe('FONT_INVALID');
  });

  it('accepts font bytes as an ArrayBuffer', async () => {
    const buffer = new ArrayBuffer(DEVANAGARI.byteLength);
    new Uint8Array(buffer).set(DEVANAGARI);
    const registry = await FontRegistry.create([libraryFont('devanagari')], { devanagari: buffer });
    expect(registry.get('devanagari').shapeWord('नमस्ते').width).toBeGreaterThan(0);
  });
});

describe('standard fonts', () => {
  it('have plausible vertical metrics', async () => {
    const { helvetica } = await faces();
    expect(helvetica.ascent).toBeCloseTo(0.718, 3);
    expect(helvetica.descent).toBeCloseTo(0.207, 3);
  });

  it('apply kerning, so that measuring and drawing agree', async () => {
    const { helvetica } = await faces();
    const [a, v] = glyphsOf(helvetica, 'AV');
    // "AV" is the classic kerning pair: the A's advance is pulled in.
    expect(a!.advance).toBeLessThan(a!.naturalAdvance);
    expect(v!.advance).toBe(v!.naturalAdvance);
    expect(helvetica.shapeWord('AV').width).toBeCloseTo(a!.advance + v!.advance, 9);
    // No kerning between letters that do not need it.
    const [h] = glyphsOf(helvetica, 'HH');
    expect(h!.advance).toBe(h!.naturalAdvance);
  });

  it('report characters they cannot draw and substitute "?"', async () => {
    const { helvetica } = await faces();
    expect(helvetica.unsupportedCharacters('Asha आशा ₹')).toEqual(['आ', 'श', 'ा', '₹']);
    expect(helvetica.unsupportedCharacters('Renée — “fine”')).toEqual([]);
    expect(helvetica.shapeWord('₹500').runs[0]!.text).toBe('?500');
  });

  it('draw a non-breaking space as a space', async () => {
    const { helvetica } = await faces();
    expect(helvetica.unsupportedCharacters('Dr.\u00A0Rao')).toEqual([]);
    // One word of seven glyphs (so it can never be split across lines) whose fourth glyph is
    // either the font's own non-breaking space or an ordinary space — never a "?".
    const glyphs = glyphsOf(helvetica, 'Dr.\u00A0Rao');
    expect(glyphs).toHaveLength(7);
    expect(glyphs[3]!.naturalAdvance).toBe(helvetica.space.glyphs[0]!.naturalAdvance);
    expect(glyphs[3]!.code).not.toBe(glyphsOf(helvetica, '?')[0]!.code);
  });
});

describe('embedded fonts: shaping', () => {
  it('forms Devanagari conjuncts', async () => {
    const { devanagari } = await faces();
    // क + क + ् + ष + ा is five characters but three glyphs: क, the क्ष conjunct, ा.
    expect(glyphsOf(devanagari, 'कक्षा')).toHaveLength(3);
  });

  it('shapes each script of a mixed word with its own rules', async () => {
    const { devanagari } = await faces();
    const word = devanagari.shapeWord('Classकक्षा');
    expect(word.runs.map((run) => run.text)).toEqual(['Class', 'कक्षा']);
    // Shaped as one Latin string, fontkit would leave the conjunct unformed (5 glyphs).
    expect(word.runs[1]!.glyphs).toHaveLength(3);
  });

  it('keeps the shaper’s mark positions (Bengali ra-phala sits under its consonant)', async () => {
    const { bengali } = await faces();
    const glyphs = glyphsOf(bengali, 'শ্রী');
    const mark = glyphs.find((glyph) => glyph.xOffset !== 0);
    expect(mark).toBeDefined();
    // Drawn far to the left of the pen, i.e. back underneath the preceding letter.
    expect(mark!.xOffset).toBeLessThan(-0.5);
    expect(mark!.advance).toBe(0);
  });

  it('applies Latin kerning from the font', async () => {
    const { devanagari } = await faces();
    const glyphs = glyphsOf(devanagari, 'AVATAR');
    const kerned = glyphs.filter((glyph) => glyph.advance < glyph.naturalAdvance);
    expect(kerned.length).toBeGreaterThanOrEqual(3);
    expect(devanagari.shapeWord('AVATAR').width).toBeLessThan(
      sum(glyphs.map((glyph) => glyph.naturalAdvance)),
    );
  });

  it('caches shaped words', async () => {
    const { tamil } = await faces();
    expect(tamil.shapeWord('தமிழ்நாடு')).toBe(tamil.shapeWord('தமிழ்நாடு'));
  });

  it('flags right-to-left text', async () => {
    const { devanagari } = await faces();
    expect(devanagari.shapeWord('اردو').rightToLeft).toBe(true);
    expect(devanagari.shapeWord('हिंदी').rightToLeft).toBe(false);
  });

  it('reports characters the font has no glyph for, ignoring invisible joiners', async () => {
    const { tamil, devanagari } = await faces();
    expect(tamil.unsupportedCharacters('தமிழ் हिं')).toEqual(['ह', 'ि', 'ं']);
    expect(devanagari.unsupportedCharacters('क्\u200Dष \u200C ₹ Class')).toEqual([]);
  });

  it('shapes ordinary words in every bundled test font without degrading', async () => {
    const all = await faces();
    const samples: Array<[FontFace, string]> = [
      [all.devanagari, 'श्री कृष्ण द्वारा विद्यार्थी क्षत्रिय ज्ञानेश्वर हिन्दी'],
      [all.bengali, 'শ্রী কৃষ্ণ পশ্চিমবঙ্গ শিক্ষা পর্ষদ ক্ষুদ্র জ্ঞান'],
      [all.tamil, 'தமிழ்நாடு ஸ்ரீ கிருஷ்ணன் பள்ளிக்கூடம் மொழி'],
    ];
    for (const [face, text] of samples) {
      for (const word of text.split(' ')) {
        const shaped = face.shapeWord(word);
        expect(shaped.degraded, `${face.label}: ${word}`).toBe(false);
        expect(shaped.width, `${face.label}: ${word}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('embedded fonts: inside a document', () => {
  it('uses the fast glyph registration path with the pinned pdf-lib', async () => {
    const { devanagari } = await faces();
    const font = await devanagari.embedInto(await PDFDocument.create());
    // If this fails, pdf-lib's internals changed: the engine still works through the slower
    // public API, but ADR-008 needs revisiting.
    expect(font.encoding).toBe('direct');
  });

  it('produces exactly the codes pdf-lib itself would', async () => {
    const all = await faces();
    const cases: Array<[FontFace, string]> = [
      [all.devanagari, 'प्रियंका'],
      [all.devanagari, 'Certificate'],
      [all.bengali, 'পশ্চিমবঙ্গ'],
      [all.tamil, 'கிருஷ்ணன்'],
    ];
    for (const [face, word] of cases) {
      // Two fresh documents so neither encoder sees the other's glyph numbering.
      const ours = await face.embedInto(await PDFDocument.create());
      const reference = await face.embedInto(await PDFDocument.create());
      const [run] = face.shapeWord(word).runs;
      expect(ours.encode(run!).join(''), word).toBe(reference.pdfFont.encodeText(word).asString());
    }
  });

  it('shares one parsed font between documents', async () => {
    const { devanagari } = await faces();
    const first = await devanagari.embedInto(await PDFDocument.create());
    const second = await devanagari.embedInto(await PDFDocument.create());
    const parsed = (font: typeof first) =>
      (font.pdfFont as unknown as { embedder: { font: object; subset: object } }).embedder;
    expect(parsed(first).font).toBe(parsed(second).font);
    // …while each document keeps its own subset of glyphs.
    expect(parsed(first).subset).not.toBe(parsed(second).subset);
  });

  it('numbers glyphs independently per document', async () => {
    const { devanagari } = await faces();
    const first = await devanagari.embedInto(await PDFDocument.create());
    const second = await devanagari.embedInto(await PDFDocument.create());
    const [ka] = devanagari.shapeWord('क').runs;
    const [kha] = devanagari.shapeWord('ख').runs;

    expect(first.encode(ka!)).toEqual(['0001']);
    expect(first.encode(kha!)).toEqual(['0002']);
    // In the second document the same glyphs are met in the opposite order.
    expect(second.encode(kha!)).toEqual(['0001']);
    expect(second.encode(ka!)).toEqual(['0002']);
    expect(first.encode(ka!)).toEqual(['0001']);
  });

  it('falls back to pdf-lib’s public API when its internals are not as expected', async () => {
    const { bengali } = await faces();
    const document = await PDFDocument.create();

    // Make the embedder look unfamiliar without breaking it: pdf-lib only calls get/set here.
    const embedFont = document.embedFont.bind(document);
    document.embedFont = async (...args: Parameters<typeof embedFont>) => {
      const font = await embedFont(...args);
      const embedder = (
        font as unknown as { embedder: { glyphIdMap: Map<number, number> | object } }
      ).embedder;
      const map = embedder.glyphIdMap as Map<number, number>;
      embedder.glyphIdMap = { get: map.get.bind(map), set: map.set.bind(map) };
      return font;
    };

    const fallback = await bengali.embedInto(document);
    const direct = await bengali.embedInto(await PDFDocument.create());
    expect(fallback.encoding).toBe('reshape');

    const [run] = bengali.shapeWord('শ্রী').runs;
    expect(fallback.encode(run!)).toEqual(direct.encode(run!));
  });

  it('saves a document whose text was registered through the fast path', async () => {
    const { devanagari } = await faces();
    const document = await PDFDocument.create();
    document.addPage([200, 100]);
    const font = await devanagari.embedInto(document);
    for (const word of ['प्रियंका', 'त्रिपाठी', 'Class', '10']) {
      for (const run of devanagari.shapeWord(word).runs) font.encode(run);
    }
    const bytes = await document.save();
    // A subset, not the whole 217 KB font.
    expect(bytes.byteLength).toBeLessThan(30_000);
  });
});
