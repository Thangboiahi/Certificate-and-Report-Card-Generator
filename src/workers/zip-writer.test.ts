import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { createZipWriter } from './zip-writer';

describe('createZipWriter', () => {
  it('writes every file, uncompressed, byte for byte', async () => {
    const writer = createZipWriter();
    const files = Array.from({ length: 30 }, (_, index) => ({
      name: `${index + 1} - Student.pdf`,
      bytes: new Uint8Array(Array.from({ length: 1000 + index }, (_, i) => (i * 7 + index) % 256)),
    }));
    for (const file of files) writer.add(file.name, file.bytes);
    expect(writer.fileCount).toBe(30);

    const blob = await writer.finish();
    expect(blob.type).toBe('application/zip');

    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(files.map((file) => file.name).sort());
    for (const file of files) {
      expect(await zip.file(file.name)!.async('uint8array')).toEqual(file.bytes);
    }
  });

  it('keeps Indian-script file names', async () => {
    const writer = createZipWriter();
    writer.add('101 - प्रियंका त्रिपाठी.pdf', new Uint8Array([1, 2, 3]));
    const zip = await JSZip.loadAsync(await (await writer.finish()).arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(['101 - प्रियंका त्रिपाठी.pdf']);
  });

  it('produces a valid empty archive and cannot be reused', async () => {
    const writer = createZipWriter();
    const zip = await JSZip.loadAsync(await (await writer.finish()).arrayBuffer());
    expect(Object.keys(zip.files)).toEqual([]);
    expect(() => writer.add('late.pdf', new Uint8Array([1]))).toThrow();
    await expect(writer.finish()).rejects.toThrow();
  });
});
