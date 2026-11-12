/**
 * Builds a ZIP of generated PDFs without holding the batch in the JavaScript heap.
 *
 * A 2,500-row batch can weigh hundreds of megabytes; held as arrays in a worker on a mid-range
 * phone, that crashes the tab. Instead:
 *
 *   - each PDF is turned into a `Blob` the moment it arrives. Blob data is owned by the browser's
 *     blob store (outside the JS heap, paged to disk when large), and JSZip reads it back lazily,
 *     one file at a time, while writing the archive;
 *   - the archive is generated as a stream, and its chunks are gathered into Blobs every few
 *     megabytes, so the finished ZIP is a Blob too and is never one giant buffer.
 *
 * PDFs are already compressed, so entries are STORED: deflating them again costs CPU for ~1 %.
 */
import JSZip from 'jszip';

/** Gather streamed output into a Blob every this many bytes. */
const CHUNK_FLUSH_BYTES = 4 * 1024 * 1024;

export interface ZipWriter {
  /** Adds a file. The caller can drop its reference to `bytes` straight away. */
  add(fileName: string, bytes: Uint8Array): void;
  readonly fileCount: number;
  /** Writes the archive. The writer cannot be used afterwards. */
  finish(): Promise<Blob>;
}

/**
 * JSZip reads Blob entries with `FileReader`, which browsers and workers have and Node does not.
 * Where it is missing (unit tests), entries stay as byte arrays.
 */
const canDeferToBlobs = (): boolean => typeof FileReader !== 'undefined';

export function createZipWriter(): ZipWriter {
  let zip: JSZip | null = new JSZip();
  let fileCount = 0;
  const useBlobs = canDeferToBlobs();

  return {
    get fileCount() {
      return fileCount;
    },

    add(fileName, bytes) {
      if (!zip) throw new Error('The ZIP has already been written.');
      const data = useBlobs ? new Blob([bytes as Uint8Array<ArrayBuffer>]) : bytes;
      zip.file(fileName, data, { binary: true, compression: 'STORE' });
      fileCount++;
    },

    finish() {
      const archive = zip;
      if (!archive) return Promise.reject(new Error('The ZIP has already been written.'));
      zip = null;

      return new Promise<Blob>((resolve, reject) => {
        const parts: Blob[] = [];
        let pending: Uint8Array<ArrayBuffer>[] = [];
        let pendingBytes = 0;
        const flush = () => {
          if (pending.length === 0) return;
          parts.push(new Blob(pending));
          pending = [];
          pendingBytes = 0;
        };

        archive
          .generateInternalStream({ type: 'uint8array', streamFiles: true, compression: 'STORE' })
          .on('data', (chunk) => {
            pending.push(chunk as Uint8Array<ArrayBuffer>);
            pendingBytes += chunk.byteLength;
            if (pendingBytes >= CHUNK_FLUSH_BYTES) flush();
          })
          .on('error', reject)
          .on('end', () => {
            flush();
            resolve(new Blob(parts, { type: 'application/zip' }));
          })
          .resume();
      });
    },
  };
}
