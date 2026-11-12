'use client';

/**
 * Preview ➔ Audit ➔ Confirm for a parsed CSV: shows the headers and the first 5 rows, and flags in
 * red any column the template needs that the file lacks. Confirm stays disabled until every
 * required column is present.
 */
import { AlertTriangle } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  dialogButton,
} from '@/components/ui/dialog';
import { checkHeaders, MAX_CSV_ROWS, type ParsedCsv } from '@/lib/utils/csv';

export interface CsvPreviewModalProps {
  /** The parsed file (see `parseCsvFile`). The modal is open while this is set. */
  data: ParsedCsv | null;
  fileName?: string;
  /** Column headers the template needs. */
  requiredHeaders: string[];
  onConfirm: (data: ParsedCsv) => void;
  onCancel: () => void;
}

const PREVIEW_ROWS = 5;

export function CsvPreviewModal({
  data,
  fileName,
  requiredHeaders,
  onConfirm,
  onCancel,
}: CsvPreviewModalProps) {
  const { missing, nearMatches } = checkHeaders(data?.headers ?? [], requiredHeaders);
  const required = new Set(requiredHeaders);
  const tooMany = (data?.rows.length ?? 0) > MAX_CSV_ROWS;
  const empty = data !== null && data.rows.length === 0;
  const blocked = missing.length > 0 || tooMany || empty;

  return (
    <Dialog open={data !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-testid="csv-preview-modal" className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Check your data</DialogTitle>
          <DialogDescription>
            {fileName ? `${fileName} · ` : ''}
            {data?.rows.length ?? 0} rows · {data?.headers.length ?? 0} columns. First{' '}
            {PREVIEW_ROWS} rows shown.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4 sm:px-6">
          {missing.length > 0 && (
            <div
              role="alert"
              data-testid="missing-headers"
              className="flex gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div>
                <p className="font-medium">
                  Missing required {missing.length === 1 ? 'column' : 'columns'}:
                </p>
                <ul className="mt-1 list-disc pl-5">
                  {missing.map((header) => (
                    <li key={header}>
                      <strong>{header}</strong>
                      {nearMatches[header] && (
                        <> — found “{nearMatches[header]}”; check spelling and capitals</>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {tooMany && (
            <p
              role="alert"
              className="rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
            >
              The file has {data?.rows.length} rows; the limit is {MAX_CSV_ROWS}. Split it into
              smaller files.
            </p>
          )}
          {empty && (
            <p
              role="alert"
              className="rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
            >
              The file has a header row but no data.
            </p>
          )}
          {data && data.errors.length > 0 && (
            <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              <p className="font-medium">Some rows look malformed:</p>
              <ul className="mt-1 list-disc pl-5">
                {data.errors.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </div>
          )}

          {data && data.headers.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
              <table className="w-full text-left text-sm">
                <thead className="bg-neutral-50 dark:bg-neutral-900">
                  <tr>
                    {data.headers.map((header) => (
                      <th
                        key={header}
                        scope="col"
                        className="px-3 py-2 font-medium whitespace-nowrap"
                        data-required={required.has(header) || undefined}
                      >
                        {header}
                        {required.has(header) && (
                          <span className="ml-1 text-green-600" aria-label="required, found">
                            ✓
                          </span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.slice(0, PREVIEW_ROWS).map((row, index) => (
                    <tr
                      key={index}
                      data-testid="csv-preview-row"
                      className="border-t border-neutral-200 dark:border-neutral-800"
                    >
                      {data.headers.map((header) => (
                        <td
                          key={header}
                          className="max-w-56 truncate px-3 py-2 whitespace-nowrap"
                          title={row[header]}
                        >
                          {row[header] || <span className="text-neutral-400">—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <DialogFooter>
          <button type="button" onClick={onCancel} className={dialogButton.secondary}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="csv-confirm"
            onClick={() => data && onConfirm(data)}
            disabled={blocked}
            className={dialogButton.primary}
          >
            Use this data
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
