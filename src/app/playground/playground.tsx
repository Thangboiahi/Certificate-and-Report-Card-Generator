'use client';

/**
 * Developer playground: runs the real engine, in the real Web Worker, on a bundled sample job.
 *
 * It is a harness, not product UI — the place to see the engine work end to end in a browser
 * (Worker bundling, comlink, the image proxy, canvas image processing) and to try it on a phone.
 * `scripts/e2e-playground.mjs` drives this page in Chromium and relies on the `data-testid`s.
 */
import { useEffect, useRef, useState } from 'react';

import type { GenerationProgress, GenerationResult, OutputMode, RowReport } from '@/lib/pdf-engine';
import type { DataRow } from '@/lib/template';
import {
  createPdfEngineClient,
  type GenerationJobHandle,
  type PdfEngineClient,
} from '@/workers/pdf-engine.client';

import { SAMPLE_FONT_URLS, SAMPLE_ROWS, SAMPLE_TEMPLATE, SAMPLE_TEMPLATE_URL } from './sample';

/** Only the first few files get a link; a large batch must not be kept in memory. */
const MAX_LINKED_FILES = 8;

const BATCH_SIZES = [
  { copies: 1, label: `${SAMPLE_ROWS.length} rows` },
  { copies: 10, label: `${SAMPLE_ROWS.length * 10} rows` },
  { copies: 50, label: `${SAMPLE_ROWS.length * 50} rows` },
];

interface LinkedFile {
  fileName: string;
  url: string;
  pageCount: number;
  byteLength: number;
}

interface RunOutcome {
  result: GenerationResult;
  fileCount: number;
  totalBytes: number;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'running'; progress: GenerationProgress | null }
  | { kind: 'done'; outcome: RunOutcome }
  | { kind: 'error'; message: string; details: string[] };

interface Assets {
  templatePdf: ArrayBuffer;
  fonts: Record<string, ArrayBuffer>;
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (HTTP ${response.status}).`);
  return response.arrayBuffer();
}

async function loadAssets(): Promise<Assets> {
  const fontIds = Object.keys(SAMPLE_FONT_URLS);
  const [templatePdf, ...fontFiles] = await Promise.all([
    fetchBytes(SAMPLE_TEMPLATE_URL),
    ...fontIds.map((id) => fetchBytes(SAMPLE_FONT_URLS[id] as string)),
  ]);
  return {
    templatePdf: templatePdf as ArrayBuffer,
    fonts: Object.fromEntries(fontIds.map((id, index) => [id, fontFiles[index] as ArrayBuffer])),
  };
}

/** Repeats the sample rows to simulate a larger batch, keeping roll numbers and ids unique. */
function buildRows(copies: number): DataRow[] {
  return Array.from({ length: copies }).flatMap((_, copy) =>
    SAMPLE_ROWS.map((row) =>
      copy === 0 ? row : { ...row, Roll: `${row.Roll}-${copy + 1}`, ID: `${row.ID}-${copy + 1}` },
    ),
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function Playground() {
  const [mode, setMode] = useState<OutputMode>('separate');
  const [copies, setCopies] = useState(1);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [files, setFiles] = useState<LinkedFile[]>([]);

  const engine = useRef<PdfEngineClient | null>(null);
  const assets = useRef<Promise<Assets> | null>(null);
  const job = useRef<GenerationJobHandle | null>(null);
  const objectUrls = useRef<string[]>([]);

  useEffect(() => {
    const urls = objectUrls;
    return () => {
      engine.current?.dispose();
      engine.current = null;
      for (const url of urls.current) URL.revokeObjectURL(url);
    };
  }, []);

  async function generate() {
    for (const url of objectUrls.current) URL.revokeObjectURL(url);
    objectUrls.current = [];
    setFiles([]);
    setStatus({ kind: 'running', progress: null });

    let fileCount = 0;
    let totalBytes = 0;

    try {
      engine.current ??= createPdfEngineClient();
      assets.current ??= loadAssets();
      const { templatePdf, fonts } = await assets.current;

      job.current = engine.current.generate(
        {
          template: SAMPLE_TEMPLATE,
          assets: { templatePdf, fonts },
          rows: buildRows(copies),
          options: {
            mode,
            mergedFileName: 'Class 10 - certificates and reports',
            rowsPerFile: 100,
          },
        },
        {
          onDocument(document) {
            fileCount += 1;
            totalBytes += document.bytes.byteLength;
            if (fileCount > MAX_LINKED_FILES) return;
            const blob = new Blob([document.bytes as Uint8Array<ArrayBuffer>], {
              type: 'application/pdf',
            });
            const url = URL.createObjectURL(blob);
            objectUrls.current.push(url);
            setFiles((current) => [
              ...current,
              {
                fileName: document.fileName,
                url,
                pageCount: document.pageCount,
                byteLength: document.bytes.byteLength,
              },
            ]);
          },
          onProgress(progress) {
            setStatus({ kind: 'running', progress });
          },
        },
      );

      const result = await job.current.result;
      setStatus({ kind: 'done', outcome: { result, fileCount, totalBytes } });
    } catch (error) {
      const details =
        error instanceof Error && 'details' in error && Array.isArray(error.details)
          ? (error.details as string[])
          : [];
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
        details,
      });
    } finally {
      job.current = null;
    }
  }

  const running = status.kind === 'running';
  const progress = running ? status.progress : null;
  const outcome = status.kind === 'done' ? status.outcome : null;
  const totalRows = SAMPLE_ROWS.length * copies;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:py-12">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-medium tracking-widest text-neutral-500 uppercase">
          Developer playground
        </p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">PDF generation engine</h1>
        <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          Generates a two-page certificate and progress report for each sample student, entirely in
          this browser. The sample covers Hindi text, a large photo, a sideways phone photo, a WebP
          image, an image fetched through the proxy, a missing photo and a dead link.
        </p>
      </header>

      <section className="flex flex-col gap-4 rounded-2xl border border-neutral-200 p-4 dark:border-neutral-800">
        <fieldset className="flex flex-col gap-2" disabled={running}>
          <legend className="mb-2 text-sm font-medium">Output</legend>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ['separate', 'One PDF per student'],
                ['merged', 'One PDF to print'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                data-testid={`mode-${value}`}
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
                className={`rounded-xl border px-3 py-2.5 text-sm transition-colors ${
                  mode === value
                    ? 'border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900'
                    : 'border-neutral-300 hover:border-neutral-500 dark:border-neutral-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2" disabled={running}>
          <legend className="mb-2 text-sm font-medium">Batch size</legend>
          <div className="grid grid-cols-3 gap-2">
            {BATCH_SIZES.map((size) => (
              <button
                key={size.copies}
                type="button"
                data-testid={`copies-${size.copies}`}
                aria-pressed={copies === size.copies}
                onClick={() => setCopies(size.copies)}
                className={`rounded-xl border px-3 py-2.5 text-sm transition-colors ${
                  copies === size.copies
                    ? 'border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900'
                    : 'border-neutral-300 hover:border-neutral-500 dark:border-neutral-700'
                }`}
              >
                {size.label}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="flex gap-2">
          <button
            type="button"
            data-testid="generate"
            onClick={generate}
            disabled={running}
            className="flex-1 rounded-xl bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {running ? 'Generating…' : 'Generate'}
          </button>
          {running && (
            <button
              type="button"
              data-testid="cancel"
              onClick={() => job.current?.cancel()}
              className="rounded-xl border border-neutral-300 px-4 py-3 text-sm dark:border-neutral-700"
            >
              Cancel
            </button>
          )}
        </div>

        <div aria-live="polite" data-testid="status" data-status={status.kind} className="text-sm">
          {running && (
            <div className="flex flex-col gap-2">
              <div className="h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                <div
                  className="h-full rounded-full bg-blue-600 transition-[width] duration-150"
                  style={{ width: `${((progress?.completedRows ?? 0) / totalRows) * 100}%` }}
                />
              </div>
              <p className="text-neutral-600 dark:text-neutral-400">
                {progress
                  ? `${progress.completedRows} of ${progress.totalRows} rows`
                  : 'Loading the template and fonts…'}
              </p>
            </div>
          )}
          {status.kind === 'error' && (
            <div className="rounded-xl bg-red-50 p-3 text-red-800 dark:bg-red-950 dark:text-red-200">
              <p className="font-medium" data-testid="error">
                {status.message}
              </p>
              {status.details.length > 0 && (
                <ul className="mt-2 list-disc pl-5">
                  {status.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </section>

      {outcome && <Summary outcome={outcome} />}
      {outcome && outcome.result.problemRows.length > 0 && (
        <ProblemRows rows={outcome.result.problemRows} />
      )}
      {files.length > 0 && <Files files={files} total={outcome?.fileCount ?? files.length} />}
    </div>
  );
}

function Summary({ outcome }: { outcome: RunOutcome }) {
  const { result, fileCount, totalBytes } = outcome;
  const seconds = result.durationMs / 1000;
  const facts: Array<[string, string]> = [
    ['Rows', `${result.succeededRows} of ${result.totalRows}`],
    ['Files', String(fileCount)],
    ['Size', formatBytes(totalBytes)],
    ['Time', `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`],
    ['Speed', `${(result.succeededRows / Math.max(seconds, 0.001)).toFixed(0)} rows/s`],
  ];
  return (
    <section
      data-testid="summary"
      data-succeeded={result.succeededRows}
      data-failed={result.failedRows}
      data-files={fileCount}
      data-bytes={totalBytes}
      data-cancelled={result.cancelled}
      className="rounded-2xl border border-neutral-200 p-4 dark:border-neutral-800"
    >
      <h2 className="mb-3 text-sm font-medium">
        {result.cancelled
          ? 'Cancelled'
          : result.failedRows > 0
            ? 'Finished with failed rows'
            : 'Finished'}
      </h2>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {facts.map(([term, value]) => (
          <div key={term}>
            <dt className="text-xs text-neutral-500">{term}</dt>
            <dd className="text-base font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ProblemRows({ rows }: { rows: RowReport[] }) {
  const shown = rows.slice(0, 20);
  return (
    <section
      data-testid="problem-rows"
      className="rounded-2xl border border-neutral-200 p-4 dark:border-neutral-800"
    >
      <h2 className="mb-3 text-sm font-medium">Rows to check ({rows.length})</h2>
      <ul className="flex flex-col gap-2 text-sm">
        {shown.map((row) => (
          <li key={row.rowIndex} data-testid="problem-row" className="flex gap-3">
            <span className="w-14 shrink-0 text-neutral-500 tabular-nums">
              Row {row.rowIndex + 1}
            </span>
            <span className="flex flex-col gap-1">
              {row.failure && (
                <span className="text-red-700 dark:text-red-300">
                  Skipped: {row.failure.message}
                </span>
              )}
              {row.warnings.map((warning) => (
                <span key={`${warning.placeholderId}-${warning.code}`} data-code={warning.code}>
                  {warning.message}
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
      {rows.length > shown.length && (
        <p className="mt-2 text-xs text-neutral-500">…and {rows.length - shown.length} more.</p>
      )}
    </section>
  );
}

function Files({ files, total }: { files: LinkedFile[]; total: number }) {
  const [first] = files;
  return (
    <section className="rounded-2xl border border-neutral-200 p-4 dark:border-neutral-800">
      <h2 className="mb-3 text-sm font-medium">Files</h2>
      <ul className="flex flex-col divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
        {files.map((file) => (
          <li key={file.url} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0 truncate">{file.fileName}</span>
            <span className="flex shrink-0 items-center gap-3 text-neutral-500">
              <span className="tabular-nums">
                {file.pageCount} {file.pageCount === 1 ? 'page' : 'pages'} ·{' '}
                {formatBytes(file.byteLength)}
              </span>
              <a
                data-testid="file-link"
                href={file.url}
                download={file.fileName}
                className="font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                Save
              </a>
              <a
                href={file.url}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                Open
              </a>
            </span>
          </li>
        ))}
      </ul>
      {total > files.length && (
        <p className="mt-2 text-xs text-neutral-500">
          Showing the first {files.length} of {total} files. The rest were generated and released
          from memory.
        </p>
      )}
      {first && (
        <iframe
          title={`Preview of ${first.fileName}`}
          src={first.url}
          className="mt-4 hidden h-[32rem] w-full rounded-xl border border-neutral-200 sm:block dark:border-neutral-800"
        />
      )}
    </section>
  );
}
