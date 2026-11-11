/**
 * The page's handle on the PDF Web Worker.
 *
 *     const engine = createPdfEngineClient();
 *     const job = engine.generate({ template, assets, rows, options }, {
 *       onDocument: (file) => saveSomewhere(file.fileName, file.bytes),
 *       onProgress: (progress) => setProgress(progress),
 *       getAuthToken: () => auth.currentUser?.getIdToken() ?? null,
 *     });
 *     cancelButton.onclick = job.cancel;
 *     const summary = await job.result;
 *     engine.dispose();
 *
 * Browser only: create it inside an effect or an event handler, never during server rendering.
 * This file must not import the engine itself — that would pull pdf-lib into the page's bundle.
 */
import * as Comlink from 'comlink';

// Deliberately the file, not the package index: the index would bring in pdf-lib.
import { EngineError } from '@/lib/pdf-engine/errors';
import type { GenerationResult } from '@/lib/pdf-engine';
import type { TemplatePage } from '@/lib/template';

import type {
  PdfEngineWorkerApi,
  WorkerCallbacks,
  WorkerError,
  WorkerGenerationRequest,
  WorkerOutcome,
} from './protocol';

export interface GenerationJobHandle {
  jobId: string;
  /** Settles when the job ends. Rejects with `EngineError` if the job could not run. */
  result: Promise<GenerationResult>;
  /** Stops the job after its current row; `result` then resolves with `cancelled: true`. */
  cancel(): void;
}

export interface PdfEngineClient {
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
  const worker = new Worker(new URL('./pdf-engine.worker.ts', import.meta.url), { type: 'module' });
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

  return {
    generate(request, callbacks) {
      const jobId = crypto.randomUUID();
      const proxied = Comlink.proxy({
        onDocument: callbacks.onDocument,
        onProgress: callbacks.onProgress ?? (() => undefined),
        getAuthToken: callbacks.getAuthToken ?? (async () => null),
      } satisfies Required<WorkerCallbacks>);

      const result = Promise.race([
        api.generate({ ...request, jobId }, proxied),
        workerFailed,
      ]).then(unwrap);

      return { jobId, result, cancel: () => void api.cancel(jobId) };
    },

    async readPdfPages(pdf) {
      return unwrap(await Promise.race([api.readPdfPages(pdf), workerFailed]));
    },

    dispose() {
      failWorker(new Error('The document generator was closed.'));
      api[Comlink.releaseProxy]();
      worker.terminate();
    },
  };
}
