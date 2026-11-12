/**
 * PDF generation engine — public surface.
 *
 * Import from here, not from the files inside this folder. This folder is the only place in the
 * codebase allowed to import `pdf-lib` or `@pdf-lib/fontkit` (docs/DECISIONS.md, ADR-006).
 */
export { generateDocuments, readPdfPages } from './engine';
export { EngineError, type EngineErrorCode } from './errors';
export type {
  EngineAssets,
  EngineDependencies,
  GeneratedDocument,
  GenerationHandlers,
  GenerationJob,
  GenerationOptions,
  GenerationProgress,
  GenerationResult,
  ImageLoader,
  ImageProcessingRequest,
  ImageProcessor,
  OutputMode,
  ProcessedImage,
  RowFailure,
  RowFailureCode,
  RowReport,
  RowWarning,
  WarningCode,
} from './types';
export { imageToPdf } from './image-template';
