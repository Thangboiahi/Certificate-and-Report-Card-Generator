/**
 * Failures that stop a whole generation job. (Problems with a single row are not thrown: they are
 * reported per row — see `RowReport` in `types.ts`.)
 */
export type EngineErrorCode =
  /** The template failed validation. `details` lists every problem. */
  | 'INVALID_TEMPLATE'
  /** The template PDF could not be parsed. */
  | 'TEMPLATE_PDF_UNREADABLE'
  /** The template PDF is password-protected. */
  | 'TEMPLATE_PDF_ENCRYPTED'
  /** The PDF's pages do not match the pages recorded in the template. */
  | 'TEMPLATE_PDF_MISMATCH'
  /** A font the template uses was not supplied. */
  | 'FONT_NOT_PROVIDED'
  /** A supplied font file could not be parsed. */
  | 'FONT_INVALID'
  /** A row failed and the job was configured to stop at the first failure. */
  | 'ROW_FAILED'
  /** A bug in the engine. */
  | 'INTERNAL';

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  /** Extra, human-readable lines (e.g. one per template problem). */
  readonly details: string[];

  constructor(
    code: EngineErrorCode,
    message: string,
    options?: { details?: string[]; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'EngineError';
    this.code = code;
    this.details = options?.details ?? [];
  }
}
