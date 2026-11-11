import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { orientationSwapsAxes, readJpegOrientation } from './exif';
import { detectImageFormat } from './sniff';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'images', name)));

describe('detectImageFormat', () => {
  it.each([
    ['landscape.jpg', 'jpeg'],
    ['portrait.png', 'png'],
    ['logo.png', 'png'],
    ['landscape.webp', 'webp'],
    ['landscape.gif', 'gif'],
    ['corrupt.jpg', 'jpeg'], // it starts like a JPEG; whether it decodes is the embedder's business
  ])('recognises %s as %s', (name, format) => {
    expect(detectImageFormat(fixture(name))).toBe(format);
  });

  it('recognises formats by signature alone', () => {
    const bytes = (...values: number[]) => new Uint8Array([...values, ...new Array(16).fill(0)]);
    const ascii = (text: string) =>
      bytes(...Array.from(text, (character) => character.charCodeAt(0)));

    expect(detectImageFormat(ascii('BM'))).toBe('bmp');
    expect(detectImageFormat(bytes(0x49, 0x49, 0x2a, 0x00))).toBe('tiff');
    expect(detectImageFormat(bytes(0x4d, 0x4d, 0x00, 0x2a))).toBe('tiff');
    expect(detectImageFormat(ascii('\0\0\0\x1cftypavif'))).toBe('avif');
    expect(detectImageFormat(ascii('\0\0\0\x18ftypheic'))).toBe('heic');
    expect(detectImageFormat(ascii('\0\0\0\x18ftypmif1'))).toBe('heic');
  });

  it('rejects things that are not images', () => {
    const text = (value: string) => new TextEncoder().encode(value);
    expect(detectImageFormat(text('<!doctype html><html>Sign in</html>'))).toBeNull();
    expect(detectImageFormat(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(detectImageFormat(text('%PDF-1.7'))).toBeNull();
    expect(detectImageFormat(text('\0\0\0\x18ftypisom-------'))).toBeNull(); // an MP4 video
    expect(detectImageFormat(new Uint8Array())).toBeNull();
    expect(detectImageFormat(new Uint8Array([0xff, 0xd8]))).toBeNull(); // too short to be sure
  });
});

describe('readJpegOrientation', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8] as const)('reads orientation %i', (orientation) => {
    expect(readJpegOrientation(fixture(`exif-${orientation}.jpg`))).toBe(orientation);
  });

  it('defaults to 1 for a JPEG without EXIF, and for anything that is not a JPEG', () => {
    expect(readJpegOrientation(fixture('landscape.jpg'))).toBe(1);
    expect(readJpegOrientation(fixture('portrait.png'))).toBe(1);
    expect(readJpegOrientation(new Uint8Array())).toBe(1);
  });

  it('never throws on truncated or corrupt data', () => {
    const jpeg = fixture('exif-6.jpg');
    for (let length = 0; length < 120; length++) {
      expect(() => readJpegOrientation(jpeg.subarray(0, length))).not.toThrow();
    }
    expect(readJpegOrientation(fixture('corrupt.jpg'))).toBe(1);
  });

  it('reads through a view that does not start at the beginning of its buffer', () => {
    const jpeg = fixture('exif-8.jpg');
    const padded = new Uint8Array(jpeg.length + 7);
    padded.set(jpeg, 7);
    expect(readJpegOrientation(padded.subarray(7))).toBe(8);
  });
});

describe('orientationSwapsAxes', () => {
  it('is true exactly for the quarter-turn orientations', () => {
    const swapped = ([1, 2, 3, 4, 5, 6, 7, 8] as const).filter(orientationSwapsAxes);
    expect(swapped).toEqual([5, 6, 7, 8]);
  });
});
