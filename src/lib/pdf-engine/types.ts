/**
 * The engine's public contract: what a caller passes in and what it gets back.
 *
 * Everything here is plain data or plain functions — nothing browser- or Node-specific — so the
 * same engine runs in a Web Worker (production), in Node (tests), or on a server later.
 */
import type { ImageFormat } from '@/lib/images/sniff';
import type { DataRow, TemplateDefinition } from '@/lib/template/types';

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Input
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** The binary files a job needs, already loaded by the caller. */
export interface EngineAssets {
  /** The template's background PDF. */
  templatePdf: Uint8Array | ArrayBuffer;
  /**
   * Font files for every `TemplateFont` whose source is not `standard`, keyed by `TemplateFont.id`.
   * TrueType (.ttf) or OpenType (.otf).
   */
  fonts: Record<string, Uint8Array | ArrayBuffer>;
}

/**
 * Loads the bytes of an image given the reference a placeholder resolved to (normally an http(s)
 * URL). Reject with an `Error` whose message can be shown to the user; honour `signal`.
 */
export type ImageLoader = (source: string, signal?: AbortSignal) => Promise<Uint8Array>;

export interface ImageProcessingRequest {
  bytes: Uint8Array;
  format: ImageFormat;
  /** Pixel size the image needs to look sharp in its box at the job's print resolution. */
  targetWidth: number;
  targetHeight: number;
}

export interface ProcessedImage {
  bytes: Uint8Array;
  format: 'jpeg' | 'png';
}

/**
 * Optional hook run on every image before it is embedded. Its two jobs: convert formats pdf-lib
 * cannot embed (WebP, GIF, AVIF…) into JPEG or PNG, and shrink oversized photos to the size
 * actually needed. Return `null` to use the original bytes. In the browser this is implemented
 * with an OffscreenCanvas; without it, only JPEG and PNG are supported and nothing is resized.
 */
export type ImageProcessor = (request: ImageProcessingRequest) => Promise<ProcessedImage | null>;

/** The engine's connections to the outside world. */
export interface EngineDependencies {
  loadImage: ImageLoader;
  processImage?: ImageProcessor;
}

/**
 * - `separate` — one PDF per row (to send or upload individually).
 * - `merged`   — one PDF containing every row's pages back to back (to print).
 */
export type OutputMode = 'separate' | 'merged';

export interface GenerationOptions {
  mode: OutputMode;
  /** Overrides `template.output.fileNameTemplate` for `separate` output. */
  fileNameTemplate?: string;
  /** File name (without `.pdf`) for `merged` output. Defaults to "Documents". */
  mergedFileName?: string;
  /**
   * `merged` only: start a new file after this many rows, to bound memory on phones. The files
   * are named "<name> (1-200)", "<name> (201-400)", … Unlimited when omitted.
   */
  rowsPerFile?: number;
  /** Stop the job at the first row that fails instead of skipping it. Defaults to false. */
  stopOnRowFailure?: boolean;
  /** How many images may download at once. Defaults to 6. */
  imageConcurrency?: number;
  /** Print resolution used to size images for `processImage`. Defaults to 300 dots per inch. */
  imageDpi?: number;
  /** Aborting it stops the job after the current row; the result has `cancelled: true`. */
  signal?: AbortSignal;
}

export interface GenerationJob {
  template: TemplateDefinition;
  assets: EngineAssets;
  /** One document (or one set of pages) is produced per row, in order. */
  rows: DataRow[];
  options: GenerationOptions;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Output
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** A finished PDF file. */
export interface GeneratedDocument {
  /** Safe on every operating system, unique within the job, ends with `.pdf`. */
  fileName: string;
  bytes: Uint8Array;
  /** Indexes into `job.rows` of the rows this file contains. */
  rowIndexes: number[];
  pageCount: number;
}

/** Something that was not fatal but that the user should look at. */
export type WarningCode =
  /** Text did not fit its box even at the smallest allowed size. */
  | 'TEXT_OVERFLOW'
  /** The chosen font has no glyph for some characters. */
  | 'UNSUPPORTED_CHARACTERS'
  /** The font's shaping rules failed on some text; a simpler method was used and letters may be slightly off. */
  | 'TEXT_SHAPING_DEGRADED'
  /** The text contains a right-to-left script (Urdu, Arabic, Hebrew), which is not laid out correctly yet. */
  | 'RIGHT_TO_LEFT_TEXT'
  /** An image could not be downloaded. */
  | 'IMAGE_LOAD_FAILED'
  /** The image is in a format that cannot be embedded on this device. */
  | 'IMAGE_UNSUPPORTED_FORMAT'
  /** The file is damaged or is not really an image. */
  | 'IMAGE_INVALID'
  /** The value is too long for a QR code at the chosen error-correction level. */
  | 'QR_TOO_LONG';

export interface RowWarning {
  code: WarningCode;
  placeholderId: string;
  /** Written for the end user. */
  message: string;
}

export type RowFailureCode =
  /** A placeholder marked `required` had no usable value. `placeholderId` says which. */
  | 'REQUIRED_VALUE_MISSING'
  /** Anything else that prevented this row's document from being produced. */
  | 'RENDER_FAILED';

export interface RowFailure {
  code: RowFailureCode;
  placeholderId?: string;
  message: string;
}

/** What happened to one row. */
export interface RowReport {
  rowIndex: number;
  status: 'ok' | 'failed';
  warnings: RowWarning[];
  /** Present when `status` is `failed`. */
  failure?: RowFailure;
}

export interface GenerationProgress {
  completedRows: number;
  totalRows: number;
  failedRows: number;
  /** The row that just finished. */
  row: RowReport;
}

export interface GenerationHandlers {
  /**
   * Receives each finished file as soon as it is ready. The engine waits for the returned promise
   * before continuing, so a slow consumer (an upload, a ZIP writer) naturally slows generation
   * instead of piling files up in memory. The engine keeps no reference to `bytes` afterwards.
   */
  onDocument(document: GeneratedDocument): void | Promise<void>;
  /** Called after every row. Also awaited. */
  onProgress?(progress: GenerationProgress): void | Promise<void>;
}

export interface GenerationResult {
  totalRows: number;
  succeededRows: number;
  failedRows: number;
  /** Number of files delivered through `onDocument`. */
  documentCount: number;
  /** True when the job was stopped through `options.signal` before finishing. */
  cancelled: boolean;
  durationMs: number;
  /** Reports for the rows that failed or had warnings. Rows not listed here were fine. */
  problemRows: RowReport[];
}
