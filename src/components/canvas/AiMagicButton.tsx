'use client';

/**
 * "AI Magic": adds a column to the data before it is injected into the template — a translation of
 * one column ("Name" → Hindi) or a generated remark per row — through Gemini on the server.
 *
 * Only the columns the person ticks are sent (data minimisation), the new column cannot overwrite
 * an existing one, and the work can be cancelled. The result lands in the template store, so the
 * canvas and the Smart Audit carousel show it at once.
 */
import { LoaderCircle, Sparkles } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  dialogButton,
} from '@/components/ui/dialog';
import { AiError, enrichDataBatch } from '@/lib/ai/geminiClient';
import { columnsOf, isValidColumnName } from '@/lib/ai/schema';
import { notifyError } from '@/lib/ui/notify';
import { cn } from '@/lib/utils/cn';
import { useTemplateStore } from '@/store/templateStore';

type Mode = 'translate' | 'remarks' | 'custom';

const MODES: { id: Mode; label: string }[] = [
  { id: 'translate', label: 'Translate' },
  { id: 'remarks', label: 'Write remarks' },
  { id: 'custom', label: 'Custom' },
];

const LANGUAGES = [
  'Hindi',
  'Bengali',
  'Tamil',
  'Telugu',
  'Marathi',
  'Gujarati',
  'Kannada',
  'Malayalam',
  'Punjabi',
  'Odia',
  'English',
] as const;

const REMARK_PROMPT =
  'Write one warm, specific, professional report-card remark of at most 120 characters for this ' +
  'student, based on the values given. Do not invent facts that are not in the data.';

const FIELD =
  'w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900';

export interface AiMagicButtonProps {
  className?: string;
  /** Called with the new column's name and how many rows came back empty. */
  onEnriched?: (column: string, blank: number) => void;
}

export function AiMagicButton({ className, onEnriched }: AiMagicButtonProps) {
  const dataRows = useTemplateStore((state) => state.dataRows);
  const columns = useMemo(() => columnsOf(dataRows), [dataRows]);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('translate');
  const [language, setLanguage] = useState<string>('Hindi');
  const [source, setSource] = useState<string>('');
  const [picked, setPicked] = useState<string[] | null>(null);
  const [custom, setCustom] = useState('');
  const [targetOverride, setTargetOverride] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [message, setMessage] = useState<{ kind: 'error' | 'done'; text: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const ids = { source: useId(), language: useId(), target: useId(), custom: useId() };

  const translateColumn = columns.includes(source) ? source : (columns[0] ?? '');
  const sendColumns = (picked ?? columns).filter((c) => columns.includes(c));
  const defaultTarget =
    mode === 'translate'
      ? `${translateColumn} (${language})`
      : mode === 'remarks'
        ? 'AI Remark'
        : 'AI Column';
  const target = (targetOverride ?? defaultTarget).trim();
  const prompt =
    mode === 'translate'
      ? `Translate the value of "${translateColumn}" into ${language}, written in the native script of ${language}. ` +
        'Transliterate personal names; keep numbers, dates and codes unchanged.'
      : mode === 'remarks'
        ? REMARK_PROMPT
        : custom.trim();
  const sent = mode === 'translate' ? [translateColumn] : sendColumns;

  const targetProblem = !isValidColumnName(target)
    ? 'Use 1–64 characters for the column name.'
    : columns.includes(target)
      ? `A column named "${target}" already exists.`
      : null;
  const ready =
    !running && dataRows.length > 0 && prompt !== '' && sent.length > 0 && !targetProblem;

  async function run() {
    const startRows = dataRows;
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setMessage(null);
    setProgress([0, startRows.length]);
    try {
      const enriched = await enrichDataBatch(startRows, prompt, target, {
        sourceColumns: sent,
        signal: controller.signal,
        onProgress: (done, total) => setProgress([done, total]),
      });
      // The rows may have been edited while the AI worked: add the column to whatever is there now.
      const current = useTemplateStore.getState().dataRows;
      if (current.length !== enriched.length) {
        throw new AiError(
          'BAD_REQUEST',
          'The data changed while the AI was working. Run it again.',
        );
      }
      useTemplateStore
        .getState()
        .setDataRows(current.map((row, i) => ({ ...row, [target]: enriched[i]![target] })));
      const blank = enriched.filter((row) => !row[target]).length;
      onEnriched?.(target, blank);
      setMessage({
        kind: 'done',
        text:
          `Added "${target}" to ${enriched.length - blank} rows.` +
          (blank ? ` ${blank} came back empty — check them in the review.` : ''),
      });
      setTargetOverride(null);
    } catch (cause) {
      if (!(cause instanceof AiError && cause.code === 'ABORTED')) notifyError(cause);
      setMessage(
        cause instanceof AiError && cause.code === 'ABORTED'
          ? { kind: 'error', text: 'Cancelled. Nothing was added.' }
          : {
              kind: 'error',
              text: cause instanceof AiError ? cause.message : 'Something went wrong. Try again.',
            },
      );
    } finally {
      abort.current = null;
      setRunning(false);
      setProgress(null);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={dataRows.length === 0}
        data-testid="ai-magic-button"
        className={cn(
          'inline-flex min-h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-blue-600 px-4 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      >
        <Sparkles className="size-4" aria-hidden />
        AI Magic
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) abort.current?.abort();
          setOpen(next);
        }}
      >
        <DialogContent data-testid="ai-magic-dialog">
          <DialogHeader>
            <DialogTitle>AI Magic</DialogTitle>
            <DialogDescription>
              Adds a new column to your {dataRows.length} rows before the documents are generated.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-2 sm:px-6">
            <div
              role="tablist"
              aria-label="What to add"
              className="flex gap-1 rounded-xl bg-neutral-100 p-1 dark:bg-neutral-900"
            >
              {MODES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={mode === item.id}
                  disabled={running}
                  onClick={() => {
                    setMode(item.id);
                    setTargetOverride(null);
                  }}
                  className={cn(
                    'min-h-10 flex-1 rounded-lg px-2 text-sm',
                    mode === item.id
                      ? 'bg-white font-medium shadow-sm dark:bg-neutral-800'
                      : 'text-neutral-600 dark:text-neutral-400',
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {mode === 'translate' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <label htmlFor={ids.source} className="text-sm font-medium">
                    Column to translate
                  </label>
                  <select
                    id={ids.source}
                    className={FIELD}
                    value={translateColumn}
                    disabled={running}
                    onChange={(e) => {
                      setSource(e.target.value);
                      setTargetOverride(null);
                    }}
                  >
                    {columns.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor={ids.language} className="text-sm font-medium">
                    Into
                  </label>
                  <select
                    id={ids.language}
                    className={FIELD}
                    value={language}
                    disabled={running}
                    onChange={(e) => {
                      setLanguage(e.target.value);
                      setTargetOverride(null);
                    }}
                  >
                    {LANGUAGES.map((l) => (
                      <option key={l}>{l}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {mode === 'custom' && (
              <div className="flex flex-col gap-1">
                <label htmlFor={ids.custom} className="text-sm font-medium">
                  What should the AI write for each row?
                </label>
                <textarea
                  id={ids.custom}
                  rows={3}
                  maxLength={500}
                  className={FIELD}
                  value={custom}
                  disabled={running}
                  placeholder="e.g. Write the marks in words"
                  onChange={(e) => setCustom(e.target.value)}
                />
              </div>
            )}

            {mode !== 'translate' && (
              <fieldset className="flex flex-col gap-1" disabled={running}>
                <legend className="text-sm font-medium">Columns the AI may read</legend>
                <div className="flex flex-wrap gap-2">
                  {columns.map((c) => {
                    const on = sendColumns.includes(c);
                    return (
                      <label
                        key={c}
                        className={cn(
                          'inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm',
                          on
                            ? 'border-blue-600 bg-blue-50 dark:bg-blue-950'
                            : 'border-neutral-300 dark:border-neutral-700',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={on}
                          onChange={() =>
                            setPicked(on ? sendColumns.filter((x) => x !== c) : [...sendColumns, c])
                          }
                        />
                        {c}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            )}

            <div className="flex flex-col gap-1">
              <label htmlFor={ids.target} className="text-sm font-medium">
                New column name
              </label>
              <input
                id={ids.target}
                className={FIELD}
                value={targetOverride ?? defaultTarget}
                disabled={running}
                maxLength={64}
                onChange={(e) => setTargetOverride(e.target.value)}
              />
              {targetProblem && (
                <p className="text-sm text-red-600" role="alert">
                  {targetProblem}
                </p>
              )}
            </div>

            <p className="text-xs text-neutral-500">
              The values in {sent.length === 1 ? `“${sent[0]}”` : `${sent.length} columns`} are sent
              to Google Gemini to write the new column. Nothing else leaves your device. Review the
              result before printing — AI can make mistakes, and the template font must support the
              language.
            </p>

            {progress && (
              <div role="status" aria-live="polite" className="flex flex-col gap-1">
                <div className="h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                  <div
                    className="h-full bg-blue-600 transition-[width]"
                    style={{ width: `${(progress[0] / Math.max(progress[1], 1)) * 100}%` }}
                  />
                </div>
                <span className="text-xs text-neutral-500">
                  {progress[0]} of {progress[1]} rows
                </span>
              </div>
            )}
            {message && (
              <p
                role={message.kind === 'error' ? 'alert' : 'status'}
                className={cn(
                  'text-sm',
                  message.kind === 'error' ? 'text-red-600' : 'text-green-700 dark:text-green-400',
                )}
                data-testid="ai-magic-message"
              >
                {message.text}
              </p>
            )}
          </div>
          <DialogFooter>
            {running ? (
              <button
                type="button"
                className={dialogButton.secondary}
                onClick={() => abort.current?.abort()}
              >
                Cancel
              </button>
            ) : (
              <button
                type="button"
                className={dialogButton.secondary}
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            )}
            <button
              type="button"
              className={dialogButton.primary}
              disabled={!ready}
              onClick={run}
              data-testid="ai-magic-run"
            >
              {running ? (
                <LoaderCircle className="mr-2 size-4 animate-spin" aria-hidden />
              ) : (
                <Sparkles className="mr-2 size-4" aria-hidden />
              )}
              {running ? 'Working…' : 'Add column'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
