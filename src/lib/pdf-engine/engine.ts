/**
 * The generation engine: template + rows in, PDF files out.
 *
 * For every row the work happens in three steps, in this order on purpose:
 *
 *   1. plan    — resolve each placeholder's value from the row. A missing required value fails
 *                the row here, before any work is spent on it.
 *   2. prepare — everything asynchronous: download and embed images, embed fonts, build QR
 *                matrices. A required image that cannot be loaded fails the row here.
 *   3. draw    — synchronous and cannot be interrupted, so a page is never left half drawn.
 *
 * Two output modes share those steps and differ only in where pages come from — see
 * `generateSeparate` and `generateMerged`, and docs/DECISIONS.md (ADR-009).
 */
import { EncryptedPDFError, PDFDocument, type PDFEmbeddedPage, type PDFPage } from 'pdf-lib';

import { renderTokens, resolveBinding } from '@/lib/template/bindings';
import { validateTemplate } from '@/lib/template/schema';
import type {
  DataRow,
  ImagePlaceholder,
  Placeholder,
  TemplateDefinition,
  TemplatePage,
} from '@/lib/template/types';

import { drawImage, embedImage, type EmbeddedImage } from './draw-image';
import { createQrMatrix, drawQr } from './draw-qr';
import { drawText } from './draw-text';
import { EngineError } from './errors';
import { FileNamer, sanitizeFileName } from './file-names';
import { FontRegistry, type DocumentFont, type FontFace } from './fonts';
import { computePageFrame, type PageFrame, type Rect } from './geometry';
import { ImageError, ImageStore, type ImageRequest, type PreparedImage } from './image-store';
import { invert } from './matrix';
import { PageCanvas } from './page-canvas';
import type {
  EngineDependencies,
  GenerationHandlers,
  GenerationJob,
  GenerationResult,
  RowFailure,
  RowReport,
  RowWarning,
} from './types';

const DEFAULT_IMAGE_CONCURRENCY = 6;
const DEFAULT_IMAGE_DPI = 300;
/** Memory budget for downloaded images kept for reuse within a job. */
const IMAGE_CACHE_BYTES = 96 * 1024 * 1024;
/** Page sizes may differ from the template record by this much before we call it a mismatch. */
const PAGE_SIZE_TOLERANCE = 1;

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Template PDF
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** What the engine needs to know about one page of the background PDF. */
interface SourcePage {
  frame: PageFrame;
  /** The visible region in the page's own coordinates. */
  cropBox: Rect;
  /** False for a page with no content stream (a truly blank page). */
  hasContent: boolean;
}

function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    // `updateMetadata: false` leaves the customer's document properties as they were.
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (cause) {
    if (cause instanceof EncryptedPDFError) {
      throw new EngineError(
        'TEMPLATE_PDF_ENCRYPTED',
        'The template PDF is password-protected. Remove the password and upload it again.',
        { cause },
      );
    }
    throw new EngineError('TEMPLATE_PDF_UNREADABLE', 'The template PDF could not be read.', {
      cause,
    });
  }
}

function describePage(page: PDFPage): SourcePage {
  const cropBox = page.getCropBox();
  return {
    cropBox,
    frame: computePageFrame(cropBox, page.getRotation().angle),
    hasContent: page.node.Contents() !== undefined,
  };
}

/**
 * Reads the displayed size of every page of a PDF — what `TemplateDefinition.pages` must contain.
 * Use it when a template file is uploaded.
 */
export async function readPdfPages(pdf: Uint8Array | ArrayBuffer): Promise<TemplatePage[]> {
  const document = await loadPdf(toBytes(pdf));
  return document.getPages().map((page) => {
    const { frame } = describePage(page);
    return { width: frame.width, height: frame.height };
  });
}

function describeSourcePages(source: PDFDocument, template: TemplateDefinition): SourcePage[] {
  const pages = source.getPages().map(describePage);

  if (pages.length !== template.pages.length) {
    throw new EngineError(
      'TEMPLATE_PDF_MISMATCH',
      `The template was set up for ${template.pages.length} page(s) but the PDF has ${pages.length}.`,
    );
  }
  pages.forEach((page, index) => {
    const expected = template.pages[index] as TemplatePage;
    const differs =
      Math.abs(page.frame.width - expected.width) > PAGE_SIZE_TOLERANCE ||
      Math.abs(page.frame.height - expected.height) > PAGE_SIZE_TOLERANCE;
    if (differs) {
      throw new EngineError(
        'TEMPLATE_PDF_MISMATCH',
        `Page ${index + 1} of the PDF is a different size from the one the template was set up with.`,
      );
    }
  });
  return pages;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// One output document
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** Fonts and images already embedded in one output PDF, so each is embedded only once. */
class DocumentSession {
  private readonly fonts = new Map<string, Promise<DocumentFont>>();
  private readonly images = new Map<string, Promise<EmbeddedImage>>();

  constructor(readonly document: PDFDocument) {}

  font(face: FontFace): Promise<DocumentFont> {
    let font = this.fonts.get(face.id);
    if (!font) {
      font = face.embedInto(this.document);
      this.fonts.set(face.id, font);
    }
    return font;
  }

  image(key: string, prepared: PreparedImage): Promise<EmbeddedImage> {
    let image = this.images.get(key);
    if (!image) {
      image = embedImage(this.document, prepared);
      // The rejection is delivered to whoever awaits it; this only stops a spurious
      // "unhandled rejection" for a failure nobody has awaited yet.
      image.catch(() => undefined);
      this.images.set(key, image);
    }
    return image;
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// One row
// ───────────────────────────────────────────────────────────────────────────────────────────────

interface PlannedItem {
  placeholder: Placeholder;
  /** Never empty: empty values are dropped (or fail the row) during planning. */
  value: string;
}

type RowPlan = { items: PlannedItem[] } | { failure: RowFailure };

/** A drawing operation, ready to run against the row's pages. */
type DrawStep = (canvases: readonly PageCanvas[], warn: (warning: RowWarning) => void) => void;

type PreparedRow = { steps: DrawStep[] } | { failure: RowFailure };

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

class Job {
  readonly template: TemplateDefinition;
  readonly rows: readonly DataRow[];
  readonly templateBytes: Uint8Array;
  readonly sourcePages: SourcePage[];
  readonly source: PDFDocument;

  private readonly fonts: FontRegistry;
  private readonly images: ImageStore;
  private readonly imageDpi: number;
  private readonly lookahead: number;
  private readonly plans = new Map<number, RowPlan>();
  private prefetchedThrough = -1;

  private constructor(init: {
    template: TemplateDefinition;
    rows: readonly DataRow[];
    templateBytes: Uint8Array;
    source: PDFDocument;
    sourcePages: SourcePage[];
    fonts: FontRegistry;
    images: ImageStore;
    imageDpi: number;
    lookahead: number;
  }) {
    this.template = init.template;
    this.rows = init.rows;
    this.templateBytes = init.templateBytes;
    this.source = init.source;
    this.sourcePages = init.sourcePages;
    this.fonts = init.fonts;
    this.images = init.images;
    this.imageDpi = init.imageDpi;
    this.lookahead = init.lookahead;
  }

  static async create(job: GenerationJob, dependencies: EngineDependencies): Promise<Job> {
    const validation = validateTemplate(job.template);
    if (!validation.ok) {
      throw new EngineError('INVALID_TEMPLATE', 'The template is not valid.', {
        details: validation.issues.map((issue) => `${issue.path}: ${issue.message}`),
      });
    }
    const template = validation.template;

    const templateBytes = toBytes(job.assets.templatePdf);
    const source = await loadPdf(templateBytes);
    const sourcePages = describeSourcePages(source, template);
    const fonts = await FontRegistry.create(template.fonts, job.assets.fonts);

    const concurrency = Math.max(
      1,
      Math.floor(job.options.imageConcurrency ?? DEFAULT_IMAGE_CONCURRENCY),
    );
    const images = new ImageStore({
      loadImage: dependencies.loadImage,
      processImage: dependencies.processImage,
      concurrency,
      maxCachedBytes: IMAGE_CACHE_BYTES,
      signal: job.options.signal,
    });

    return new Job({
      template,
      rows: job.rows,
      templateBytes,
      source,
      sourcePages,
      fonts,
      images,
      imageDpi: job.options.imageDpi ?? DEFAULT_IMAGE_DPI,
      lookahead: concurrency,
    });
  }

  /** Step 1: resolve values. Cached, because rows are also planned ahead for prefetching. */
  plan(rowIndex: number): RowPlan {
    let plan = this.plans.get(rowIndex);
    if (plan) return plan;

    const row = this.rows[rowIndex] ?? {};
    const items: PlannedItem[] = [];
    plan = { items };

    for (const placeholder of this.template.placeholders) {
      let value = resolveBinding(placeholder.binding, row);
      if (value === '' && placeholder.type === 'text') value = placeholder.fallbackText ?? '';

      if (value !== '') {
        items.push({ placeholder, value });
      } else if (placeholder.required) {
        plan = {
          failure: {
            code: 'REQUIRED_VALUE_MISSING',
            placeholderId: placeholder.id,
            message: `"${placeholder.label}" is required but empty.`,
          },
        };
        break;
      }
    }

    this.plans.set(rowIndex, plan);
    return plan;
  }

  forget(rowIndex: number): void {
    this.plans.delete(rowIndex);
  }

  private imageRequest(placeholder: ImagePlaceholder, source: string): ImageRequest {
    const pixels = (points: number) => Math.max(1, Math.ceil((points / 72) * this.imageDpi));
    return {
      source,
      targetWidth: pixels(placeholder.box.width),
      targetHeight: pixels(placeholder.box.height),
    };
  }

  /** Starts downloading the images of the next few rows while the current one is being built. */
  prefetchAhead(rowIndex: number): void {
    const through = Math.min(this.rows.length - 1, rowIndex + this.lookahead);
    for (let ahead = Math.max(this.prefetchedThrough, rowIndex) + 1; ahead <= through; ahead++) {
      const plan = this.plan(ahead);
      if ('failure' in plan) continue;
      for (const { placeholder, value } of plan.items) {
        if (placeholder.type === 'image')
          this.images.prefetch(this.imageRequest(placeholder, value));
      }
    }
    this.prefetchedThrough = Math.max(this.prefetchedThrough, through);
  }

  /** Step 2: everything asynchronous. Returns the drawing steps, or why the row cannot be drawn. */
  async prepare(
    session: DocumentSession,
    items: readonly PlannedItem[],
    warnings: RowWarning[],
  ): Promise<PreparedRow> {
    const missingRequired = (placeholder: Placeholder, message: string): PreparedRow => ({
      failure: { code: 'REQUIRED_VALUE_MISSING', placeholderId: placeholder.id, message },
    });

    // Start every download of the row at once; the store limits how many actually run.
    const loading = items.map(({ placeholder, value }) => {
      if (placeholder.type !== 'image') return null;
      const request = this.imageRequest(placeholder, value);
      const key = this.images.keyOf(request);
      return this.images
        .get(request)
        .then((prepared) => session.image(key, prepared))
        .then(
          (embedded) => ({ embedded }),
          (error: unknown) => ({ error }),
        );
    });

    const steps: DrawStep[] = [];
    for (const [index, { placeholder, value }] of items.entries()) {
      switch (placeholder.type) {
        case 'text': {
          const font = await session.font(this.fonts.get(placeholder.style.fontId));
          steps.push((canvases, warn) =>
            drawText(
              canvases[placeholder.pageIndex] as PageCanvas,
              placeholder,
              font,
              value,
              (code, message) => warn({ code, placeholderId: placeholder.id, message }),
            ),
          );
          break;
        }

        case 'image': {
          const outcome = await (loading[index] as NonNullable<(typeof loading)[number]>);
          if ('error' in outcome) {
            const problem =
              outcome.error instanceof ImageError
                ? outcome.error
                : new ImageError('IMAGE_LOAD_FAILED', errorMessage(outcome.error));
            const message = `"${placeholder.label}": ${problem.message}`;
            if (placeholder.required) return missingRequired(placeholder, message);
            warnings.push({ code: problem.code, placeholderId: placeholder.id, message });
            break;
          }
          const { embedded } = outcome;
          steps.push((canvases) =>
            drawImage(canvases[placeholder.pageIndex] as PageCanvas, placeholder, embedded),
          );
          break;
        }

        case 'qr': {
          const matrix = createQrMatrix(value, placeholder.errorCorrection);
          if (!matrix) {
            const message = `"${placeholder.label}": the value is too long for a QR code.`;
            if (placeholder.required) return missingRequired(placeholder, message);
            warnings.push({ code: 'QR_TOO_LONG', placeholderId: placeholder.id, message });
            break;
          }
          steps.push((canvases) =>
            drawQr(canvases[placeholder.pageIndex] as PageCanvas, placeholder, matrix),
          );
          break;
        }
      }
    }
    return { steps };
  }
}

/** Step 3: draw. Synchronous from the first operator to the last. */
function draw(
  steps: readonly DrawStep[],
  canvases: readonly PageCanvas[],
  warnings: RowWarning[],
): void {
  for (const step of steps) step(canvases, (warning) => warnings.push(warning));
  for (const canvas of canvases) canvas.close();
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// The run loop shared by both modes
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** Thrown inside a row to stop the whole job because it was cancelled. */
class Cancelled extends Error {}

interface RunState {
  succeeded: number;
  failed: number;
  documents: number;
  cancelled: boolean;
  problemRows: RowReport[];
}

/**
 * Builds one row. Returns a failure to report, or nothing on success. May throw `Cancelled`.
 * Anything else it throws is recorded as a failure of that row only.
 */
type BuildRow = (
  rowIndex: number,
  items: readonly PlannedItem[],
  warnings: RowWarning[],
) => Promise<RowFailure | void>;

async function run(
  job: Job,
  options: GenerationJob['options'],
  handlers: GenerationHandlers,
  state: RunState,
  buildRow: BuildRow,
): Promise<void> {
  const { signal } = options;

  for (let rowIndex = 0; rowIndex < job.rows.length; rowIndex++) {
    if (signal?.aborted) {
      state.cancelled = true;
      return;
    }
    job.prefetchAhead(rowIndex);

    const report: RowReport = { rowIndex, status: 'ok', warnings: [] };
    let failure: RowFailure | void;
    try {
      const plan = job.plan(rowIndex);
      failure =
        'failure' in plan ? plan.failure : await buildRow(rowIndex, plan.items, report.warnings);
    } catch (error) {
      if (error instanceof Cancelled || signal?.aborted || isAbortError(error)) {
        state.cancelled = true;
        return;
      }
      // Problems with the job itself are not this row's fault and must not be swallowed.
      if (error instanceof EngineError || error instanceof DeliveryError) throw error;
      failure = { code: 'RENDER_FAILED', message: errorMessage(error) };
    } finally {
      job.forget(rowIndex);
    }

    if (failure) {
      report.status = 'failed';
      report.failure = failure;
      state.failed++;
    } else {
      state.succeeded++;
    }
    if (failure || report.warnings.length > 0) state.problemRows.push(report);

    await handlers.onProgress?.({
      completedRows: rowIndex + 1,
      totalRows: job.rows.length,
      failedRows: state.failed,
      row: report,
    });

    if (failure && options.stopOnRowFailure) {
      throw new EngineError('ROW_FAILED', `Row ${rowIndex + 1}: ${failure.message}`);
    }
  }
}

/**
 * Wraps a failure of the caller's own `onDocument` handler (an upload that failed, a full disk).
 * It ends the job: continuing would silently drop files.
 */
class DeliveryError extends Error {
  constructor(cause: unknown) {
    super(`A generated file could not be delivered: ${errorMessage(cause)}`, { cause });
    this.name = 'DeliveryError';
  }
}

async function deliver(
  handlers: GenerationHandlers,
  state: RunState,
  file: Parameters<GenerationHandlers['onDocument']>[0],
): Promise<void> {
  try {
    await handlers.onDocument(file);
  } catch (cause) {
    throw new DeliveryError(cause);
  }
  state.documents++;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Mode: one PDF per row
// ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Each document is the template file itself, loaded afresh, with the row drawn on top. Nothing of
 * the original is lost (links, form fields, metadata), and loading costs no more than copying
 * pages would.
 */
async function generateSeparate(
  job: Job,
  options: GenerationJob['options'],
  handlers: GenerationHandlers,
  state: RunState,
): Promise<void> {
  const namer = new FileNamer();
  const nameTemplate = options.fileNameTemplate ?? job.template.output.fileNameTemplate;

  await run(job, options, handlers, state, async (rowIndex, items, warnings) => {
    const document = await loadPdf(job.templateBytes);
    const session = new DocumentSession(document);

    const prepared = await job.prepare(session, items, warnings);
    if (options.signal?.aborted) throw new Cancelled();
    if ('failure' in prepared) return prepared.failure;

    const pages = document.getPages();
    const canvases = job.sourcePages.map(
      (source, index) => new PageCanvas(document, pages[index] as PDFPage, source.frame),
    );
    draw(prepared.steps, canvases, warnings);

    const bytes = await document.save();
    if (options.signal?.aborted) throw new Cancelled();

    await deliver(handlers, state, {
      fileName: namer.next(
        renderTokens(nameTemplate, job.rows[rowIndex] ?? {}),
        `Document ${rowIndex + 1}`,
      ),
      bytes,
      rowIndexes: [rowIndex],
      pageCount: pages.length,
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Mode: everything in one PDF
// ───────────────────────────────────────────────────────────────────────────────────────────────

interface MergedFile {
  session: DocumentSession;
  /** The template's pages as reusable objects in this file; `null` for a blank page. */
  backgrounds: Array<PDFEmbeddedPage | null>;
  rowIndexes: number[];
}

/**
 * The template's pages are stored once per file and stamped onto a fresh page for every row, so
 * a thousand certificates weigh little more than one. Interactive parts of the template (links,
 * form fields) are not carried over — this output is meant for printing.
 */
async function generateMerged(
  job: Job,
  options: GenerationJob['options'],
  handlers: GenerationHandlers,
  state: RunState,
): Promise<void> {
  const namer = new FileNamer();
  const baseName = sanitizeFileName(options.mergedFileName ?? '') || 'Documents';
  const rowsPerFile =
    options.rowsPerFile && options.rowsPerFile > 0
      ? Math.floor(options.rowsPerFile)
      : Number.POSITIVE_INFINITY;
  const splits = job.rows.length > rowsPerFile;

  let file: MergedFile | undefined;

  const openFile = async (): Promise<MergedFile> => {
    const document = await PDFDocument.create();
    const backgrounds: Array<PDFEmbeddedPage | null> = job.sourcePages.map(() => null);

    const withContent = job.sourcePages.flatMap((page, index) => (page.hasContent ? [index] : []));
    if (withContent.length > 0) {
      const sourcePages = job.source.getPages();
      const embedded = await document.embedPages(
        withContent.map((index) => sourcePages[index] as PDFPage),
        withContent.map((index) => {
          const { x, y, width, height } = (job.sourcePages[index] as SourcePage).cropBox;
          return { left: x, bottom: y, right: x + width, top: y + height };
        }),
        // Stored upright: the page's own rotation and crop offset are undone inside the object.
        withContent.map(
          (index) =>
            [...invert((job.sourcePages[index] as SourcePage).frame.toUserSpace)] as [
              number,
              number,
              number,
              number,
              number,
              number,
            ],
        ),
      );
      withContent.forEach((pageIndex, position) => {
        backgrounds[pageIndex] = embedded[position] ?? null;
      });
    }
    return { session: new DocumentSession(document), backgrounds, rowIndexes: [] };
  };

  const closeFile = async (): Promise<void> => {
    if (!file || file.rowIndexes.length === 0) return;
    const finished = file;
    file = undefined;

    const { document } = finished.session;
    const first = (finished.rowIndexes[0] as number) + 1;
    const last = (finished.rowIndexes[finished.rowIndexes.length - 1] as number) + 1;
    const bytes = await document.save();
    if (options.signal?.aborted) throw new Cancelled();

    await deliver(handlers, state, {
      fileName: namer.next(splits ? `${baseName} (${first}-${last})` : baseName, 'Documents'),
      bytes,
      rowIndexes: finished.rowIndexes,
      pageCount: document.getPageCount(),
    });
  };

  await run(job, options, handlers, state, async (rowIndex, items, warnings) => {
    file ??= await openFile();
    const current = file;
    const { document } = current.session;

    const prepared = await job.prepare(current.session, items, warnings);
    if (options.signal?.aborted) throw new Cancelled();
    if ('failure' in prepared) return prepared.failure;

    // From here to the end of `draw` nothing is awaited, so the row's pages appear all at once.
    const firstNewPage = document.getPageCount();
    try {
      const canvases = job.sourcePages.map((source, index) => {
        const page = document.addPage([source.frame.width, source.frame.height]);
        const background = current.backgrounds[index];
        if (background) page.drawPage(background, { x: 0, y: 0 });
        return new PageCanvas(document, page, {
          width: source.frame.width,
          height: source.frame.height,
          toUserSpace: [1, 0, 0, 1, 0, 0],
        });
      });
      draw(prepared.steps, canvases, warnings);
    } catch (error) {
      // Take back any pages this row added, so a failed row leaves no trace in the file.
      while (document.getPageCount() > firstNewPage)
        document.removePage(document.getPageCount() - 1);
      throw error;
    }

    current.rowIndexes.push(rowIndex);
    if (current.rowIndexes.length >= rowsPerFile) await closeFile();
  });

  // A cancelled job discards the file it was in the middle of.
  if (!state.cancelled) {
    try {
      await closeFile();
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
      state.cancelled = true;
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Entry point
// ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Generates the documents for a job.
 *
 * Throws `EngineError` when the job cannot run at all (invalid template, unreadable PDF, missing
 * font). Problems with individual rows do not throw: the row is skipped, reported through
 * `onProgress`, and listed in the result. A failure of the caller's own `onDocument` handler is
 * rethrown as-is.
 */
export async function generateDocuments(
  job: GenerationJob,
  dependencies: EngineDependencies,
  handlers: GenerationHandlers,
): Promise<GenerationResult> {
  const startedAt = Date.now();
  const state: RunState = {
    succeeded: 0,
    failed: 0,
    documents: 0,
    cancelled: false,
    problemRows: [],
  };

  const prepared = await Job.create(job, dependencies);
  try {
    if (job.options.mode === 'merged') await generateMerged(prepared, job.options, handlers, state);
    else await generateSeparate(prepared, job.options, handlers, state);
  } catch (error) {
    if (error instanceof DeliveryError) throw error.cause;
    throw error;
  }

  return {
    totalRows: job.rows.length,
    succeededRows: state.succeeded,
    failedRows: state.failed,
    documentCount: state.documents,
    cancelled: state.cancelled,
    durationMs: Date.now() - startedAt,
    problemRows: state.problemRows,
  };
}
