'use client';

/**
 * Audit ledger: every batch the institution (or Micro-Issuer) has dispatched, newest first, as a
 * shadcn/ui data table (TanStack Table): sortable columns, a filter by template, and an action
 * column with "1-Click Re-Issue".
 *
 * Re-Issue calls `POST /api/dispatch/reissue`: unclaimed recipients get fresh links through the
 * original channel, at no credit cost. The button explains itself when it cannot be used
 * (recipients purged, limit reached, cooldown, sending). The row updates from the response.
 */
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowUpDown, LoaderCircle, Mail, MessageCircle, RotateCw } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { daysUntilExpiry, isTokenExpired } from '@/lib/utils/tokenManager';
import { cn } from '@/lib/utils/cn';
import { MAX_REISSUES, reissueBlock, type IssuedBatchRow, type ReissueBlock } from '@/types/audit';

const DATE = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
});

const BLOCK_LABEL: Record<NonNullable<ReissueBlock>, string> = {
  purged: 'Recipients deleted',
  failed: 'Nothing delivered',
  limit: 'Limit reached',
  cooldown: 'Just re-issued',
  busy: 'Sending…',
};

type RowState = { pending?: boolean; message?: string; error?: boolean };

function ExpiryBadge({ row, now }: { row: IssuedBatchRow; now: number }) {
  const expired = isTokenExpired(row.tokenExpiry, now);
  const days = daysUntilExpiry(row.tokenExpiry, now);
  const label = row.purgedAt
    ? 'Purged'
    : expired
      ? 'Expired'
      : days <= 1
        ? 'Expires today'
        : `${days} days left`;
  const tone = row.purgedAt
    ? 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
    : expired
      ? 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300'
      : days <= 3
        ? 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200'
        : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200';
  return (
    <div className="flex flex-col gap-1">
      <span className={cn('w-fit rounded-full px-2 py-0.5 text-xs font-medium', tone)}>
        {label}
      </span>
      <span className="text-[11px] text-neutral-500">{DATE.format(row.tokenExpiry)}</span>
    </div>
  );
}

function SortButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-ml-1 inline-flex items-center gap-1 rounded px-1 hover:text-neutral-900 dark:hover:text-neutral-100"
    >
      {label}
      <ArrowUpDown className="size-3" aria-hidden />
    </button>
  );
}

export interface AuditLedgerProps {
  batches: readonly IssuedBatchRow[];
  /** The server's render time, so "days left" matches between server and browser. */
  renderedAt: number;
  className?: string;
}

export function AuditLedger({ batches, renderedAt, className }: AuditLedgerProps) {
  const [rows, setRows] = useState<IssuedBatchRow[]>(() => [...batches]);
  const [states, setStates] = useState<Record<string, RowState>>({});
  const [sorting, setSorting] = useState<SortingState>([{ id: 'dispatchedAt', desc: true }]);
  const [filter, setFilter] = useState('');
  const [now, setNow] = useState(renderedAt);

  async function reissue(batch: IssuedBatchRow) {
    setStates((all) => ({ ...all, [batch.id]: { pending: true } }));
    try {
      const response = await fetch('/api/dispatch/reissue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ batchId: batch.id }),
      });
      const body = (await response.json().catch(() => null)) as
        | { batch: IssuedBatchRow; recipients: number; sent: number; failed: number }
        | { error: { message: string } }
        | null;
      if (!response.ok || !body || 'error' in body) {
        throw new Error(
          body && 'error' in body ? body.error.message : 'The re-issue could not be sent.',
        );
      }
      setRows((all) => all.map((row) => (row.id === batch.id ? body.batch : row)));
      setNow(Date.now());
      setStates((all) => ({
        ...all,
        [batch.id]: {
          message: `Sent ${body.sent} of ${body.recipients} new link${body.recipients === 1 ? '' : 's'}${body.failed ? ` · ${body.failed} failed` : ''} · no credits used`,
        },
      }));
    } catch (error) {
      setStates((all) => ({
        ...all,
        [batch.id]: {
          error: true,
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  }

  const columns = useMemo<ColumnDef<IssuedBatchRow>[]>(
    () => [
      {
        accessorKey: 'dispatchedAt',
        header: ({ column }) => (
          <SortButton
            label="Dispatched"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          />
        ),
        cell: ({ row }) => DATE.format(row.original.dispatchedAt),
      },
      {
        accessorKey: 'templateName',
        header: 'Template',
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            {row.original.channel === 'whatsapp' ? (
              <MessageCircle className="size-4 text-emerald-600" aria-label="WhatsApp" />
            ) : (
              <Mail className="size-4 text-blue-600" aria-label="Email" />
            )}
            <span className="max-w-56 truncate font-medium">{row.original.templateName}</span>
          </div>
        ),
      },
      {
        accessorKey: 'recipientCount',
        header: ({ column }) => (
          <SortButton
            label="Recipients"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          />
        ),
        cell: ({ row }) => (
          <div className="tabular-nums">
            {row.original.recipientCount}
            <span className="ml-1 text-xs text-neutral-500">
              ({row.original.sentCount} sent
              {row.original.failedCount ? `, ${row.original.failedCount} failed` : ''})
            </span>
          </div>
        ),
      },
      {
        accessorKey: 'tokenExpiry',
        header: ({ column }) => (
          <SortButton
            label="Links"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          />
        ),
        cell: ({ row }) => <ExpiryBadge row={row.original} now={now} />,
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const batch = row.original;
          const state = states[batch.id] ?? {};
          const block = reissueBlock(batch, now);
          return (
            <div className="flex min-w-48 flex-col items-end gap-1">
              <button
                type="button"
                onClick={() => reissue(batch)}
                disabled={state.pending || block !== null}
                data-testid="reissue"
                data-batch-id={batch.id}
                title={block ? BLOCK_LABEL[block] : 'Send unclaimed recipients a fresh link'}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-neutral-300 px-3 text-xs font-medium hover:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700"
              >
                {state.pending ? (
                  <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <RotateCw className="size-3.5" aria-hidden />
                )}
                {block ? BLOCK_LABEL[block] : '1-Click Re-Issue'}
              </button>
              <span className="text-[11px] text-neutral-500 tabular-nums">
                {batch.reissueCount}/{MAX_REISSUES} re-issues · free
              </span>
              {state.message && (
                <span
                  role={state.error ? 'alert' : 'status'}
                  data-testid="reissue-status"
                  className={cn(
                    'max-w-56 text-right text-[11px] whitespace-normal',
                    state.error
                      ? 'text-red-700 dark:text-red-300'
                      : 'text-emerald-700 dark:text-emerald-300',
                  )}
                >
                  {state.message}
                </span>
              )}
            </div>
          );
        },
      },
    ],
    // `reissue` only uses state setters; rebuilding on `states` and `now` is enough.
    [states, now],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    globalFilterFn: (row, _columnId, value: string) =>
      row.original.templateName.toLowerCase().includes(value.trim().toLowerCase()),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getRowId: (row) => row.id,
  });

  return (
    <div className={cn('flex flex-col gap-3', className)} data-testid="audit-ledger">
      <input
        type="search"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filter by template…"
        aria-label="Filter batches by template"
        className="h-10 w-full max-w-xs rounded-xl border border-neutral-300 bg-transparent px-3 text-sm focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-none dark:border-neutral-700"
      />
      <Table>
        <TableCaption>
          Claim links stay valid until their expiry; recipients are deleted 30 days later.
        </TableCaption>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead
                  key={header.id}
                  aria-sort={
                    header.column.getIsSorted() === 'asc'
                      ? 'ascending'
                      : header.column.getIsSorted() === 'desc'
                        ? 'descending'
                        : undefined
                  }
                  className={header.id === 'actions' ? 'text-right' : undefined}
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id} data-testid="ledger-row" data-batch-id={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center text-neutral-500">
                {rows.length ? 'No batches match the filter.' : 'No batches dispatched yet.'}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
