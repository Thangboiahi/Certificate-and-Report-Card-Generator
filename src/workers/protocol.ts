/**
 * The contract between the page and the PDF Web Worker.
 *
 * Everything that crosses the boundary must survive structured cloning: plain data, binary
 * buffers, and (through comlink's proxying) the callback object. Errors do not survive well —
 * custom fields such as `code` are dropped — so the worker reports failures as data
 * (`WorkerOutcome`) and the client turns them back into proper errors.
 */
import type {
  EngineAssets,
  EngineErrorCode,
  GeneratedDocument,
  GenerationOptions,
  GenerationProgress,
  GenerationResult,
} from '@/lib/pdf-engine';
import type { DataRow, TemplateDefinition, TemplatePage } from '@/lib/template';

export interface WorkerGenerationRequest {
  /** Chosen by the caller; used to cancel this job. */
  jobId: string;
  template: TemplateDefinition;
  assets: EngineAssets;
  rows: DataRow[];
  /** `signal` cannot cross the boundary — use `cancel(jobId)` instead. */
  options: Omit<GenerationOptions, 'signal'>;
  /**
   * Images supplied directly rather than fetched — e.g. files the user picked from their device —
   * keyed by the exact value a placeholder resolves to (typically a file name).
   */
  localImages?: Record<string, ArrayBuffer>;
  /** URL of the image proxy route. Defaults to `/api/proxy-image`. */
  imageProxyUrl?: string;
}

/** Functions the worker calls back on the page. Wrap the object with `Comlink.proxy`. */
export interface WorkerCallbacks {
  /** Receives each finished file. The worker waits for the returned promise before continuing. */
  onDocument(document: GeneratedDocument): void | Promise<void>;
  onProgress?(progress: GenerationProgress): void | Promise<void>;
  /**
   * Returns a fresh Firebase ID token for the image proxy, or `null` when signed out. Called
   * again whenever the worker's cached token is about to go stale, so long jobs keep working.
   */
  getAuthToken?(): Promise<string | null>;
}

export interface WorkerError {
  code: EngineErrorCode | 'UNEXPECTED';
  message: string;
  details: string[];
}

export type WorkerOutcome<T> = { ok: true; value: T } | { ok: false; error: WorkerError };

/** What the worker exposes through comlink. */
export interface PdfEngineWorkerApi {
  generate(
    request: WorkerGenerationRequest,
    callbacks: WorkerCallbacks,
  ): Promise<WorkerOutcome<GenerationResult>>;
  /** Stops a running job after its current row. Unknown ids are ignored. */
  cancel(jobId: string): void;
  /** Reads the displayed page sizes of a PDF (for a newly uploaded template). */
  readPdfPages(pdf: ArrayBuffer): Promise<WorkerOutcome<TemplatePage[]>>;
}
