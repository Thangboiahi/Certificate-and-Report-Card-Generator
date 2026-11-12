/**
 * Browser-side entry points to the AI tools (ADR-029). The Gemini key lives on the server; these
 * functions talk to `/api/ai/enrich` and `/api/ai/audit` and hand back only validated data:
 *
 *     const rows = await enrichDataBatch(dataRows, 'Translate Name into Hindi', 'Name (Hindi)');
 *     const patch = await processAiAuditCommand('Capitalize names', { dataRows, placeholders });
 *
 * Responses are checked with the same zod schemas the server uses, so a malformed answer becomes an
 * `AiError`, never a crash in the UI. Rows are never mutated; enrichment returns copies.
 */
import type { DataRow } from '@/lib/template';

import {
  AI_LIMITS,
  AiError,
  auditPatchSchema,
  cellText,
  columnsOf,
  enrichResultSchema,
  isValidColumnName,
  buildAuditContext,
  type AiErrorCode,
  type AuditPatch,
  type AuditState,
} from './schema';

export { AiError, type AuditPatch, type AuditState } from './schema';

export interface EnrichOptions {
  /** Columns sent to the model (data minimisation). Default: every column. */
  sourceColumns?: readonly string[];
  signal?: AbortSignal;
  /** Called after every batch with the number of rows finished so far. */
  onProgress?: (done: number, total: number) => void;
  /** Batches in flight at once. Default 2. */
  concurrency?: number;
  fetchImpl?: typeof fetch;
}

const KNOWN_CODES = new Set<AiErrorCode>([
  'AI_NOT_CONFIGURED',
  'AI_UNAVAILABLE',
  'BAD_MODEL_OUTPUT',
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'TOO_LARGE',
]);

async function post(
  path: string,
  body: object,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    if (signal?.aborted) throw new AiError('ABORTED', 'Cancelled.');
    throw new AiError('NETWORK', 'You appear to be offline. Check your connection and retry.');
  }
  const payload = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  if (!response.ok) {
    const code = payload?.error?.code as AiErrorCode | undefined;
    throw new AiError(
      code && KNOWN_CODES.has(code) ? code : 'AI_UNAVAILABLE',
      payload?.error?.message ?? 'The AI service could not process this request.',
    );
  }
  return payload;
}

/**
 * Asks Gemini to fill `targetCol` for every row and returns new rows with that column appended.
 * A row the model skipped gets an empty string (never a neighbour's answer). Sends only
 * `sourceColumns`, in batches of {@link AI_LIMITS.maxEnrichRows}.
 */
export async function enrichDataBatch(
  rows: readonly DataRow[],
  prompt: string,
  targetCol: string,
  options: EnrichOptions = {},
): Promise<DataRow[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!isValidColumnName(targetCol)) {
    throw new AiError('BAD_REQUEST', 'Choose a name for the new column (up to 64 characters).');
  }
  if (!prompt.trim() || prompt.trim().length > AI_LIMITS.maxPromptChars) {
    throw new AiError(
      'BAD_REQUEST',
      `Write an instruction of up to ${AI_LIMITS.maxPromptChars} characters.`,
    );
  }
  if (rows.some((row) => Object.hasOwn(row, targetCol))) {
    throw new AiError('COLUMN_EXISTS', `A column named "${targetCol}" already exists.`);
  }
  const columns = (options.sourceColumns ?? columnsOf(rows)).filter(isValidColumnName);
  if (rows.length === 0 || columns.length === 0) {
    throw new AiError('BAD_REQUEST', 'There is no data to send.');
  }

  const answers: string[] = new Array<string>(rows.length).fill('');
  const batches: number[][] = [];
  for (let start = 0; start < rows.length; start += AI_LIMITS.maxEnrichRows) {
    batches.push(
      Array.from(
        { length: Math.min(AI_LIMITS.maxEnrichRows, rows.length - start) },
        (_, k) => start + k,
      ),
    );
  }

  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < batches.length) {
      const indexes = batches[next++]!;
      if (options.signal?.aborted) throw new AiError('ABORTED', 'Cancelled.');
      const payload = await post(
        '/api/ai/enrich',
        {
          prompt: prompt.trim(),
          targetColumn: targetCol,
          rows: indexes.map((i) => ({
            i,
            values: Object.fromEntries(
              columns.map((c) => [c, cellText(rows[i]![c]).slice(0, AI_LIMITS.maxCellChars)]),
            ),
          })),
        },
        options.signal,
        fetchImpl,
      );
      const parsed = enrichResultSchema.safeParse(payload);
      if (!parsed.success) {
        throw new AiError('BAD_MODEL_OUTPUT', 'The AI returned an answer that could not be used.');
      }
      const wanted = new Set(indexes);
      for (const { i, value } of parsed.data.results) if (wanted.has(i)) answers[i] = value;
      done += indexes.length;
      options.onProgress?.(done, rows.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency ?? 2, batches.length) }, worker),
  );
  return rows.map((row, i) => ({ ...row, [targetCol]: answers[i] }));
}

/**
 * Turns a natural-language command ("Capitalize names") into a validated patch for `dataRows` and
 * placeholder styling. Only headers, a bounded sample of rows and placeholder styles are sent. The
 * patch is not applied here: pass it to `useTemplateStore.getState().applyAiPatch`.
 */
export async function processAiAuditCommand(
  command: string,
  currentState: AuditState,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<AuditPatch> {
  if (!command.trim() || command.trim().length > AI_LIMITS.maxPromptChars) {
    throw new AiError(
      'BAD_REQUEST',
      `Write a command of up to ${AI_LIMITS.maxPromptChars} characters.`,
    );
  }
  const payload = (await post(
    '/api/ai/audit',
    { command: command.trim(), context: buildAuditContext(currentState) },
    options.signal,
    options.fetchImpl ?? fetch,
  )) as { patch?: unknown } | null;
  const parsed = auditPatchSchema.safeParse(payload?.patch);
  if (!parsed.success) {
    throw new AiError('BAD_MODEL_OUTPUT', 'The AI returned an answer that could not be used.');
  }
  return parsed.data;
}
