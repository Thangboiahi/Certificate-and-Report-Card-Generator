/**
 * Template Schema — the persisted description of "what goes where" on a document.
 *
 * A template is a background PDF (one or many pages) plus a list of placeholders. Generating a
 * batch means: for every data row, copy the background and fill each placeholder from that row.
 * The same schema drives certificates, report cards, ID cards, letters and any other card or form
 * that is filled in for many people.
 *
 * ── Coordinate system ("page space") ───────────────────────────────────────────────────────────
 * All geometry is in PDF points (1/72 inch) measured from the TOP-LEFT corner of the page AS A
 * VIEWER DISPLAYS IT — i.e. after the PDF's own /Rotate and /CropBox are applied — with x growing
 * right and y growing down. This is exactly what pdf.js reports at scale 1 and what CSS uses, so
 * the "Tap-to-Place" editor converts a tap with one multiplication:
 *
 *     pointX = tapXInCssPixels / renderScale
 *
 * The engine converts page space to pdf-lib's bottom-left, unrotated user space (see
 * `src/lib/pdf-engine/geometry.ts`). Nothing outside the engine deals with PDF user space.
 *
 * ── Evolving the schema ────────────────────────────────────────────────────────────────────────
 * Templates are stored in Firestore, so this shape is a long-lived contract:
 *   - additive, optional fields are safe at any time;
 *   - anything else needs a bump of TEMPLATE_SCHEMA_VERSION and a migration (docs/DECISIONS.md, ADR-003).
 * Keep `schema.ts` (runtime validation) in sync — the compiler enforces it.
 */

import type { TimestampLike } from '@/types/roles';

/** Current version of the persisted template shape. */
export const TEMPLATE_SCHEMA_VERSION = 1 as const;

/** A length or coordinate in PDF points (1 pt = 1/72 in ≈ 0.3528 mm). */
export type Points = number;

/** An sRGB colour as `#RRGGBB` (six hex digits, no alpha — use `opacity` for transparency). */
export type HexColor = `#${string}`;

/** An axis-aligned rectangle in page space (top-left origin, y down). */
export interface Box {
  /** Distance from the left edge of the page to the left edge of the box. */
  x: Points;
  /** Distance from the top edge of the page to the top edge of the box. */
  y: Points;
  width: Points;
  height: Points;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Data binding
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** A value from one cell of the data source (Google Sheets cells arrive as formatted strings). */
export type CellValue = string | number | boolean | null | undefined;

/** One record of the data source: column header → cell value. One row produces one document. */
export type DataRow = Record<string, CellValue>;

/**
 * Where a placeholder gets its content for a given row.
 *
 * - `column`   — the value of one column, e.g. the "Student Name" column.
 * - `template` — free text with `{{Column}}` tokens, e.g. `"Roll No. {{Roll}} — Class {{Class}}"`
 *                or `"https://verify.example.in/c/{{Certificate ID}}"` for a QR code.
 * - `static`   — the same content on every document (a fixed caption, a logo URL, …).
 */
export type DataBinding =
  | { kind: 'column'; column: string }
  | { kind: 'template'; template: string }
  | { kind: 'static'; value: string };

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Fonts
// ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The PDF "standard 14" Latin fonts. They need no font file but only cover Western European
 * characters (WinAnsi): no Indic scripts and no ₹ sign. Use an embedded font for anything else.
 */
export type StandardFontName =
  | 'Helvetica'
  | 'Helvetica-Bold'
  | 'Helvetica-Oblique'
  | 'Helvetica-BoldOblique'
  | 'Times-Roman'
  | 'Times-Bold'
  | 'Times-Italic'
  | 'Times-BoldItalic'
  | 'Courier'
  | 'Courier-Bold'
  | 'Courier-Oblique'
  | 'Courier-BoldOblique';

/**
 * Where a font's bytes come from.
 *
 * - `standard` — built into every PDF viewer; nothing to load.
 * - `library`  — a font from our curated catalogue (Noto families for Indian scripts, popular
 *                certificate faces). `key` identifies the catalogue entry, e.g.
 *                `"noto-sans-devanagari/700"`.
 * - `uploaded` — a TTF/OTF the customer uploaded, stored in Cloud Storage.
 *
 * The engine never resolves these itself: the caller loads the bytes and passes them in keyed by
 * `TemplateFont.id` (see `EngineAssets.fonts`).
 */
export type FontSource =
  | { kind: 'standard'; name: StandardFontName }
  | { kind: 'library'; key: string }
  | { kind: 'uploaded'; storagePath: string };

/** A font made available to this template's text placeholders. */
export interface TemplateFont {
  /** Unique within the template; referenced by `TextStyle.fontId`. */
  id: string;
  /** Human-readable name shown in the editor, e.g. "Noto Sans Devanagari Bold". */
  label: string;
  source: FontSource;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Placeholders
// ───────────────────────────────────────────────────────────────────────────────────────────────

export type PlaceholderType = 'text' | 'image' | 'qr';

/** Fields shared by every placeholder. */
export interface PlaceholderBase {
  /** Unique within the template. Stable across edits so reports can refer to it. */
  id: string;
  type: PlaceholderType;
  /** Name shown in the editor and in generation reports, e.g. "Student name". */
  label: string;
  /** Zero-based index of the template page this placeholder is drawn on. */
  pageIndex: number;
  /** The area the content must stay inside, in page space. */
  box: Box;
  /**
   * Clockwise rotation in degrees around the centre of `box` (same sense as CSS `rotate()`).
   * Defaults to 0.
   */
  rotation?: number;
  /** 0 (invisible) … 1 (opaque). Defaults to 1. */
  opacity?: number;
  /** Where the content comes from. */
  binding: DataBinding;
  /**
   * When true, a row whose value is empty or cannot be rendered (e.g. the photo fails to download)
   * is reported as FAILED and produces no document. When false (default) the placeholder is left
   * blank and the row gets a warning instead.
   */
  required?: boolean;
}

export type HorizontalAlign = 'left' | 'center' | 'right';
export type VerticalAlign = 'top' | 'middle' | 'bottom';
export type TextTransform = 'none' | 'uppercase' | 'lowercase' | 'capitalize';

/** Typography of a text placeholder. */
export interface TextStyle {
  /** `TemplateFont.id` of the font to use. */
  fontId: string;
  /**
   * Preferred font size. With `TextFit.shrinkToFit` this is the MAXIMUM size; the engine only ever
   * goes smaller.
   */
  fontSize: Points;
  color: HexColor;
  align: HorizontalAlign;
  verticalAlign: VerticalAlign;
  /** Line box height as a multiple of the font size (CSS `line-height`), e.g. 1.2. */
  lineHeight: number;
  /** Case conversion applied to the resolved value before layout. Defaults to `'none'`. */
  textTransform?: TextTransform;
}

/**
 * What happens to text that is still too big for its box after wrapping and shrinking.
 *
 * - `visible`  — draw it anyway; it may spill outside the box.
 * - `clip`     — cut it off at the box edges.
 * - `ellipsis` — drop what does not fit and end the last visible line with "…".
 */
export type TextOverflow = 'visible' | 'clip' | 'ellipsis';

/**
 * How text adapts to its box. The four useful combinations:
 *
 * | wrap  | shrinkToFit | behaviour                                                              |
 * | ----- | ----------- | ---------------------------------------------------------------------- |
 * | false | true        | one line, scaled down until it fits the width (a name on a certificate) |
 * | true  | true        | wraps, then scales down until the paragraph fits the box (remarks)      |
 * | true  | false       | wraps at a fixed size; excess handled by `overflow`                     |
 * | false | false       | one line at a fixed size; excess handled by `overflow`                  |
 */
export interface TextFit {
  /** Break the text into several lines at the box width. */
  wrap: boolean;
  /** Reduce the font size (never below `minFontSize`) until the text fits the box. */
  shrinkToFit: boolean;
  /** Smallest size `shrinkToFit` may use. Must be ≤ `TextStyle.fontSize`. */
  minFontSize: Points;
  /** Upper limit on the number of lines when wrapping. Unlimited when omitted. */
  maxLines?: number;
  /** Applied when the text still does not fit at `minFontSize` (or at all, without shrinking). */
  overflow: TextOverflow;
}

/** A single- or multi-line run of text. */
export interface TextPlaceholder extends PlaceholderBase {
  type: 'text';
  style: TextStyle;
  fit: TextFit;
  /** Drawn instead when the resolved value is empty, e.g. "—" or "AB" on a marks sheet. */
  fallbackText?: string;
}

/**
 * How an image is sized inside its box when the aspect ratios differ (CSS `object-fit`).
 *
 * - `cover`   — fill the whole box, cropping whatever overflows. Right for photos and headshots.
 * - `contain` — show the whole image, leaving empty bands. Right for logos and signatures.
 * - `fill`    — stretch to the box. Distorts; only for images made to the exact box shape.
 */
export type ImageFit = 'cover' | 'contain' | 'fill';

/**
 * Which part of the image stays anchored when `cover` crops or `contain` leaves bands (CSS
 * `object-position`). Each axis runs 0 → 1: `{ x: 0.5, y: 0.5 }` is centred, `{ x: 0.5, y: 0 }`
 * keeps the top edge — useful so heads are not cropped out of portrait photos.
 */
export interface ImagePosition {
  x: number;
  y: number;
}

/** The outline an image is masked to. */
export type ImageShape =
  | { kind: 'rectangle' }
  /** Rounded corners; `radius` is clamped to half the shorter side. */
  | { kind: 'rounded'; radius: Points }
  /** An ellipse inscribed in the box — a circle when the box is square. */
  | { kind: 'ellipse' };

/** A line drawn along the image's (masked) outline. */
export interface ImageBorder {
  width: Points;
  color: HexColor;
}

/**
 * A picture fetched per row — a student photo, a property image, a signature, a logo.
 * The binding resolves to an image reference: an `http(s)` URL (fetched through
 * `/api/proxy-image`), or the key of a file supplied directly by the caller.
 */
export interface ImagePlaceholder extends PlaceholderBase {
  type: 'image';
  fit: ImageFit;
  /** Defaults to centred. */
  position?: ImagePosition;
  /** Defaults to a plain rectangle. */
  shape?: ImageShape;
  border?: ImageBorder;
  /** Solid colour painted behind the image (visible in `contain` bands or through transparency). */
  background?: HexColor;
}

/** QR error-correction level: share of the code that can be damaged and still scan (7/15/25/30%). */
export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

/**
 * A QR code encoding the bound value — typically a verification URL. Drawn as vector squares, so
 * it stays sharp at any print size. The code is square: it uses the largest centred square that
 * fits in `box`.
 */
export interface QrPlaceholder extends PlaceholderBase {
  type: 'qr';
  errorCorrection: QrErrorCorrection;
  /** Colour of the dark modules. Keep it dark on a light background or scanners will fail. */
  foreground: HexColor;
  /** Colour painted behind the code. Omit for a transparent background. */
  background?: HexColor;
  /** Width of the empty margin around the code, in modules. The QR standard asks for 4. */
  quietZone: number;
}

/** Anything that can be placed on a page. Discriminated by `type`. */
export type Placeholder = TextPlaceholder | ImagePlaceholder | QrPlaceholder;

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Template
// ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the template is for. Purely descriptive — it selects editor presets (page sizes, starter
 * layouts) and feeds analytics. The engine treats every kind identically.
 */
export type DocumentKind = 'certificate' | 'report' | 'id-card' | 'card' | 'letter' | 'other';

/** The uploaded background file. */
export interface TemplateSource {
  /** Cloud Storage object path of the PDF. */
  storagePath: string;
  /** Original file name, for display only. */
  fileName: string;
  byteSize: number;
  /** Lower-case hex SHA-256 of the file: detects a swapped file and keys client-side caches. */
  sha256: string;
}

/** Displayed size of one page of the background PDF (after its own rotation and crop box). */
export interface TemplatePage {
  width: Points;
  height: Points;
}

/** Defaults for the files a batch produces. A generation job may override them. */
export interface OutputSettings {
  /**
   * File name (without `.pdf`) for each generated document, with `{{Column}}` tokens, e.g.
   * `"{{Roll No}} - {{Student Name}}"`. Illegal characters are replaced and duplicates numbered.
   */
  fileNameTemplate: string;
}

/**
 * Everything the engine needs to know about a template. Plain JSON: safe to store in Firestore
 * and to send to a Web Worker.
 */
export interface TemplateDefinition {
  schemaVersion: typeof TEMPLATE_SCHEMA_VERSION;
  kind: DocumentKind;
  source: TemplateSource;
  /**
   * One entry per page of the background PDF, in order — the array index IS the page index.
   * Recorded at upload so the editor and the validator work without re-reading the PDF, and so
   * the engine can warn when the file no longer matches.
   */
  pages: TemplatePage[];
  fonts: TemplateFont[];
  /**
   * Drawn in array order: later placeholders paint over earlier ones on the same page. A page
   * with no placeholders is copied unchanged.
   */
  placeholders: Placeholder[];
  output: OutputSettings;
}

/**
 * A template as stored in Firestore at `templates/{id}`: the definition plus ownership and audit
 * fields. Ownership decides who may change it (see `firebase/firestore.rules`):
 *   - personal template (`institutionId: null`): its owner, a Micro-Issuer;
 *   - institution template: that institution's admin. `ownerUid` records who created it.
 * `ownerUid` and `institutionId` never change after creation.
 */
export interface TemplateRecord {
  /** The document id. Not stored inside the document. */
  id: string;
  /** Firebase Auth uid of the creator. */
  ownerUid: string;
  /** The owning institution, or `null` for a personal template. */
  institutionId: string | null;
  name: string;
  /** Server time of creation (set with a server timestamp). */
  createdAt: TimestampLike;
  /** Server time of the last change (set with a server timestamp). */
  updatedAt: TimestampLike;
  definition: TemplateDefinition;
}

export type TemplateRecordDocument = Omit<TemplateRecord, 'id'>;
