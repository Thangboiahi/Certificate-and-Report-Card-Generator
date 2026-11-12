/**
 * Displays template pages in the editor with pdf.js (browser only).
 *
 * pdf.js is loaded on first use — it is ~1 MB and only the editor needs it — and parses PDFs in
 * its own Web Worker (`src/workers/pdfjs.worker.ts`), so the page stays responsive on phones.
 *
 * At scale 1, a pdf.js viewport is the page as displayed (its /Rotate and CropBox applied) in PDF
 * points, which is exactly the template's page space (ADR-003). `pageSize` reports it so the editor
 * can confirm the file matches the stored `TemplateDefinition.pages`.
 */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

import type { TemplatePage } from '@/lib/template';

type PdfJs = typeof import('pdfjs-dist');

let pdfjs: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= import('pdfjs-dist').then((module) => {
    module.GlobalWorkerOptions.workerPort ??= new Worker(
      new URL('../../workers/pdfjs.worker.ts', import.meta.url),
      { type: 'module' },
    );
    return module;
  });
  // A failed load (offline, blocked chunk) may be retried later.
  pdfjs.catch(() => {
    pdfjs = null;
  });
  return pdfjs;
}

export type { PDFDocumentProxy, PDFPageProxy };

export interface PreviewDocumentHandle {
  /** Settles with the opened document. */
  promise: Promise<PDFDocumentProxy>;
  /** Stops loading, or releases the opened document and its worker-side resources. */
  destroy(): void;
}

/** Opens a PDF from a same-origin URL or from its bytes. Call `destroy()` when done. */
export function openPreviewDocument(source: string | ArrayBuffer): PreviewDocumentHandle {
  const task = loadPdfJs().then((library) =>
    // pdf.js takes ownership of (detaches) the buffer it is given: pass a copy.
    library.getDocument(
      typeof source === 'string' ? { url: source } : { data: new Uint8Array(source.slice(0)) },
    ),
  );
  return {
    promise: task.then((loading) => loading.promise),
    destroy: () => void task.then((loading) => loading.destroy()).catch(() => undefined),
  };
}

/** The page's displayed size in points (rotation and crop box applied). */
export function pageSize(page: PDFPageProxy): TemplatePage {
  const viewport = page.getViewport({ scale: 1 });
  return { width: viewport.width, height: viewport.height };
}

/**
 * Renders a page into a canvas `cssWidth` CSS pixels wide, sharp on high-density screens. The
 * pixel ratio is capped so a large page cannot exhaust a phone's canvas memory. Resolves when
 * drawn; rejects with a `RenderingCancelledException` if `signal` aborts first.
 */
export async function renderPageToCanvas(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  signal: AbortSignal,
): Promise<void> {
  const base = page.getViewport({ scale: 1 });
  const maxCanvasSide = 4096;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 3);
  const scale = Math.min(
    (cssWidth * pixelRatio) / base.width,
    maxCanvasSide / Math.max(base.width, base.height),
  );
  const viewport = page.getViewport({ scale });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const task = page.render({ canvas, viewport });
  const abort = () => task.cancel();
  signal.addEventListener('abort', abort, { once: true });
  try {
    await task.promise;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
