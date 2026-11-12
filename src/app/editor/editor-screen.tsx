'use client';

/**
 * The editor screen: the sample template on the Tap-to-Place canvas, a preview-row switcher and a
 * "Test PDF" button that generates the previewed row in the PDF Web Worker from the store's
 * template as it stands — the proof that what is placed on screen is what is printed.
 *
 * Until template upload and storage are wired (later phases), it edits the playground's sample.
 */
import { ChevronLeft, ChevronRight, FileDown, LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { AiMagicButton } from '@/components/canvas/AiMagicButton';
import { MobileEditor } from '@/components/canvas/MobileEditor';
import { PropertyBar } from '@/components/canvas/PropertyBar';
import { SmartAuditCarousel } from '@/components/canvas/SmartAuditCarousel';
import { createPdfEngineClient, saveBlob, type PdfEngineClient } from '@/lib/pdfEngine';
import { cn } from '@/lib/utils/cn';
import { useTemplateStore } from '@/store/templateStore';

import {
  SAMPLE_FONT_URLS,
  SAMPLE_ROWS,
  SAMPLE_TEMPLATE,
  SAMPLE_TEMPLATE_URL,
} from '../playground/sample';

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  return response.arrayBuffer();
}

export function EditorScreen() {
  const loadTemplate = useTemplateStore((state) => state.loadTemplate);
  const loaded = useTemplateStore((state) => state.activeTemplate !== null);
  const rowCount = useTemplateStore((state) => state.dataRows.length);
  const hasSelection = useTemplateStore((state) => state.selectedPlaceholderId !== null);
  const [rowIndex, setRowIndex] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const engine = useRef<PdfEngineClient | null>(null);

  useEffect(() => {
    loadTemplate(SAMPLE_TEMPLATE, SAMPLE_ROWS);
    return () => {
      engine.current?.dispose();
      engine.current = null;
      useTemplateStore.getState().reset();
    };
  }, [loadTemplate]);

  async function exportTestPdf() {
    const { activeTemplate, dataRows } = useTemplateStore.getState();
    const row = dataRows[rowIndex];
    if (!activeTemplate || !row) return;
    setExporting(true);
    setMessage(null);
    try {
      const fontIds = Object.keys(SAMPLE_FONT_URLS);
      const [templatePdf, ...fontFiles] = await Promise.all([
        fetchBytes(SAMPLE_TEMPLATE_URL),
        ...fontIds.map((id) => fetchBytes(SAMPLE_FONT_URLS[id]!)),
      ]);
      engine.current ??= createPdfEngineClient();
      let saved = false;
      const job = engine.current.generate(
        {
          template: activeTemplate,
          assets: {
            templatePdf: templatePdf!,
            fonts: Object.fromEntries(fontIds.map((id, index) => [id, fontFiles[index]!])),
          },
          rows: [row],
          options: { mode: 'separate' },
        },
        {
          onDocument(document) {
            saved = true;
            saveBlob(
              new Blob([document.bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }),
              document.fileName,
            );
          },
        },
      );
      const result = await job.result;
      const warnings = result.problemRows.reduce((sum, report) => sum + report.warnings.length, 0);
      setMessage(
        saved
          ? `Test PDF ready${warnings ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : ''}.`
          : 'This row could not be generated.',
      );
    } catch (error) {
      console.error(error);
      setMessage('The test PDF could not be generated.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className={cn('min-h-dvh bg-neutral-50 dark:bg-neutral-950', hasSelection && 'pb-80')}>
      <header className="sticky top-0 z-30 border-b border-neutral-200 bg-white/90 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-3 py-2">
          <Link
            href="/dashboard/issue"
            aria-label="Back to Issue Credentials"
            className="rounded-full p-2 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <ChevronLeft className="size-5" aria-hidden />
          </Link>
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold">Sample certificate</h1>
          <div
            className="flex items-center rounded-xl bg-neutral-100 dark:bg-neutral-900"
            role="group"
            aria-label="Preview row"
          >
            <button
              type="button"
              aria-label="Previous row"
              disabled={rowIndex === 0}
              onClick={() => setRowIndex((index) => Math.max(0, index - 1))}
              className="rounded-l-xl p-2 disabled:opacity-40"
            >
              <ChevronLeft className="size-4" aria-hidden />
            </button>
            <span className="min-w-12 text-center text-xs tabular-nums" data-testid="preview-row">
              {rowCount ? `${rowIndex + 1}/${rowCount}` : '–'}
            </span>
            <button
              type="button"
              aria-label="Next row"
              disabled={rowIndex >= rowCount - 1}
              onClick={() => setRowIndex((index) => Math.min(rowCount - 1, index + 1))}
              className="rounded-r-xl p-2 disabled:opacity-40"
            >
              <ChevronRight className="size-4" aria-hidden />
            </button>
          </div>
          <button
            type="button"
            onClick={exportTestPdf}
            disabled={!loaded || exporting}
            data-testid="export-test-pdf"
            className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {exporting ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
            ) : (
              <FileDown className="size-4" aria-hidden />
            )}
            <span className="hidden min-[400px]:inline">Test PDF</span>
            <span className="sr-only min-[400px]:hidden">Download a test PDF</span>
          </button>
        </div>
        {message && (
          <p
            role="status"
            data-testid="export-status"
            className="mx-auto max-w-3xl px-4 pb-2 text-xs text-neutral-600 dark:text-neutral-400"
          >
            {message}
          </p>
        )}
      </header>
      <div className="px-3 py-4">
        <MobileEditor
          pdf={SAMPLE_TEMPLATE_URL}
          fontUrls={SAMPLE_FONT_URLS}
          previewRowIndex={rowIndex}
        />
      </div>
      <section aria-label="Data" className="mx-auto flex max-w-3xl flex-col gap-3 px-3 pb-6">
        <div className="flex flex-wrap gap-2">
          <AiMagicButton />
          <button
            type="button"
            aria-expanded={reviewing}
            onClick={() => setReviewing((open) => !open)}
            disabled={rowCount === 0}
            data-testid="review-data"
            className="inline-flex min-h-11 items-center rounded-xl border border-neutral-300 px-4 text-sm hover:border-neutral-500 disabled:opacity-50 dark:border-neutral-700"
          >
            {reviewing ? 'Hide data review' : 'Review data'}
          </button>
        </div>
        {reviewing && <SmartAuditCarousel row={rowIndex} onRowChange={setRowIndex} />}
      </section>
      <PropertyBar />
    </div>
  );
}
