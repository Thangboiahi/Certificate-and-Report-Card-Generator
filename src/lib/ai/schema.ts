/**
 * AI enrichment & Smart Audit — the contract between the browser, the server and Gemini (ADR-029).
 *
 * Everything the model returns is untrusted text. It is parsed as JSON, validated against the zod
 * schemas below, and then applied by `applyAuditPatch` only where it matches the real state (rows
 * that exist, columns that exist, placeholders that exist, enumerated style values). Anything else
 * is dropped and reported, so a malformed or hostile answer can neither crash the UI nor reach
 * beyond the allow-lists.
 *
 * Pure and isomorphic: no `fetch`, no server APIs. Shared by the route handlers, the browser
 * client and the tests.
 */
import { z } from 'zod';

import {
  TEMPLATE_LIMITS,
  type DataRow,
  type Placeholder,
  type TemplateDefinition,
} from '@/lib/template';

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Limits
// ───────────────────────────────────────────────────────────────────────────────────────────────

export const AI_LIMITS = {
  /** Rows per enrichment request; the client sends a larger sheet in several. */
  maxEnrichRows: 40,
  /** Characters kept of one cell sent to the model. */
  maxCellChars: 300,
  /** Characters in a user prompt or command. */
  maxPromptChars: 500,
  maxColumnNameChars: 64,
  /** Columns sent per row. */
  maxColumns: 40,
  /** Rows (with their indexes) shown to the model for an audit command. */
  maxAuditSampleRows: 25,
  maxTransforms: 20,
  maxCellEdits: 200,
  maxPlaceholderPatches: 50,
  /** Characters accepted back for one enriched cell. */
  maxResultChars: 600,
} as const;

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Errors
// ───────────────────────────────────────────────────────────────────────────────────────────────

export type AiErrorCode =
  | 'AI_NOT_CONFIGURED'
  | 'AI_UNAVAILABLE'
  | 'BAD_MODEL_OUTPUT'
  | 'BAD_REQUEST'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'TOO_LARGE'
  | 'NETWORK'
  | 'ABORTED'
  | 'COLUMN_EXISTS';

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Strict JSON
// ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Parses model output as JSON. Gemini is asked for `application/json`, but a fenced block is
 * tolerated. Returns `undefined` for anything that is not valid JSON — never throws.
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  try {
    return JSON.parse(fenced ? fenced[1]! : trimmed);
  } catch {
    return undefined;
  }
}

/** Dangerous keys can never be a column name: rows are plain objects. */
const FORBIDDEN_COLUMN = new Set(['__proto__', 'constructor', 'prototype']);

export function isValidColumnName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.trim() === name &&
    name.length > 0 &&
    name.length <= AI_LIMITS.maxColumnNameChars &&
    !FORBIDDEN_COLUMN.has(name) &&
    !/[\u0000-\u001f]/.test(name)
  );
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Enrichment
// ───────────────────────────────────────────────────────────────────────────────────────────────

const columnName = z.string().refine(isValidColumnName, 'Invalid column name');

export const enrichRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(AI_LIMITS.maxPromptChars),
  targetColumn: columnName,
  rows: z
    .array(
      z.object({
        i: z.int().min(0),
        values: z
          .record(columnName, z.string().max(AI_LIMITS.maxCellChars))
          .refine((v) => Object.keys(v).length <= AI_LIMITS.maxColumns, 'Too many columns'),
      }),
    )
    .min(1)
    .max(AI_LIMITS.maxEnrichRows),
});
export type EnrichRequest = z.infer<typeof enrichRequestSchema>;

/** What the model must return for an enrichment batch. */
export const enrichResultSchema = z.object({
  results: z
    .array(z.object({ i: z.int().min(0), value: z.string().max(AI_LIMITS.maxResultChars) }))
    .max(AI_LIMITS.maxEnrichRows),
});
export type EnrichResult = z.infer<typeof enrichResultSchema>;

/**
 * Keeps one answer per requested row. Rows the model skipped, repeated or invented are dropped (a
 * skipped row is returned blank by the caller, never shifted onto its neighbour).
 */
export function alignEnrichResults(
  result: EnrichResult,
  requested: readonly number[],
): Map<number, string> {
  const wanted = new Set(requested);
  const out = new Map<number, string>();
  for (const { i, value } of result.results) {
    if (wanted.has(i) && !out.has(i))
      out.set(i, value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''));
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Audit patch
// ───────────────────────────────────────────────────────────────────────────────────────────────

export const COLUMN_TRANSFORMS = [
  'uppercase',
  'lowercase',
  'titlecase',
  'trim',
  'collapse_spaces',
] as const;
export type ColumnTransformName = (typeof COLUMN_TRANSFORMS)[number];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Optional, nullable: Gemini's structured output may send `null` for a field it leaves out. */
const maybe = <T extends z.ZodType>(schema: T) => schema.nullish();

export const placeholderPatchSchema = z.object({
  id: z.string().min(1).max(128),
  textTransform: maybe(z.enum(['none', 'uppercase', 'lowercase', 'capitalize'])),
  align: maybe(z.enum(['left', 'center', 'right'])),
  verticalAlign: maybe(z.enum(['top', 'middle', 'bottom'])),
  color: maybe(z.string().regex(HEX_COLOR)),
  fontSize: maybe(z.number().min(4).max(TEMPLATE_LIMITS.maxFontSize)),
});
export type PlaceholderPatch = z.infer<typeof placeholderPatchSchema>;

export const auditPatchSchema = z.object({
  /** One sentence for the person: what was changed. */
  summary: z.string().trim().max(300),
  dataRows: z.object({
    /** A rule applied to every row of one column. */
    transforms: z
      .array(
        z.object({
          column: z.string().max(AI_LIMITS.maxColumnNameChars),
          transform: z.enum(COLUMN_TRANSFORMS),
        }),
      )
      .max(AI_LIMITS.maxTransforms),
    /** Individual cell corrections for rows the model was shown. */
    cells: z
      .array(
        z.object({
          row: z.int().min(0),
          column: z.string().max(AI_LIMITS.maxColumnNameChars),
          value: z.string().max(AI_LIMITS.maxResultChars),
        }),
      )
      .max(AI_LIMITS.maxCellEdits),
  }),
  placeholders: z.array(placeholderPatchSchema).max(AI_LIMITS.maxPlaceholderPatches),
});
export type AuditPatch = z.infer<typeof auditPatchSchema>;

/** A patch that changes nothing. */
export function emptyPatch(summary = ''): AuditPatch {
  return { summary, dataRows: { transforms: [], cells: [] }, placeholders: [] };
}

// ── What the model is shown ────────────────────────────────────────────────────────────────────

export interface AuditContextPlaceholder {
  id: string;
  label: string;
  type: Placeholder['type'];
  /** Text placeholders only. */
  style?: {
    textTransform: string;
    align: string;
    verticalAlign: string;
    color: string;
    fontSize: number;
  };
}

/** The slice of the editor state sent to the model: headers, a bounded sample, and placeholders. */
export const auditContextSchema = z.object({
  rowCount: z.int().min(0),
  columns: z.array(columnName).max(AI_LIMITS.maxColumns),
  sample: z
    .array(
      z.object({
        row: z.int().min(0),
        values: z.record(columnName, z.string().max(AI_LIMITS.maxCellChars)),
      }),
    )
    .max(AI_LIMITS.maxAuditSampleRows),
  placeholders: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        label: z.string().max(200),
        type: z.enum(['text', 'image', 'qr']),
        style: z
          .object({
            textTransform: z.string(),
            align: z.string(),
            verticalAlign: z.string(),
            color: z.string(),
            fontSize: z.number(),
          })
          .optional(),
      }),
    )
    .max(200),
});
export type AuditContext = z.infer<typeof auditContextSchema>;

export const auditRequestSchema = z.object({
  command: z.string().trim().min(1).max(AI_LIMITS.maxPromptChars),
  context: auditContextSchema,
});
export type AuditRequest = z.infer<typeof auditRequestSchema>;

/** The editor state a command is about. */
export interface AuditState {
  dataRows: readonly DataRow[];
  placeholders: readonly Placeholder[];
  /** The row on screen; always included in the sample. */
  focusRow?: number;
}

export function cellText(value: DataRow[string]): string {
  return value === null || value === undefined ? '' : String(value);
}

function clip(text: string): string {
  return text.length > AI_LIMITS.maxCellChars ? text.slice(0, AI_LIMITS.maxCellChars) : text;
}

/** Collects the columns of a sheet in first-seen order (own, valid names only). */
export function columnsOf(
  rows: readonly DataRow[],
  limit: number = AI_LIMITS.maxColumns,
): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (isValidColumnName(key)) seen.add(key);
      if (seen.size >= limit) return [...seen];
    }
  }
  return [...seen];
}

/** Builds the bounded context for an audit command. */
export function buildAuditContext(state: AuditState): AuditContext {
  const columns = columnsOf(state.dataRows);
  const picks = new Set<number>();
  const focus = state.focusRow;
  if (focus !== undefined && focus >= 0 && focus < state.dataRows.length) picks.add(focus);
  for (let i = 0; i < state.dataRows.length && picks.size < AI_LIMITS.maxAuditSampleRows; i++) {
    picks.add(i);
  }
  const sample = [...picks]
    .sort((a, b) => a - b)
    .map((row) => ({
      row,
      values: Object.fromEntries(columns.map((c) => [c, clip(cellText(state.dataRows[row]![c]))])),
    }));
  return {
    rowCount: state.dataRows.length,
    columns,
    sample,
    placeholders: state.placeholders.map((p) => ({
      id: p.id,
      label: p.label.slice(0, 200),
      type: p.type,
      ...(p.type === 'text'
        ? {
            style: {
              textTransform: p.style.textTransform ?? 'none',
              align: p.style.align,
              verticalAlign: p.style.verticalAlign,
              color: p.style.color,
              fontSize: p.style.fontSize,
            },
          }
        : {}),
    })),
  };
}

// ── Applying ───────────────────────────────────────────────────────────────────────────────────

/** Title Case by letter runs, so "o'brien-smith" → "O'Brien-Smith" and "a.k. rao" → "A.K. Rao". */
export function titleCase(text: string): string {
  return text.replace(/[\p{L}\p{M}]+/gu, (run) => {
    const first = String.fromCodePoint(run.codePointAt(0)!);
    return first.toLocaleUpperCase() + run.slice(first.length).toLocaleLowerCase();
  });
}

const TRANSFORM_FUNCTIONS: Record<ColumnTransformName, (text: string) => string> = {
  uppercase: (t) => t.toLocaleUpperCase(),
  lowercase: (t) => t.toLocaleLowerCase(),
  titlecase: titleCase,
  trim: (t) => t.trim(),
  collapse_spaces: (t) => t.trim().replace(/\s+/g, ' '),
};

export interface ApplyReport {
  transforms: number;
  cellsChanged: number;
  placeholdersChanged: number;
  /** Operations dropped because they named a row, column or placeholder that does not exist. */
  skipped: string[];
}

export interface ApplyResult {
  dataRows: DataRow[];
  /** The input template, or a new one when a placeholder changed. */
  template: TemplateDefinition | null;
  report: ApplyReport;
}

/**
 * Applies a validated patch to the real state. Never throws; never mutates its input. Operations
 * that do not match reality are skipped and listed in the report.
 */
export function applyAuditPatch(
  state: { dataRows: readonly DataRow[]; template: TemplateDefinition | null },
  patch: AuditPatch,
): ApplyResult {
  const report: ApplyReport = {
    transforms: 0,
    cellsChanged: 0,
    placeholdersChanged: 0,
    skipped: [],
  };
  const rows: DataRow[] = state.dataRows.slice();
  const columns = new Set(columnsOf(state.dataRows, Number.MAX_SAFE_INTEGER));
  const copied = new Set<number>();
  const edit = (index: number): DataRow => {
    if (!copied.has(index)) {
      rows[index] = { ...rows[index]! };
      copied.add(index);
    }
    return rows[index]!;
  };

  for (const { column, transform } of patch.dataRows.transforms) {
    if (!columns.has(column)) {
      report.skipped.push(`No column "${column}"`);
      continue;
    }
    const fn = TRANSFORM_FUNCTIONS[transform];
    let changed = 0;
    for (let i = 0; i < rows.length; i++) {
      const current = rows[i]![column];
      if (typeof current !== 'string') continue;
      const next = fn(current);
      if (next !== current) {
        edit(i)[column] = next;
        changed++;
      }
    }
    report.transforms++;
    report.cellsChanged += changed;
  }

  for (const { row, column, value } of patch.dataRows.cells) {
    if (!columns.has(column) || row >= rows.length) {
      report.skipped.push(`No cell ${column} / row ${row + 1}`);
      continue;
    }
    if (cellText(rows[row]![column]) === value) continue;
    edit(row)[column] = value;
    report.cellsChanged++;
  }

  let template = state.template;
  if (template) {
    const placeholders = template.placeholders.slice();
    for (const patchItem of patch.placeholders) {
      const index = placeholders.findIndex((p) => p.id === patchItem.id);
      const current = placeholders[index];
      if (!current) {
        report.skipped.push(`No field "${patchItem.id}"`);
        continue;
      }
      if (current.type !== 'text') {
        report.skipped.push(`"${current.label}" is not a text field`);
        continue;
      }
      const style = { ...current.style };
      if (patchItem.textTransform) style.textTransform = patchItem.textTransform;
      if (patchItem.align) style.align = patchItem.align;
      if (patchItem.verticalAlign) style.verticalAlign = patchItem.verticalAlign;
      if (patchItem.color) style.color = patchItem.color as `#${string}`;
      if (patchItem.fontSize) style.fontSize = Math.round(patchItem.fontSize * 100) / 100;
      const same = (Object.keys(style) as (keyof typeof style)[]).every(
        (k) => style[k] === current.style[k],
      );
      if (same) continue;
      placeholders[index] = {
        ...current,
        style,
        fit:
          current.fit.minFontSize > style.fontSize
            ? { ...current.fit, minFontSize: style.fontSize }
            : current.fit,
      };
      report.placeholdersChanged++;
    }
    if (report.placeholdersChanged > 0) template = { ...template, placeholders };
  } else if (patch.placeholders.length > 0) {
    report.skipped.push('No template is open');
  }

  return { dataRows: copied.size > 0 ? rows : (state.dataRows as DataRow[]), template, report };
}

/** Drops operations the context shows are impossible, before the patch leaves the server. */
export function filterPatchToContext(patch: AuditPatch, context: AuditContext): AuditPatch {
  const columns = new Set(context.columns);
  const sampled = new Set(context.sample.map((s) => s.row));
  const ids = new Map(context.placeholders.map((p) => [p.id, p.type]));
  return {
    summary: patch.summary,
    dataRows: {
      transforms: patch.dataRows.transforms.filter((t) => columns.has(t.column)),
      cells: patch.dataRows.cells.filter((c) => columns.has(c.column) && sampled.has(c.row)),
    },
    placeholders: patch.placeholders.filter((p) => ids.get(p.id) === 'text'),
  };
}
