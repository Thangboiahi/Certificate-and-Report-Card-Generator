/**
 * Fonts: measuring text, shaping it into positioned glyphs, and embedding it into documents.
 *
 * Two lifetimes matter here:
 *
 *   FontFace      — lives for a whole job. Knows the font's metrics and shapes words. Shaping is
 *                   the expensive part of text (script rules, ligatures, mark positioning), so
 *                   each distinct word is shaped once and cached.
 *   DocumentFont  — lives for one output PDF. Owns that document's copy of the font and turns
 *                   shaped glyphs into the character codes that document uses.
 *
 * Why not simply call pdf-lib's `drawText`? It ignores glyph positioning and guesses one script
 * per string, which breaks Indian scripts and drops kerning. Why not let every document parse the
 * font itself? It costs ~18 ms per document for an Indic font. Both are measured and explained in
 * docs/DECISIONS.md (ADR-007, ADR-008).
 */
// fontkit's Indic shaper was compiled to use this global and does not ship it. Must come first.
import 'regenerator-runtime/runtime';

import fontkit, { type Font as FontkitFont, type Glyph as FontkitGlyph } from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont } from 'pdf-lib';

import type { StandardFontName, TemplateFont } from '@/lib/template/types';

import { EngineError } from './errors';
import { isRightToLeft, splitScriptRuns } from './script-runs';

/** One glyph, positioned. All distances are in em (multiples of the font size). */
export interface ShapedGlyph {
  /** Embedded fonts: the font's glyph. Its code differs per document — see `DocumentFont.encode`. */
  glyph: FontkitGlyph | null;
  /** Standard fonts: the glyph's character code as hex, identical in every document. */
  code: string | null;
  /** How far the pen moves after this glyph. Includes kerning and shaping adjustments. */
  advance: number;
  /** How far a PDF viewer moves by itself after showing this glyph (the font's plain width). */
  naturalAdvance: number;
  /** Shift from the pen position at which the glyph is drawn (e.g. a vowel sign under a letter). */
  xOffset: number;
  yOffset: number;
}

/** A stretch of one script, shaped. `text` is kept for the slow encoding path. */
export interface ShapedRun {
  text: string;
  glyphs: ShapedGlyph[];
}

export interface ShapedWord {
  /** Total advance in em. */
  width: number;
  runs: ShapedRun[];
  /** True if the word contains a right-to-left script, which the engine cannot lay out yet. */
  rightToLeft: boolean;
  /** True if the shaper failed on this word and a simpler, less accurate method was used. */
  degraded: boolean;
}

/** A font as the layout and drawing code sees it, for the duration of a job. */
export interface FontFace {
  readonly id: string;
  readonly label: string;
  /** Height above the baseline, in em. */
  readonly ascent: number;
  /** Depth below the baseline, in em (positive). */
  readonly descent: number;
  /** The inter-word space, as a run that can be drawn and encoded like any other. */
  readonly space: ShapedRun;
  /** Shapes a word (text without breaking spaces). Cached. */
  shapeWord(word: string): ShapedWord;
  /** Distinct characters of `text` this font cannot draw. Empty when everything is covered. */
  unsupportedCharacters(text: string): string[];
  /** Adds the font to a document. Called at most once per document. */
  embedInto(document: PDFDocument): Promise<DocumentFont>;
}

/** A font inside one output document. */
export interface DocumentFont {
  readonly face: FontFace;
  readonly pdfFont: PDFFont;
  /** Hex character codes for the run's glyphs in this document, one entry per glyph. */
  encode(run: ShapedRun): string[];
  /** Which strategy `encode` uses — `direct` is the fast one. Exposed for tests. */
  readonly encoding: 'standard' | 'direct' | 'reshape';
}

/** Cap on cached shaped words per font. Reaching it clears the cache (cheap, and rare). */
const WORD_CACHE_LIMIT = 20_000;

abstract class CachingFace {
  private readonly words = new Map<string, ShapedWord>();

  shapeWord(word: string): ShapedWord {
    const cached = this.words.get(word);
    if (cached) return cached;
    if (this.words.size >= WORD_CACHE_LIMIT) this.words.clear();
    const shaped = this.shape(word);
    this.words.set(word, shaped);
    return shaped;
  }

  protected abstract shape(word: string): ShapedWord;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Standard (built-in) fonts
// ───────────────────────────────────────────────────────────────────────────────────────────────

const NO_BREAK_SPACE = ' ';
/** Drawn in place of a character the font cannot encode. */
const REPLACEMENT = '?';

/**
 * One of the 14 fonts every PDF viewer has built in. Metrics come from pdf-lib's bundled tables.
 * pdf-lib measures these fonts WITH kerning but draws them WITHOUT, so centred text ends up
 * slightly off; here kerning is part of the shaped positions, so measuring and drawing agree.
 */
class StandardFace extends CachingFace implements FontFace {
  readonly ascent: number;
  readonly descent: number;
  readonly space: ShapedRun;

  private readonly supported: Set<number>;
  private readonly widths = new Map<string, number>();
  private readonly kerning = new Map<string, number>();
  private readonly codes = new Map<string, string>();

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly name: StandardFontName,
    /** A font object used only to read metrics; it belongs to a scratch document. */
    private readonly metrics: PDFFont,
  ) {
    super();
    this.supported = new Set(metrics.getCharacterSet());
    this.ascent = metrics.heightAtSize(1, { descender: false });
    this.descent = metrics.heightAtSize(1) - this.ascent;
    this.space = { text: ' ', glyphs: [this.glyphFor(' ', undefined)] };
  }

  private widthOf(character: string): number {
    let width = this.widths.get(character);
    if (width === undefined) {
      width = this.metrics.widthOfTextAtSize(character, 1000) / 1000;
      this.widths.set(character, width);
    }
    return width;
  }

  private kerningBetween(left: string, right: string): number {
    const pair = left + right;
    let amount = this.kerning.get(pair);
    if (amount === undefined) {
      amount =
        this.metrics.widthOfTextAtSize(pair, 1000) / 1000 -
        this.widthOf(left) -
        this.widthOf(right);
      this.kerning.set(pair, amount);
    }
    return amount;
  }

  private glyphFor(character: string, next: string | undefined): ShapedGlyph {
    let code = this.codes.get(character);
    if (code === undefined) {
      code = this.metrics.encodeText(character).asString();
      this.codes.set(character, code);
    }
    const width = this.widthOf(character);
    return {
      glyph: null,
      code,
      advance: width + (next === undefined ? 0 : this.kerningBetween(character, next)),
      naturalAdvance: width,
      xOffset: 0,
      yOffset: 0,
    };
  }

  /** Maps a character to something this font can encode. */
  private encodable(character: string): string {
    if (this.supported.has(character.codePointAt(0) as number)) return character;
    return character === NO_BREAK_SPACE ? ' ' : REPLACEMENT;
  }

  protected shape(word: string): ShapedWord {
    const characters = Array.from(word, (character) => this.encodable(character));
    const glyphs = characters.map((character, index) =>
      this.glyphFor(character, characters[index + 1]),
    );
    return {
      width: glyphs.reduce((total, glyph) => total + glyph.advance, 0),
      runs: [{ text: characters.join(''), glyphs }],
      rightToLeft: false,
      degraded: false,
    };
  }

  unsupportedCharacters(text: string): string[] {
    const missing = new Set<string>();
    for (const character of text) {
      if (isLayoutWhitespace(character) || character === NO_BREAK_SPACE) continue;
      if (!this.supported.has(character.codePointAt(0) as number)) missing.add(character);
    }
    return [...missing];
  }

  async embedInto(document: PDFDocument): Promise<DocumentFont> {
    const pdfFont = await document.embedFont(this.name);
    return {
      face: this,
      pdfFont,
      encoding: 'standard',
      encode: (run) => run.glyphs.map((glyph) => glyph.code as string),
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Embedded (TrueType / OpenType) fonts
// ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Parsed fonts, keyed by the very byte array they were parsed from. Handing pdf-lib this cache as
 * its "fontkit" makes every document of a job reuse one parsed, warmed-up font instead of parsing
 * and re-decoding the shaping tables per document. Entries vanish with their byte arrays.
 */
const parsedFonts = new WeakMap<Uint8Array, FontkitFont>();

const sharedFontkit = {
  create(bytes: Uint8Array): FontkitFont {
    let font = parsedFonts.get(bytes);
    if (!font) {
      font = fontkit.create(bytes);
      parsedFonts.set(bytes, font);
    }
    return font;
  },
};

/**
 * The private state of pdf-lib's subsetting font embedder that `encodeText` maintains. Writing to
 * it directly lets a document reuse glyphs that were already shaped, instead of shaping the same
 * text again. pdf-lib is pinned to an exact version for this reason (ADR-006), and
 * `hasSubsetInternals` checks every member before use.
 */
interface SubsetEmbedderInternals {
  subset: { includeGlyph(glyph: FontkitGlyph | number): number };
  glyphs: FontkitGlyph[];
  glyphIdMap: Map<number, number>;
  glyphCache: { invalidate(): void };
}

function hasSubsetInternals(embedder: unknown): embedder is SubsetEmbedderInternals {
  if (typeof embedder !== 'object' || embedder === null) return false;
  const candidate = embedder as Partial<SubsetEmbedderInternals>;
  return (
    typeof candidate.subset?.includeGlyph === 'function' &&
    Array.isArray(candidate.glyphs) &&
    candidate.glyphIdMap instanceof Map &&
    typeof candidate.glyphCache?.invalidate === 'function'
  );
}

const hex4 = (value: number): string => value.toString(16).toUpperCase().padStart(4, '0');

/** Characters that exist to steer shaping and never have a visible glyph of their own. */
function isInvisibleFormatCharacter(codePoint: number): boolean {
  return (
    codePoint === 0x00ad || // soft hyphen
    (codePoint >= 0x200b && codePoint <= 0x200f) || // zero-width space/joiners, direction marks
    (codePoint >= 0x202a && codePoint <= 0x202e) || // direction embeddings
    (codePoint >= 0x2060 && codePoint <= 0x2064) || // word joiner, invisible operators
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || // variation selectors
    codePoint === 0xfeff // byte-order mark
  );
}

function isLayoutWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

// ── Hardening fontkit's shaper ───────────────────────────────────────────────────────────────────

/** The parts of fontkit's OpenType positioning (GPOS) processor that are patched below. */
interface GposProcessor {
  applyAnchor(
    markRecord: { markAnchor?: unknown } | null,
    baseAnchor: unknown,
    baseGlyphIndex: number,
  ): void;
  applyLookup(lookupType: number, table: unknown): boolean;
  [EMPTY_ANCHOR_SEEN]?: boolean;
}

interface LayoutEngineInternals {
  _layoutEngine?: { engine?: { GPOSProcessor?: GposProcessor | null } | null } | null;
}

const EMPTY_ANCHOR_SEEN = Symbol('emptyAnchorSeen');
const patchedProcessors = new WeakSet<object>();

/**
 * Stops fontkit crashing on empty mark anchors.
 *
 * OpenType lets a font leave an anchor empty, meaning "this mark does not attach to this base
 * here". fontkit 1.x dereferences it regardless and throws — with Noto Sans Telugu, Malayalam and
 * Gurmukhi that happens on everyday words such as Telugu "శ్రీ". This patch makes the processor do
 * what HarfBuzz does: treat that subtable as not applicable and move on to the next one.
 *
 * It reaches into fontkit's internals, so every step is checked and it silently does nothing if
 * fontkit's shape ever changes; `shapeRun` has its own fallbacks for that case.
 */
function tolerateEmptyAnchors(font: FontkitFont): void {
  const processor = (font as unknown as LayoutEngineInternals)._layoutEngine?.engine?.GPOSProcessor;
  if (!processor) return;
  const prototype = Object.getPrototypeOf(processor) as GposProcessor | null;
  if (
    !prototype ||
    patchedProcessors.has(prototype) ||
    typeof prototype.applyAnchor !== 'function' ||
    typeof prototype.applyLookup !== 'function'
  ) {
    return;
  }
  patchedProcessors.add(prototype);

  const applyAnchor = prototype.applyAnchor;
  const applyLookup = prototype.applyLookup;

  prototype.applyAnchor = function (this: GposProcessor, markRecord, baseAnchor, baseGlyphIndex) {
    if (!baseAnchor || !markRecord?.markAnchor) {
      this[EMPTY_ANCHOR_SEEN] = true;
      return;
    }
    applyAnchor.call(this, markRecord, baseAnchor, baseGlyphIndex);
  };

  prototype.applyLookup = function (this: GposProcessor, lookupType, table) {
    // Lookups nest (extension and contextual lookups call back in), so the flag is scoped.
    const outer = this[EMPTY_ANCHOR_SEEN];
    this[EMPTY_ANCHOR_SEEN] = false;
    try {
      const applied = applyLookup.call(this, lookupType, table);
      return this[EMPTY_ANCHOR_SEEN] ? false : applied;
    } finally {
      this[EMPTY_ANCHOR_SEEN] = outer;
    }
  };
}

/** Shapes text with substitutions (conjuncts, reordering) but without positioning. */
function layoutWithoutPositioning(
  font: FontkitFont,
  text: string,
): ReturnType<FontkitFont['layout']> | null {
  const engine = (font as unknown as LayoutEngineInternals)._layoutEngine?.engine;
  if (!engine || !('GPOSProcessor' in engine)) return null;
  const processor = engine.GPOSProcessor;
  engine.GPOSProcessor = null;
  try {
    return font.layout(text);
  } catch {
    return null;
  } finally {
    engine.GPOSProcessor = processor;
  }
}

class EmbeddedFace extends CachingFace implements FontFace {
  readonly ascent: number;
  readonly descent: number;
  readonly space: ShapedRun;

  private readonly unitsPerEm: number;

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly bytes: Uint8Array,
    private readonly font: FontkitFont,
  ) {
    super();
    tolerateEmptyAnchors(font);
    this.unitsPerEm = font.unitsPerEm || 1000;
    this.ascent = (font.ascent || font.bbox.maxY) / this.unitsPerEm;
    this.descent = Math.abs(font.descent || font.bbox.minY) / this.unitsPerEm;

    const spaceGlyph = font.glyphForCodePoint(0x20);
    const spaceWidth = spaceGlyph.advanceWidth / this.unitsPerEm;
    this.space = {
      text: ' ',
      glyphs: [
        {
          glyph: spaceGlyph,
          code: null,
          advance: spaceWidth,
          naturalAdvance: spaceWidth,
          xOffset: 0,
          yOffset: 0,
        },
      ],
    };
  }

  /**
   * Shapes one single-script run. If the shaper throws, falls back first to shaping without
   * positioning (what stock pdf-lib draws) and then to plain character-to-glyph mapping, so one
   * unusual font can never stop a batch. `degraded` reports that a fallback was used.
   */
  private shapeRun(text: string): { run: ShapedRun; degraded: boolean } {
    let glyphs: FontkitGlyph[];
    let positions: ReadonlyArray<
      { xAdvance: number; xOffset: number; yOffset: number } | undefined
    > = [];
    let degraded = false;

    try {
      // fontkit infers the script from the first letter — correct here because the run holds
      // letters of a single script.
      const layout = this.font.layout(text);
      glyphs = layout.glyphs;
      positions = layout.positions;
    } catch {
      degraded = true;
      const unpositioned = layoutWithoutPositioning(this.font, text);
      glyphs = unpositioned ? unpositioned.glyphs : this.font.glyphsForString(text);
      positions = unpositioned ? unpositioned.positions : [];
    }

    return {
      degraded,
      run: {
        text,
        glyphs: glyphs.map((glyph, index): ShapedGlyph => {
          const position = positions[index];
          return {
            glyph,
            code: null,
            advance: (position?.xAdvance ?? glyph.advanceWidth) / this.unitsPerEm,
            naturalAdvance: glyph.advanceWidth / this.unitsPerEm,
            xOffset: (position?.xOffset ?? 0) / this.unitsPerEm,
            yOffset: (position?.yOffset ?? 0) / this.unitsPerEm,
          };
        }),
      },
    };
  }

  protected shape(word: string): ShapedWord {
    const scriptRuns = splitScriptRuns(word);
    const shaped = scriptRuns.map((run) => this.shapeRun(run.text));
    const runs = shaped.map((entry) => entry.run);
    return {
      width: runs.reduce(
        (total, run) => total + run.glyphs.reduce((sum, glyph) => sum + glyph.advance, 0),
        0,
      ),
      runs,
      rightToLeft: scriptRuns.some((run) => isRightToLeft(run.script)),
      degraded: shaped.some((entry) => entry.degraded),
    };
  }

  unsupportedCharacters(text: string): string[] {
    const missing = new Set<string>();
    for (const character of text) {
      const codePoint = character.codePointAt(0) as number;
      if (isLayoutWhitespace(character) || isInvisibleFormatCharacter(codePoint)) continue;
      if (!this.font.hasGlyphForCodePoint(codePoint)) missing.add(character);
    }
    return [...missing];
  }

  async embedInto(document: PDFDocument): Promise<DocumentFont> {
    document.registerFontkit(sharedFontkit);
    // `subset: true` is not an optimisation here: without it, glyphs that only exist as the
    // result of shaping (conjuncts, half-forms) get no width entry and viewers space them wrongly.
    const pdfFont = await document.embedFont(this.bytes, { subset: true });
    const embedder = (pdfFont as unknown as { embedder?: unknown }).embedder;

    if (hasSubsetInternals(embedder)) {
      return {
        face: this,
        pdfFont,
        encoding: 'direct',
        encode: (run) => {
          const codes = run.glyphs.map(({ glyph }) => {
            const fontGlyph = glyph as FontkitGlyph;
            const subsetId = embedder.subset.includeGlyph(fontGlyph);
            if (subsetId > 0) {
              embedder.glyphs[subsetId - 1] = fontGlyph;
              embedder.glyphIdMap.set(fontGlyph.id, subsetId);
            }
            return hex4(subsetId);
          });
          embedder.glyphCache.invalidate();
          return codes;
        },
      };
    }

    // pdf-lib's internals are not what we expect (it was upgraded or swapped). Fall back to its
    // public API: correct, but it shapes every run a second time.
    return {
      face: this,
      pdfFont,
      encoding: 'reshape',
      encode: (run) => {
        const hex = pdfFont.encodeText(run.text).asString();
        if (hex.length !== run.glyphs.length * 4) {
          throw new EngineError(
            'INTERNAL',
            `Font "${this.label}" produced an inconsistent glyph count.`,
          );
        }
        return run.glyphs.map((_glyph, index) => hex.slice(index * 4, index * 4 + 4));
      },
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Registry
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** The fonts of one job, ready to measure and shape. */
export class FontRegistry {
  private constructor(private readonly faces: Map<string, FontFace>) {}

  /**
   * Prepares every font a template declares. `fontFiles` holds the bytes of the non-standard
   * fonts, keyed by `TemplateFont.id`.
   */
  static async create(
    fonts: readonly TemplateFont[],
    fontFiles: Readonly<Record<string, Uint8Array | ArrayBuffer>>,
  ): Promise<FontRegistry> {
    const faces = new Map<string, FontFace>();
    let scratch: PDFDocument | undefined;

    for (const font of fonts) {
      if (font.source.kind === 'standard') {
        scratch ??= await PDFDocument.create();
        const metrics = await scratch.embedFont(font.source.name);
        faces.set(font.id, new StandardFace(font.id, font.label, font.source.name, metrics));
        continue;
      }

      const file = fontFiles[font.id];
      if (!file) {
        throw new EngineError('FONT_NOT_PROVIDED', `The font "${font.label}" was not loaded.`);
      }
      const bytes = file instanceof Uint8Array ? file : new Uint8Array(file);

      let parsed: FontkitFont;
      try {
        parsed = sharedFontkit.create(bytes);
      } catch (cause) {
        throw new EngineError(
          'FONT_INVALID',
          `The font "${font.label}" is not a valid font file.`,
          {
            cause,
          },
        );
      }
      if (typeof parsed.layout !== 'function' || !parsed.unitsPerEm) {
        // fontkit returns a collection object for .ttc/.dfont files, which cannot be embedded.
        throw new EngineError(
          'FONT_INVALID',
          `The font "${font.label}" is a font collection. Upload a single .ttf or .otf file.`,
        );
      }
      faces.set(font.id, new EmbeddedFace(font.id, font.label, bytes, parsed));
    }

    return new FontRegistry(faces);
  }

  get(fontId: string): FontFace {
    const face = this.faces.get(fontId);
    if (!face) throw new EngineError('INTERNAL', `Font "${fontId}" is not part of the template.`);
    return face;
  }
}
