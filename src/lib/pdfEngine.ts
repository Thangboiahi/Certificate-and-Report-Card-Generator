/**
 * The page's handle on the PDF Web Worker (`src/workers/pdf.worker.ts`), via `Comlink.wrap()`.
 *
 *     const engine = createPdfEngineClient();
 *     const batch = engine.generatePdfBatch(template, rows, { assets }, {
 *       onProgress: (progress) => setProgress(progress),
 *     });
 *     cancelButton.onclick = batch.cancel;
 *     const { zip, zipFileName, summary } = await batch.result;
 *     if (zip) saveBlob(zip, zipFileName);
 *     engine.dispose();
 *
 * Browser only: create it inside an effect or an event handler, never during server rendering.
 * This file must not import the engine itself — that would pull pdf-lib into the page's bundle.
 */
import * as Comlink from 'comlink';

// Deliberately the file, not the package index: the index would bring in pdf-lib.
import { EngineError } from '@/lib/pdf-engine/errors';
import type { GenerationResult } from '@/lib/pdf-engine';
import type { DataRow, TemplateDefinition, TemplatePage } from '@/lib/template';
import type {
  PdfBatchCallbacks,
  PdfBatchResult,
  PdfBatchSettings,
  PdfEngineWorkerApi,
  WorkerCallbacks,
  WorkerError,
  WorkerGenerationRequest,
  WorkerOutcome,
} from '@/workers/protocol';

export type { PdfBatchResult, PdfBatchSettings, PdfBatchCallbacks } from '@/workers/protocol';

export interface JobHandle<T> {
  jobId: string;
  /** Settles when the job ends. Rejects with `EngineError` if the job could not run at all. */
  result: Promise<T>;
  /** Stops the job after its current row; the result then reports `cancelled: true`. */
  cancel(): void;
}

export type GenerationJobHandle = JobHandle<GenerationResult>;

export interface PdfEngineClient {
  /** Generates every row and returns one ZIP of PDFs. */
  generatePdfBatch(
    template: TemplateDefinition,
    dataRows: DataRow[],
    settings: Omit<PdfBatchSettings, 'jobId'>,
    callbacks?: PdfBatchCallbacks,
  ): JobHandle<PdfBatchResult>;
  /** Streams each finished PDF to `onDocument` instead of zipping. */
  generate(
    request: Omit<WorkerGenerationRequest, 'jobId'>,
    callbacks: WorkerCallbacks,
  ): GenerationJobHandle;
  readPdfPages(pdf: ArrayBuffer): Promise<TemplatePage[]>;
  /** Stops the worker immediately. Pending jobs are rejected. */
  dispose(): void;
}

function toError(error: WorkerError): Error {
  return error.code === 'UNEXPECTED'
    ? new Error(error.message)
    : new EngineError(error.code, error.message, { details: error.details });
}

function unwrap<T>(outcome: WorkerOutcome<T>): T {
  if (!outcome.ok) throw toError(outcome.error);
  return outcome.value;
}

export function createPdfEngineClient(): PdfEngineClient {
  const worker = new Worker(new URL('../workers/pdf.worker.ts', import.meta.url), {
    type: 'module',
  });
  const api = Comlink.wrap<PdfEngineWorkerApi>(worker);

  // If the worker dies (script failed to load, out of memory) its calls would never settle.
  let failWorker!: (error: Error) => void;
  const workerFailed = new Promise<never>((_resolve, reject) => {
    failWorker = reject;
  });
  workerFailed.catch(() => undefined);
  worker.addEventListener('error', (event) => {
    failWorker(new Error(event.message || 'The document generator stopped unexpectedly.'));
  });

  const run = <T>(call: Promise<WorkerOutcome<T>>): Promise<T> =>
    Promise.race([call, workerFailed]).then(unwrap);

  return {
    generatePdfBatch(template, dataRows, settings, callbacks) {
      const jobId = crypto.randomUUID();
      const proxied = callbacks
        ? // Every member must be a real function: through comlink, any property of the remote
          // object looks callable, so the worker cannot test for missing ones.
          Comlink.proxy({
            onProgress: callbacks.onProgress ?? (() => undefined),
            getAuthToken: callbacks.getAuthToken ?? (async () => null),
          } satisfies Required<PdfBatchCallbacks>)
        : undefined;
      return {
        jobId,
        result: run(api.generatePdfBatch(template, dataRows, { ...settings, jobId }, proxied)),
        cancel: () => void api.cancel(jobId),
      };
    },

    generate(request, callbacks) {
      const jobId = crypto.randomUUID();
      const proxied = Comlink.proxy({
        onDocument: callbacks.onDocument,
        onProgress: callbacks.onProgress ?? (() => undefined),
        getAuthToken: callbacks.getAuthToken ?? (async () => null),
      } satisfies Required<WorkerCallbacks>);
      return {
        jobId,
        result: run(api.generate({ ...request, jobId }, proxied)),
        cancel: () => void api.cancel(jobId),
      };
    },

    readPdfPages(pdf) {
      return run(api.readPdfPages(pdf));
    },

    dispose() {
      failWorker(new Error('The document generator was closed.'));
      api[Comlink.releaseProxy]();
      worker.terminate();
    },
  };
}

/** Offers a Blob (e.g. the batch ZIP) to the user as a download. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  // Give the browser time to start the download before releasing the data.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
