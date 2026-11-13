'use client';

/**
 * Manual data entry, for people with no CSV: add a field by name and type its value for the row
 * being previewed. Values live in the store's `dataRows`; a field with no value shows its
 * `{{name}}` on the canvas (`previewText`).
 */
import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { placeholdersForColumns } from '@/lib/editor/starter-template';
import type { DataRow } from '@/lib/template';
import { useTemplateStore } from '@/store/templateStore';

export interface ManualEntryPanelProps {
  rowIndex: number;
}

export function ManualEntryPanel({ rowIndex }: ManualEntryPanelProps) {
  const template = useTemplateStore((state) => state.activeTemplate);
  const dataRows = useTemplateStore((state) => state.dataRows);
  const [name, setName] = useState('');
  if (!template) return null;

  const columns = [
    ...new Set(
      template.placeholders.flatMap((p) => (p.binding.kind === 'column' ? [p.binding.column] : [])),
    ),
  ];
  const row: DataRow = dataRows[rowIndex] ?? {};

  function setValue(column: string, value: string) {
    const state = useTemplateStore.getState();
    const rows = state.dataRows.length > 0 ? state.dataRows.slice() : [{}];
    rows[rowIndex] = { ...rows[rowIndex], [column]: value };
    state.setDataRows(rows);
  }

  function addField(event: FormEvent) {
    event.preventDefault();
    const column = name.trim();
    const state = useTemplateStore.getState();
    const current = state.activeTemplate;
    const page = current?.pages[0];
    if (!column || !current || !page) return;
    if (columns.includes(column)) {
      setName('');
      return;
    }
    state.addPlaceholders(
      placeholdersForColumns(
        [column],
        page,
        new Set(current.placeholders.map((p) => p.id)),
        page.height * 0.2 + current.placeholders.length * 48,
      ),
    );
    if (state.dataRows.length === 0) state.setDataRows([{}]);
    setName('');
  }

  return (
    <div
      data-testid="manual-entry"
      className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800"
    >
      <p className="text-sm font-medium">Enter data manually</p>
      {columns.length === 0 && (
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          No fields yet. Add one below, then drag it into place on the page.
        </p>
      )}
      {columns.map((column) => (
        <label
          key={column}
          className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400"
        >
          {column}
          <input
            type="text"
            value={String(row[column] ?? '')}
            placeholder={`{{${column}}}`}
            onChange={(event) => setValue(column, event.target.value)}
            data-testid={`manual-value-${column}`}
            className="min-h-11 rounded-lg border border-neutral-300 bg-white px-3 text-base text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          />
        </label>
      ))}
      <form onSubmit={addField} className="flex gap-2">
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="New field name, e.g. Student_Name"
          aria-label="New field name"
          data-testid="manual-field-name"
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          disabled={name.trim() === ''}
          data-testid="manual-add-field"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <Plus className="size-4" aria-hidden /> Add field
        </button>
      </form>
    </div>
  );
}
