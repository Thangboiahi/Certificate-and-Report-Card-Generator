/**
 * Turn what people paste into spreadsheets into a URL that actually returns image bytes.
 *
 * "Share" links from cloud drives open a viewer page, not the file. Schools collecting photos
 * through Google Forms end up with exactly these links in their sheet, so the common ones are
 * rewritten to their direct-download form. Only publicly shared files can work this way; private
 * Drive files need the user's own Google authorisation (see docs/PLAN.md, milestone M2).
 *
 * No Node or browser APIs — safe to import anywhere.
 */
import { ProxyError } from './errors';

const DRIVE_HOSTS = new Set(['drive.google.com', 'docs.google.com']);
const DROPBOX_HOSTS = new Set(['www.dropbox.com', 'dropbox.com']);
const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{10,}$/;

/** Extracts the file id from the Google Drive link shapes people commonly share. */
function driveFileId(url: URL): string | null {
  // https://drive.google.com/file/d/<id>/view?usp=sharing
  const fromPath = /^\/file\/d\/([^/]+)/.exec(url.pathname)?.[1];
  // https://drive.google.com/open?id=<id>   and   https://drive.google.com/uc?id=<id>&export=view
  const fromQuery =
    url.pathname === '/open' || url.pathname === '/uc' ? url.searchParams.get('id') : null;

  const id = fromPath ?? fromQuery;
  return id && DRIVE_FILE_ID.test(id) ? id : null;
}

/**
 * Parses and normalises a raw cell value into the URL to fetch. Throws `ProxyError('INVALID_URL')`
 * when the value is not an absolute http(s) URL. Safety checks are separate (`assertSafeUrl`).
 */
export function normalizeImageUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ProxyError('INVALID_URL', 'This is not a valid web address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProxyError('INVALID_URL', 'Only http and https image links are supported.');
  }

  if (DRIVE_HOSTS.has(url.hostname)) {
    const id = driveFileId(url);
    if (id) return new URL(`https://drive.google.com/uc?export=download&id=${id}`);
  }

  if (DROPBOX_HOSTS.has(url.hostname) && url.searchParams.has('dl')) {
    url.searchParams.set('dl', '1');
  }

  return url;
}
