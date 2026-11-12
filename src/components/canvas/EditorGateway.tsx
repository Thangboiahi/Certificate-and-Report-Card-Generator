'use client';

/**
 * What `/editor` shows until a template is loaded: choose the document background (PDF, PNG or
 * JPG) and, optionally, the data (CSV). A CSV chosen first is kept and turned into fields when the
 * template arrives. Everything stays in the browser; nothing is uploaded here.
 */
import { CheckCircle2, FileSpreadsheet, FileText, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { UniversalUploadZone, type ConfirmedUpload } from '@/components/ui/UniversalUploadZone';
import { buildStarterTemplate } from '@/lib/editor/starter-template';
import type { DataRow, TemplateDefinition } from '@/lib/template';
import { notifyError } from '@/lib/ui/notify';
import type { ParsedCsv } from '@/lib/utils/csv';

/** What the editor needs besides the store: the background and the fonts the preview loads. */
export interface EditorSession {
  /** Same-origin URL (the built-in sample) or the PDF bytes. */
  pdf: string | ArrayBuffer;
  fontUrls: Record<string, string>;
}

export interface EditorGatewayProps {
  onLoaded(session: EditorSession, template: TemplateDefinition, rows: DataRow[]): void;
  /** Opens the built-in demo certificate instead. */
  onSample(): void;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Turns the chosen file into PDF bytes plus the template that describes it. */
async function templateFromFile(
  file: File,
  columns: string[],
): Promise<{ pdf: ArrayBuffer; template: TemplateDefinition }> {
  const { imageToPdf, readPdfPages } = await import('@/lib/pdf-engine');
  const original = await file.arrayBuffer();
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const bytes: ArrayBuffer = isPdf
    ? original
    : ((await imageToPdf(original, file.type === 'image/png' ? 'image/png' : 'image/jpeg'))
        .buffer as ArrayBuffer);
  const pages = await readPdfPages(bytes);
  if (pages.length === 0) throw new Error('That PDF has no pages.');
  const sha256 = await sha256Hex(bytes);
  return {
    pdf: bytes,
    template: buildStarterTemplate({
      source: { fileName: file.name, byteSize: file.size, sha256 },
      pages,
      columns,
    }),
  };
}

function templateProblem(cause: unknown): string {
  const code = (cause as { code?: string } | null)?.code;
  if (code === 'TEMPLATE_PDF_ENCRYPTED')
    return 'That PDF is password-protected. Remove the password and try again.';
  if (code === 'TEMPLATE_PDF_UNREADABLE')
    return 'That file could not be read. Try exporting it again as a PDF, PNG or JPG.';
  return 'That file could not be used as a template.';
}

export function EditorGateway({ onLoaded, onSample }: EditorGatewayProps) {
  const [csv, setCsv] = useState<{ fileName: string; data: ParsedCsv } | null>(null);
  const [busy, setBusy] = useState(false);

  async function chooseTemplate(file: File) {
    setBusy(true);
    try {
      const { pdf, template } = await templateFromFile(file, csv?.data.headers ?? []);
      onLoaded({ pdf, fontUrls: {} }, template, csv?.data.rows ?? []);
    } catch (cause) {
      notifyError(cause, templateProblem(cause));
    } finally {
      setBusy(false);
    }
  }

  function onUpload(upload: ConfirmedUpload) {
    if (upload.kind === 'template') void chooseTemplate(upload.file);
    else if (upload.kind === 'csv') setCsv({ fileName: upload.file.name, data: upload.data });
  }

  return (
    <main
      data-testid="editor-gateway"
      className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-6 px-4 py-8"
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Start a template</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Upload the blank certificate, card or report your fields will sit on. Your files stay in
          this browser.
        </p>
      </div>

      <section aria-labelledby="gateway-template" className="flex flex-col gap-2">
        <h2 id="gateway-template" className="flex items-center gap-2 text-sm font-medium">
          <FileText className="size-4" aria-hidden /> 1. Template
        </h2>
        {csv && !busy && (
          <p
            role="status"
            data-testid="gateway-need-template"
            className="text-sm text-blue-700 dark:text-blue-400"
          >
            Your data is ready. Choose a template below to open the editor.
          </p>
        )}
        {busy && (
          <p role="status" className="text-sm text-neutral-600 dark:text-neutral-400">
            Opening your template…
          </p>
        )}
        <UniversalUploadZone
          accept={['template']}
          label="Tap to choose your template, or drop it here"
          disabled={busy}
          onConfirm={onUpload}
        />
      </section>

      <section aria-labelledby="gateway-data" className="flex flex-col gap-2">
        <h2 id="gateway-data" className="flex items-center gap-2 text-sm font-medium">
          <FileSpreadsheet className="size-4" aria-hidden /> 2. Data{' '}
          <span className="font-normal text-neutral-500">(optional, can be added later)</span>
        </h2>
        {csv && (
          <p
            role="status"
            data-testid="gateway-csv"
            className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400"
          >
            <CheckCircle2 className="size-4 shrink-0" aria-hidden />
            {csv.fileName}: {csv.data.rows.length} rows, {csv.data.headers.length} columns
          </p>
        )}
        <UniversalUploadZone
          accept={['csv']}
          label={csv ? 'Choose a different CSV' : 'Tap to choose your CSV, or drop it here'}
          disabled={busy}
          onConfirm={onUpload}
        />
      </section>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <button
          type="button"
          onClick={onSample}
          data-testid="use-sample"
          className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-neutral-300 px-4 hover:border-neutral-500 dark:border-neutral-700"
        >
          <Sparkles className="size-4" aria-hidden /> Try the sample certificate
        </button>
        <Link
          href="/dashboard/issue"
          className="text-neutral-600 underline-offset-2 hover:underline dark:text-neutral-400"
        >
          Back to Issue Credentials
        </Link>
      </div>
    </main>
  );
}
