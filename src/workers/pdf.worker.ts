/**
 * The PDF Web Worker: runs the generation engine (`src/lib/pdf-engine`, pdf-lib) off the main
 * thread so the page stays responsive while thousands of documents are built.
 *
 * It adds what the engine deliberately leaves to its host: where images come from (same-origin
 * fetches through `/api/proxy-image`), how to shrink them (an OffscreenCanvas), cancellation, ZIP
 * packaging, and talking to the page (comlink).
 *
 * Memory, for 2,500-row batches on mid-range phones:
 *   - the engine produces one PDF at a time and keeps no reference to it afterwards;
 *   - each PDF becomes a Blob immediately (`zip-writer.ts`), leaving the JS heap;
 *   - photos are shrunk to the pixels their box needs before embedding, decoded one at a time,
 *     and cached with a byte budget;
 *   - progress messages are throttled and never awaited, so the page cannot hold the worker up.
 *
 * Start it through `createPdfEngineClient()` in `src/lib/pdfEngine.ts`, never directly.
 */
import * as Comlink from 'comlink';

import {
  EngineError,
  generateDocuments,
  readPdfPages,
  type GenerationProgress,
} from '@/lib/pdf-engine';
import type { DataRow, TemplateDefinition } from '@/lib/template';

import { createCanvasImageProcessor } from './canvas-image-processor';
import { createImageLoader } from './image-loader';
import type {
  PdfBatchCallbacks,
  PdfBatchSettings,
  PdfEngineWorkerApi,
  WorkerCallbacks,
  WorkerError,
  WorkerGenerationRequest,
  WorkerOutcome,
} from './protocol';
import { createZipWriter } from './zip-writer';

const DEFAULT_PROXY_URL = '/api/proxy-image';
const PROGRESS_INTERVAL_MS = 100;

/** Jobs in progress, so they can be cancelled. */
const running = new Map<string, AbortController>();

/** Created once: it serialises image decoding across everything this worker does. */
const processImage = createCanvasImageProcessor();

function describe(error: unknown): WorkerError {
  if (error instanceof EngineError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return {
    code: 'UNEXPECTED',
    message: error instanceof Error ? error.message : String(error),
    details: [],
  };
}

async function attempt<T>(work: () => Promise<T>): Promise<WorkerOutcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

function releaseCallbacks(callbacks: object | undefined): void {
  // Close the channel comlink opened for a job's callbacks.
  (callbacks as { [Comlink.releaseProxy]?: () => void } | undefined)?.[Comlink.releaseProxy]?.();
}

function imageLoader(
  settings: { imageProxyUrl?: string; localImages?: Record<string, ArrayBuffer> },
  getAuthToken?: () => Promise<string | null>,
) {
  return createImageLoader({
    proxyUrl: settings.imageProxyUrl ?? DEFAULT_PROXY_URL,
    origin: self.location.origin,
    localImages: settings.localImages,
    getAuthToken,
  });
}

/** Calls `report` at most every `PROGRESS_INTERVAL_MS`, and always for the final row. */
function throttledProgress(report?: (progress: GenerationProgress) => void) {
  let last = 0;
  return (progress: GenerationProgress) => {
    if (!report) return;
    const now = performance.now();
    if (now - last < PROGRESS_INTERVAL_MS && progress.completedRows < progress.totalRows) return;
    last = now;
    // Deliberately not awaited: a busy page must not slow generation down.
    void Promise.resolve(report(progress)).catch(() => undefined);
  };
}

const api: PdfEngineWorkerApi = {
  generatePdfBatch(
    template: TemplateDefinition,
    dataRows: DataRow[],
    settings: PdfBatchSettings,
    callbacks?: PdfBatchCallbacks,
  ) {
    const controller = new AbortController();
    running.set(settings.jobId, controller);
    const zipFileName = settings.zipFileName ?? 'documents.zip';

    return attempt(async () => {
      const zip = createZipWriter();
      const summary = await generateDocuments(
        {
          template,
          assets: settings.assets,
          rows: dataRows,
          options: { mode: 'separate', ...settings.options, signal: controller.signal },
        },
        {
          // The client supplies both callbacks or none (see pdfEngine.ts).
          loadImage: imageLoader(settings, callbacks ? () => callbacks.getAuthToken!() : undefined),
          processImage,
        },
        {
          onDocument: (document) => zip.add(document.fileName, document.bytes),
          onProgress: throttledProgress(
            callbacks ? (progress) => callbacks.onProgress!(progress) : undefined,
          ),
        },
      );

      if (summary.cancelled) {
        return { zip: null, zipFileName, fileCount: zip.fileCount, summary };
      }
      const fileCount = zip.fileCount;
      return { zip: await zip.finish(), zipFileName, fileCount, summary };
    }).finally(() => {
      running.delete(settings.jobId);
      releaseCallbacks(callbacks);
    });
  },

  generate(request: WorkerGenerationRequest, callbacks: WorkerCallbacks) {
    // Across comlink every callback is a remote function; the client always supplies all three.
    const remote = callbacks as Required<WorkerCallbacks>;
    const controller = new AbortController();
    running.set(request.jobId, controller);

    return attempt(() =>
      generateDocuments(
        {
          template: request.template,
          assets: request.assets,
          rows: request.rows,
          options: { ...request.options, signal: controller.signal },
        },
        {
          loadImage: imageLoader(request, () => remote.getAuthToken()),
          processImage,
        },
        {
          // Hand the bytes over instead of copying them: a batch moves gigabytes this way.
          onDocument: (document) =>
            remote.onDocument(Comlink.transfer(document, [document.bytes.buffer as ArrayBuffer])),
          onProgress: (progress) => remote.onProgress(progress),
        },
      ),
    ).finally(() => {
      running.delete(request.jobId);
      releaseCallbacks(callbacks);
    });
  },

  cancel(jobId: string) {
    running.get(jobId)?.abort();
  },

  readPdfPages(pdf: ArrayBuffer) {
    return attempt(() => readPdfPages(pdf));
  },
};

Comlink.expose(api);
