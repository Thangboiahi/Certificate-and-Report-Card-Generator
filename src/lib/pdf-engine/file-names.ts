/**
 * File names for generated documents: safe on Windows, macOS, Android and Google Drive, and
 * unique within a job even when two people share a name.
 */

/** Characters Windows forbids in file names (and "/" which every system forbids). */
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001F\u007F]/g;

/** Names Windows reserves for devices, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Long enough for "Roll No - Full Name - Class", short enough for every file system. */
const MAX_LENGTH = 120;

/**
 * Makes `name` safe to use as a file name (without extension). Returns an empty string when
 * nothing usable is left, so the caller can substitute a fallback.
 */
export function sanitizeFileName(name: string): string {
  let safe = name
    .normalize('NFC')
    .replace(FORBIDDEN, '-')
    .replace(/\s+/g, ' ')
    // Windows silently strips trailing dots and spaces, which would make two names collide.
    .replace(/^[\s.]+|[\s.]+$/g, '');

  // Cut by code point so a character outside the basic plane is never split in half.
  const characters = Array.from(safe);
  if (characters.length > MAX_LENGTH) {
    safe = characters
      .slice(0, MAX_LENGTH)
      .join('')
      .replace(/[\s.]+$/g, '');
  }

  return RESERVED.test(safe) ? `${safe}_` : safe;
}

/** Hands out unique `.pdf` file names for one job. */
export class FileNamer {
  /** Every name handed out so far, lower-cased. */
  private readonly taken = new Set<string>();
  /** Highest suffix tried per base name, so a batch of 500 "Rahul Kumar" stays fast. */
  private readonly counters = new Map<string, number>();

  /**
   * Returns `<name>.pdf`, falling back to `fallback` when `name` sanitises to nothing and adding
   * " (2)", " (3)"… when the name was already given out. Comparison ignores case, because most
   * desktop file systems do.
   */
  next(name: string, fallback: string): string {
    const base = sanitizeFileName(name) || sanitizeFileName(fallback) || 'Document';
    const key = base.toLowerCase();

    let candidate = base;
    let counter = this.counters.get(key) ?? 1;
    while (this.taken.has(candidate.toLowerCase())) {
      counter += 1;
      candidate = `${base} (${counter})`;
    }
    this.counters.set(key, counter);
    this.taken.add(candidate.toLowerCase());

    return `${candidate}.pdf`;
  }
}
