/**
 * CSV parsing (PapaParse) and header checks for the upload gateway.
 */
import Papa from 'papaparse';

export type CsvRow = Record<string, string>;

export interface ParsedCsv {
  /** Column headers in file order, trimmed. */
  headers: string[];
  rows: CsvRow[];
  /** Problems PapaParse reported (e.g. a row with the wrong number of fields). */
  errors: string[];
}

/** Largest CSV accepted, in bytes. */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;

/** Largest batch the product supports (PLAN.md, E11). */
export const MAX_CSV_ROWS = 2500;

function toParsed(result: Papa.ParseResult<CsvRow>): ParsedCsv {
  const headers = (result.meta.fields ?? []).filter((header) => header !== '');
  return {
    headers,
    rows: result.data,
    errors: result.errors
      .slice(0, 10)
      .map((error) =>
        error.row === undefined ? error.message : `Row ${error.row + 2}: ${error.message}`,
      ),
  };
}

const OPTIONS = {
  header: true,
  skipEmptyLines: 'greedy',
  transformHeader: (header: string) => header.replace(/^\uFEFF/, '').trim(),
} as const;

/** Parses CSV text with a header row. */
export function parseCsvText(text: string): ParsedCsv {
  return toParsed(Papa.parse<CsvRow>(text, OPTIONS));
}

/** Parses a CSV file in the browser. */
export function parseCsvFile(file: File): Promise<ParsedCsv> {
  return new Promise((resolve, reject) => {
    Papa.parse<CsvRow>(file, {
      ...OPTIONS,
      complete: (result) => resolve(toParsed(result)),
      error: (error) => reject(new Error(`The CSV could not be read: ${error.message}`)),
    });
  });
}

export interface HeaderCheck {
  /** Required headers that are absent. */
  missing: string[];
  /** For a missing header, a present one that differs only in case or spacing. */
  nearMatches: Record<string, string>;
}

const loose = (header: string) => header.toLowerCase().replace(/\s+/g, ' ').trim();

/** Compares a file's headers with the ones a template needs. Matching is exact after trimming. */
export function checkHeaders(
  headers: readonly string[],
  requiredHeaders: readonly string[],
): HeaderCheck {
  const present = new Set(headers.map((header) => header.trim()));
  const missing = requiredHeaders.filter((header) => !present.has(header.trim()));
  const nearMatches: Record<string, string> = {};
  for (const header of missing) {
    const near = headers.find((candidate) => loose(candidate) === loose(header));
    if (near) nearMatches[header] = near;
  }
  return { missing, nearMatches };
}
