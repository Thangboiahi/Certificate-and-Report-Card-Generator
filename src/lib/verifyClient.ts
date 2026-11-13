/**
 * Browser side of verification pre-minting (ADR-035): before a batch is generated, ask the server
 * for one verification id per row and put its address on the row, so the QR code on each PDF can be
 * drawn immediately, before anyone claims anything. The PDF engine and its Web Worker stay unaware
 * of the network: they just print the columns they are given.
 */
import { MAX_MINT_PER_REQUEST } from '@/lib/verify/limits';
import { VERIFY_ID_COLUMN, VERIFY_URL_COLUMN } from '@/lib/verify/ids';
import type { DataRow } from '@/lib/template';
import { readApiError } from '@/lib/ui/notify';

export interface PremintInput {
  rows: readonly DataRow[];
  /** Shown on the verification page, e.g. the template's name. */
  credentialName: string;
  /** The column holding each person's name, or `null` to record no names. */
  nameColumn: string | null;
  /** Injected for tests; defaults to the browser's `fetch`. */
  fetchImpl?: typeof fetch;
}

/** The column that most likely holds the person's name ("Name", "Student Name", ...). */
export function guessNameColumn(rows: readonly DataRow[]): string | null {
  const first = rows[0];
  if (!first) return null;
  const columns = Object.keys(first);
  return (
    columns.find((column) => /^(full[ _-]?)?name$/i.test(column)) ??
    columns.find((column) => /name/i.test(column)) ??
    null
  );
}

/**
 * Returns copies of `rows` with `verification_id` and `verification_url` added. Nothing is changed
 * in place. Rows that already carry a verification id keep it (a re-run must not mint twice).
 * Throws `ApiError` if the server refuses (for example, not signed in).
 */
export async function premintVerification(input: PremintInput): Promise<DataRow[]> {
  const doFetch = input.fetchImpl ?? fetch;
  const rows = input.rows.map((row) => ({ ...row }));
  const todo = rows.flatMap((row, index) => (row[VERIFY_ID_COLUMN] ? [] : [index]));
  for (let start = 0; start < todo.length; start += MAX_MINT_PER_REQUEST) {
    const chunk = todo.slice(start, start + MAX_MINT_PER_REQUEST);
    const response = await doFetch('/api/verify/mint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credentialName: input.credentialName,
        recipientNames: chunk.map((index) => {
          const value = input.nameColumn ? rows[index]![input.nameColumn] : null;
          return value === null || value === undefined || value === '' ? null : String(value);
        }),
      }),
    });
    if (!response.ok) throw await readApiError(response);
    const { items } = (await response.json()) as { items: { id: string; url: string }[] };
    if (!Array.isArray(items) || items.length !== chunk.length) {
      throw new Error('The server returned the wrong number of verification codes.');
    }
    chunk.forEach((index, position) => {
      rows[index]![VERIFY_ID_COLUMN] = items[position]!.id;
      rows[index]![VERIFY_URL_COLUMN] = items[position]!.url;
    });
  }
  return rows;
}
