import { describe, expect, it } from 'vitest';

import { ProxyError } from './errors';
import { normalizeImageUrl } from './normalize-url';

const DRIVE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const DIRECT = `https://drive.google.com/uc?export=download&id=${DRIVE_ID}`;

describe('normalizeImageUrl', () => {
  it('leaves ordinary image links alone, trimming stray whitespace', () => {
    expect(normalizeImageUrl('  https://example.com/a/b.jpg?v=2 ').href).toBe(
      'https://example.com/a/b.jpg?v=2',
    );
  });

  it.each([
    `https://drive.google.com/file/d/${DRIVE_ID}/view?usp=sharing`,
    `https://drive.google.com/file/d/${DRIVE_ID}/view?usp=drivesdk`,
    `https://drive.google.com/open?id=${DRIVE_ID}`,
    `https://drive.google.com/uc?id=${DRIVE_ID}&export=view`,
    `https://docs.google.com/uc?id=${DRIVE_ID}`,
  ])('rewrites the Google Drive share link %s to a direct download', (link) => {
    expect(normalizeImageUrl(link).href).toBe(DIRECT);
  });

  it('does not touch Drive links it does not recognise', () => {
    const folder = 'https://drive.google.com/drive/folders/abc';
    expect(normalizeImageUrl(folder).href).toBe(folder);
    const badId = 'https://drive.google.com/open?id=../../etc';
    expect(normalizeImageUrl(badId).href).toBe(badId);
  });

  it('switches Dropbox share links to direct download', () => {
    expect(normalizeImageUrl('https://www.dropbox.com/s/abc123/photo.jpg?dl=0').href).toBe(
      'https://www.dropbox.com/s/abc123/photo.jpg?dl=1',
    );
  });

  it.each([
    '',
    'not a url',
    'example.com/a.jpg',
    'ftp://example.com/a.jpg',
    'data:image/png;base64,AA',
  ])('rejects %j', (value) => {
    expect(() => normalizeImageUrl(value)).toThrow(ProxyError);
  });
});
