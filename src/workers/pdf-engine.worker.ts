/**
 * The PDF Web Worker: runs the generation engine off the main thread so the page stays
 * responsive while hundreds of documents are built.
 *
 * It is a thin adapter. All it adds to `src/lib/pdf-engine` is what the engine deliberately does
 * not know about: where images come from (the proxy), how to shrink them (a canvas), how to
 * cancel (an AbortController per job) and how to talk to the page (comlink).
 *
 * Start it through `createPdfEngineClient()` in `pdf-engine.client.ts`, never directly.
 */
import * as Comlink from 'comlink';

import { EngineError, generateDocuments, readPdfPages } from '@/lib/pdf-engine';

import { createCanvasImageProcessor } from './canvas-image-processor';
import { createImageLoader } from './image-loader';
import type {
  PdfEngineWorkerApi,
  WorkerCallbacks,
  WorkerError,
  WorkerGenerationRequest,
  WorkerOutcome,
} from './protocol';

const DEFAULT_PROXY_URL = '/api/proxy-image';

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

const api: PdfEngineWorkerApi = {
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
          loadImage: createImageLoader({
            proxyUrl: request.imageProxyUrl ?? DEFAULT_PROXY_URL,
            origin: self.location.origin,
            localImages: request.localImages,
            getAuthToken: () => remote.getAuthToken(),
          }),
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
      // Close the channel comlink opened for this job's callbacks.
      (callbacks as { [Comlink.releaseProxy]?: () => void })[Comlink.releaseProxy]?.();
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
