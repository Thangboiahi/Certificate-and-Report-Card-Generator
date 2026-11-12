/**
 * HTTP handling of the AI routes (ADR-029):
 *
 *   POST /api/ai/enrich   { prompt, targetColumn, rows: [{ i, values }] }     → { results: [{ i, value }] }
 *   POST /api/ai/audit    { command, context }                                → { patch }
 *
 * Same-origin → JSON → signed-in person (not a guest) → configured → valid body → Gemini.
 * Errors: `{ error: { code, message } }`.
 */
import 'server-only';

import { error, gate, json, log } from '@/lib/server/json-route';

import { auditCommand, enrichBatch, geminiConfigFromEnv } from './gemini';
import { AiError, auditRequestSchema, enrichRequestSchema } from './schema';

const SIGNED_IN = { kind: 'signed-in' } as const;
const STATUS: Partial<Record<AiError['code'], number>> = {
  AI_UNAVAILABLE: 502,
  BAD_MODEL_OUTPUT: 502,
};

function failure(cause: unknown, operation: string): Response {
  if (cause instanceof AiError) {
    return error(STATUS[cause.code] ?? 500, cause.code, cause.message);
  }
  // Never echo a provider message: it can carry request fragments.
  log('ERROR', `${operation} failed`, { cause: String(cause) });
  return error(500, 'INTERNAL', 'Something went wrong. Try again.');
}

export async function handleEnrich(request: Request): Promise<Response> {
  const checked = await gate(request, SIGNED_IN, 'Sign in to use AI tools.');
  if (!checked.ok) return checked.response;
  const config = geminiConfigFromEnv();
  if (!config) return error(503, 'AI_NOT_CONFIGURED', 'AI tools are not available yet.');
  const parsed = enrichRequestSchema.safeParse(checked.body);
  if (!parsed.success) return error(400, 'BAD_REQUEST', 'The request is not valid.');
  try {
    const { results, blank } = await enrichBatch(config, parsed.data);
    log('INFO', 'ai enrich', { uid: checked.user.uid, rows: results.length, blank });
    return json(200, { results });
  } catch (cause) {
    return failure(cause, 'ai enrich');
  }
}

export async function handleAudit(request: Request): Promise<Response> {
  const checked = await gate(request, SIGNED_IN, 'Sign in to use AI tools.');
  if (!checked.ok) return checked.response;
  const config = geminiConfigFromEnv();
  if (!config) return error(503, 'AI_NOT_CONFIGURED', 'AI tools are not available yet.');
  const parsed = auditRequestSchema.safeParse(checked.body);
  if (!parsed.success) return error(400, 'BAD_REQUEST', 'The request is not valid.');
  try {
    const patch = await auditCommand(config, parsed.data.command, parsed.data.context);
    log('INFO', 'ai audit', { uid: checked.user.uid });
    return json(200, { patch });
  } catch (cause) {
    return failure(cause, 'ai audit');
  }
}
