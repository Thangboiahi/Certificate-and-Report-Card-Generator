/**
 * Fetch an image from an untrusted URL, safely.
 *
 * Built on `node:http(s)` rather than `fetch` because the proxy needs two things `fetch` does not
 * offer: control over DNS resolution for the socket (to pin the connection to addresses that were
 * checked) and a look at every redirect before it is followed.
 *
 * The image is read fully into memory (bounded by `maxBytes`) before anything is returned. That
 * is deliberate: streaming would tie the upstream deadline to the speed of the customer's phone
 * connection, and a half-relayed image is worse than a clean error. Peak memory is
 * `maxBytes × concurrent requests` — size the Cloud Run instance accordingly (docs/ARCHITECTURE.md).
 */
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { pipeline, type Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { detectImageFormat, IMAGE_MIME_TYPES, type ImageFormat } from '@/lib/images/sniff';

import { ProxyError } from './errors';
import { assertSafeUrl, createGuardedLookup, isPublicIp } from './ssrf';

/**
 * Formats worth relaying. JPEG and PNG embed directly; the rest are converted in the browser when
 * it can decode them. Everything else — HTML error pages, SVG, PDFs — is refused.
 */
const RELAYED_FORMATS: ReadonlySet<ImageFormat> = new Set([
  'jpeg',
  'png',
  'webp',
  'gif',
  'avif',
  'heic',
  'bmp',
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Identifies the proxy to origin servers without revealing anything about the customer. */
const USER_AGENT = 'DocumentGeneratorImageProxy/1.0';

/** The rules deciding where the proxy may connect. Replaced only in tests. */
export interface NetworkPolicy {
  /** Throws when a URL must not be requested. Runs for the first URL and for every redirect. */
  assertUrl(url: URL): void;
  /** DNS resolution used for the outgoing socket. */
  lookup: LookupFunction;
  /** Final check on the address the socket actually connected to. */
  isAllowedAddress(address: string): boolean;
}

export const STRICT_NETWORK_POLICY: NetworkPolicy = {
  assertUrl: assertSafeUrl,
  lookup: createGuardedLookup(),
  isAllowedAddress: isPublicIp,
};

export interface FetchImageOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  /** Aborts the upstream request, e.g. when the browser cancelled its own request. */
  signal?: AbortSignal;
  policy?: NetworkPolicy;
}

export interface FetchedImage {
  /** Determined from the bytes, never from the origin's `Content-Type`. */
  format: ImageFormat;
  contentType: string;
  bytes: Uint8Array<ArrayBuffer>;
}

function requestOnce(
  url: URL,
  policy: NetworkPolicy,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      url,
      {
        method: 'GET',
        // A fresh connection per request: nothing is pooled, so nothing outlives its checks.
        agent: false,
        lookup: policy.lookup,
        signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'image/*,*/*;q=0.5',
          // Images are already compressed; asking for raw bytes keeps size accounting exact.
          'Accept-Encoding': 'identity',
        },
      },
      (response) => {
        const address = response.socket.remoteAddress;
        if (!address || !policy.isAllowedAddress(address)) {
          response.destroy();
          reject(new ProxyError('BLOCKED_DESTINATION', 'This image address is not allowed.'));
          return;
        }
        resolve(response);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/** Undoes a transfer encoding the origin applied despite being asked not to. */
function decodedBody(response: IncomingMessage): Readable {
  const encoding = String(response.headers['content-encoding'] ?? 'identity')
    .trim()
    .toLowerCase();
  const ignoreError = () => {
    // Failures surface to whoever is reading the last stream of the pipeline.
  };
  switch (encoding) {
    case '':
    case 'identity':
      return response;
    case 'gzip':
    case 'x-gzip':
      return pipeline(response, createGunzip(), ignoreError);
    case 'deflate':
      return pipeline(response, createInflate(), ignoreError);
    case 'br':
      return pipeline(response, createBrotliDecompress(), ignoreError);
    default:
      response.destroy();
      throw new ProxyError('UPSTREAM_ERROR', 'The image host used an unsupported encoding.');
  }
}

async function readImage(response: IncomingMessage, maxBytes: number): Promise<FetchedImage> {
  const tooLarge = () =>
    new ProxyError(
      'IMAGE_TOO_LARGE',
      `The image is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`,
    );

  const declared = Number(response.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy();
    throw tooLarge();
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of decodedBody(response) as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > maxBytes) throw tooLarge();
      chunks.push(chunk);
    }
  } finally {
    response.destroy();
  }

  const bytes = new Uint8Array(Buffer.concat(chunks, total));
  const format = detectImageFormat(bytes);
  if (!format || !RELAYED_FORMATS.has(format)) {
    throw new ProxyError(
      'NOT_AN_IMAGE',
      'The link did not return an image. Check that it is a direct, publicly shared image link.',
    );
  }
  return { format, contentType: IMAGE_MIME_TYPES[format], bytes };
}

/**
 * Downloads the image at `initialUrl`, following redirects, and returns its verified bytes.
 * Throws `ProxyError` for every failure a caller can act on.
 */
export async function fetchImage(
  initialUrl: URL,
  options: FetchImageOptions,
): Promise<FetchedImage> {
  const policy = options.policy ?? STRICT_NETWORK_POLICY;
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;

  try {
    let url = initialUrl;
    for (let hop = 0; ; hop++) {
      policy.assertUrl(url);
      const response = await requestOnce(url, policy, signal);
      const status = response.statusCode ?? 0;

      if (REDIRECT_STATUSES.has(status)) {
        response.destroy();
        if (hop >= options.maxRedirects) {
          throw new ProxyError('TOO_MANY_REDIRECTS', 'The image link redirects too many times.');
        }
        const location = response.headers.location;
        if (!location || !URL.canParse(location, url)) {
          throw new ProxyError('UPSTREAM_ERROR', 'The image host sent an invalid redirect.');
        }
        url = new URL(location, url);
        continue;
      }

      if (status !== 200) {
        response.destroy();
        throw new ProxyError('UPSTREAM_ERROR', `The image host answered with HTTP ${status}.`);
      }

      return await readImage(response, options.maxBytes);
    }
  } catch (error) {
    if (error instanceof ProxyError) throw error;
    if (deadline.aborted) {
      throw new ProxyError('UPSTREAM_TIMEOUT', 'The image host took too long to respond.', {
        cause: error,
      });
    }
    // The caller went away: let the abort propagate untouched.
    if (options.signal?.aborted) throw error;
    throw new ProxyError('UPSTREAM_ERROR', 'The image could not be downloaded from its host.', {
      cause: error,
    });
  }
}
