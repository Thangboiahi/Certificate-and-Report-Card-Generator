'use client';

/**
 * Smart Audit: a swipeable review of the dataset before it is dispatched or generated, with a chat
 * box that applies bulk fixes in plain language ("Capitalize names", "Trim extra spaces").
 *
 * One card per row (only the visible one and its neighbours are mounted, so 2,500 rows stay light).
 * Cards flag cells that usually print badly: empty, stray spaces, ALL CAPS or all lower-case words.
 * A command goes to Gemini via `/api/ai/audit`; the validated patch is applied to the store, so the
 * card and the canvas change at once, and the last change can be undone.
 */
import { AlertTriangle, ChevronLeft, ChevronRight, LoaderCircle, Send, Undo2 } from 'lucide-react';
import { AnimatePresence, MotionConfig, motion, type PanInfo } from 'framer-motion';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { AiError, processAiAuditCommand } from '@/lib/ai/geminiClient';
import { cellText, columnsOf, type ApplyReport } from '@/lib/ai/schema';
import type { DataRow } from '@/lib/template';
import { cn } from '@/lib/utils/cn';
import { useTemplateStore } from '@/store/templateStore';

const SWIPE_DISTANCE = 60;
const SWIPE_VELOCITY = 400;
const SUGGESTIONS = ['Capitalize names', 'Trim extra spaces', 'Make all text uppercase'] as const;

export type CellIssue = 'empty' | 'spaces' | 'upper' | 'lower';

const ISSUE_LABEL: Record<CellIssue, string> = {
  empty: 'Empty',
  spaces: 'Extra spaces',
  upper: 'ALL CAPS',
  lower: 'all lower case',
};

/** Cheap checks for values that tend to print badly. Exported for tests. */
export function auditCell(value: DataRow[string]): CellIssue | null {
  const text = cellText(value);
  if (text.trim() === '') return 'empty';
  if (text !== text.trim() || /\s{2,}/.test(text)) return 'spaces';
  // Codes and IDs ("CERT-2026-0101", "10-A") are meant to be upper case: only judge plain words.
  if (/\d/.test(text)) return null;
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (
    letters.length >= 4 &&
    letters !== letters.toLocaleLowerCase() &&
    letters === letters.toLocaleUpperCase()
  )
    return 'upper';
  if (
    letters.length >= 4 &&
    letters !== letters.toLocaleUpperCase() &&
    letters === letters.toLocaleLowerCase()
  )
    return 'lower';
  return null;
}

interface ChatEntry {
  id: number;
  command: string;
  text: string;
  kind: 'done' | 'error';
  canUndo: boolean;
}

function describe(report: ApplyReport): string {
  const parts = [
    report.cellsChanged
      ? `${report.cellsChanged} cell${report.cellsChanged === 1 ? '' : 's'} changed`
      : '',
    report.placeholdersChanged
      ? `${report.placeholdersChanged} field style${report.placeholdersChanged === 1 ? '' : 's'} changed`
      : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Nothing needed changing';
}

export interface SmartAuditCarouselProps {
  className?: string;
  /** Shown as the primary action under the cards when set (e.g. "Generate"). */
  confirmLabel?: string;
  onConfirm?: () => void;
  /** The row on screen, when the parent owns it (e.g. a canvas preview switcher). */
  row?: number;
  /** Fired when the person moves to another row, so a canvas preview can follow. */
  onRowChange?: (index: number) => void;
}

export function SmartAuditCarousel({
  className,
  confirmLabel,
  onConfirm,
  row: controlledRow,
  onRowChange,
}: SmartAuditCarouselProps) {
  const dataRows = useTemplateStore((state) => state.dataRows);
  const columns = useMemo(() => columnsOf(dataRows, 200), [dataRows]);
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<ChatEntry[]>([]);
  const undo = useRef<{
    id: number;
    snapshot: {
      dataRows: DataRow[];
      activeTemplate: ReturnType<typeof useTemplateStore.getState>['activeTemplate'];
    };
  } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const entryId = useRef(0);
  const inputId = useId();

  const last = Math.max(dataRows.length - 1, 0);
  const current = Math.min(controlledRow ?? index, last);

  useEffect(() => () => abort.current?.abort(), []);

  const go = useCallback(
    (to: number) => {
      const next = Math.min(Math.max(to, 0), last);
      setDirection(next >= current ? 1 : -1);
      setIndex(next);
      onRowChange?.(next);
    },
    [current, last, onRowChange],
  );

  function onKeyDown(event: React.KeyboardEvent) {
    if ((event.target as HTMLElement).tagName === 'INPUT') return;
    if (event.key === 'ArrowLeft') go(current - 1);
    if (event.key === 'ArrowRight') go(current + 1);
  }

  function onDragEnd(_event: unknown, info: PanInfo) {
    if (info.offset.x < -SWIPE_DISTANCE || info.velocity.x < -SWIPE_VELOCITY) go(current + 1);
    else if (info.offset.x > SWIPE_DISTANCE || info.velocity.x > SWIPE_VELOCITY) go(current - 1);
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setCommand('');
    const id = ++entryId.current;
    try {
      const state = useTemplateStore.getState();
      const patch = await processAiAuditCommand(
        trimmed,
        {
          dataRows: state.dataRows,
          placeholders: state.activeTemplate?.placeholders ?? [],
          focusRow: current,
        },
        { signal: controller.signal },
      );
      // Re-read: the person may have edited while the AI was thinking. Apply to what is there now.
      const before = useTemplateStore.getState();
      const snapshot = { dataRows: before.dataRows, activeTemplate: before.activeTemplate };
      const report = before.applyAiPatch(patch);
      const changed = report.cellsChanged + report.placeholdersChanged > 0;
      if (changed) undo.current = { id, snapshot };
      setLog((entries) => [
        ...entries.slice(-9),
        {
          id,
          command: trimmed,
          kind: 'done',
          canUndo: changed,
          text: `${patch.summary || 'Done.'} — ${describe(report)}${report.skipped.length ? ` (${report.skipped.length} skipped)` : ''}.`,
        },
      ]);
    } catch (cause) {
      if (cause instanceof AiError && cause.code === 'ABORTED') return;
      setLog((entries) => [
        ...entries.slice(-9),
        {
          id,
          command: trimmed,
          kind: 'error',
          canUndo: false,
          text: cause instanceof AiError ? cause.message : 'Something went wrong. Try again.',
        },
      ]);
    } finally {
      abort.current = null;
      setBusy(false);
    }
  }

  function undoLast(id: number) {
    if (undo.current?.id !== id) return;
    useTemplateStore.getState().restoreSnapshot(undo.current.snapshot);
    undo.current = null;
    setLog((entries) =>
      entries.map((e) => (e.id === id ? { ...e, canUndo: false, text: `${e.text} Undone.` } : e)),
    );
  }

  const row = dataRows[current];
  const issueCount = useMemo(() => {
    let n = 0;
    for (const r of dataRows) for (const c of columns) if (auditCell(r[c])) n++;
    return n;
  }, [dataRows, columns]);

  if (dataRows.length === 0) {
    return (
      <section
        className={cn(
          'rounded-2xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700',
          className,
        )}
        data-testid="smart-audit"
      >
        Upload a spreadsheet to review it here.
      </section>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      <section
        aria-roledescription="carousel"
        aria-label="Review your data"
        data-testid="smart-audit"
        onKeyDown={onKeyDown}
        className={cn('flex flex-col gap-3', className)}
      >
        <header className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous row"
            disabled={current === 0}
            onClick={() => go(current - 1)}
            className="rounded-full p-2 hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800"
          >
            <ChevronLeft className="size-5" aria-hidden />
          </button>
          <p
            className="flex-1 text-center text-sm font-medium"
            aria-live="polite"
            data-testid="smart-audit-counter"
          >
            Row {current + 1} of {dataRows.length}
            {issueCount > 0 && (
              <span className="ml-2 text-amber-700 dark:text-amber-400">
                · {issueCount} to check
              </span>
            )}
          </p>
          <button
            type="button"
            aria-label="Next row"
            disabled={current === last}
            onClick={() => go(current + 1)}
            className="rounded-full p-2 hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800"
          >
            <ChevronRight className="size-5" aria-hidden />
          </button>
        </header>

        <div className="relative overflow-hidden">
          <AnimatePresence initial={false} mode="popLayout" custom={direction}>
            <motion.article
              key={current}
              custom={direction}
              role="group"
              aria-roledescription="slide"
              aria-label={`Row ${current + 1} of ${dataRows.length}`}
              data-testid="smart-audit-card"
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.5}
              onDragEnd={onDragEnd}
              initial={{ x: direction * 80, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: direction * -80, opacity: 0 }}
              transition={{ type: 'spring', damping: 30, stiffness: 340 }}
              className="touch-pan-y rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
            >
              <dl className="grid gap-x-4 gap-y-2 grid-cols-[minmax(0,6.5rem)_1fr] sm:grid-cols-[minmax(0,10rem)_1fr]">
                {columns.map((column) => {
                  const issue = row ? auditCell(row[column]) : null;
                  const text = row ? cellText(row[column]) : '';
                  return (
                    <div key={column} className="contents">
                      <dt className="truncate text-xs font-medium text-neutral-500 sm:pt-0.5">
                        {column}
                      </dt>
                      <dd className="flex items-start gap-2 text-sm break-words">
                        <span
                          className={cn(
                            'min-w-0 flex-1 whitespace-pre-wrap',
                            issue === 'empty' && 'text-neutral-400 italic',
                          )}
                        >
                          {issue === 'empty'
                            ? '(empty)'
                            : text.replace(/ /g, issue === 'spaces' ? '·' : ' ')}
                        </span>
                        {issue && (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                            <AlertTriangle className="size-3" aria-hidden />
                            {ISSUE_LABEL[issue]}
                          </span>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </motion.article>
          </AnimatePresence>
        </div>

        {log.length > 0 && (
          <ul
            className="flex max-h-40 flex-col gap-2 overflow-y-auto text-sm"
            aria-live="polite"
            data-testid="smart-audit-log"
          >
            {log.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1">
                <span className="self-end rounded-2xl bg-blue-600 px-3 py-1.5 text-white">
                  {entry.command}
                </span>
                <span
                  className={cn(
                    'self-start rounded-2xl px-3 py-1.5',
                    entry.kind === 'error'
                      ? 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200'
                      : 'bg-neutral-100 dark:bg-neutral-800',
                  )}
                  role={entry.kind === 'error' ? 'alert' : undefined}
                >
                  {entry.text}
                  {entry.canUndo && (
                    <button
                      type="button"
                      onClick={() => undoLast(entry.id)}
                      className="ml-2 inline-flex items-center gap-1 underline"
                    >
                      <Undo2 className="size-3" aria-hidden /> Undo
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              disabled={busy}
              onClick={() => void send(suggestion)}
              className="min-h-9 rounded-full border border-neutral-300 px-3 text-xs hover:border-neutral-500 disabled:opacity-50 dark:border-neutral-700"
            >
              {suggestion}
            </button>
          ))}
        </div>

        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send(command);
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            Tell the AI what to fix
          </label>
          <input
            id={inputId}
            value={command}
            maxLength={500}
            disabled={busy}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="Ask AI to fix the data, e.g. “Capitalize names”"
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-neutral-300 bg-white px-3 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            data-testid="smart-audit-input"
          />
          <button
            type="submit"
            disabled={busy || !command.trim()}
            aria-label="Send"
            className="inline-flex size-11 items-center justify-center rounded-xl bg-blue-600 text-white disabled:opacity-50"
            data-testid="smart-audit-send"
          >
            {busy ? (
              <LoaderCircle className="size-5 animate-spin" aria-hidden />
            ) : (
              <Send className="size-5" aria-hidden />
            )}
          </button>
        </form>

        {onConfirm && (
          <button
            type="button"
            onClick={onConfirm}
            className="min-h-11 rounded-xl bg-green-700 px-4 text-sm font-medium text-white hover:bg-green-800"
          >
            {confirmLabel ?? 'Looks good'}
          </button>
        )}
      </section>
    </MotionConfig>
  );
}
