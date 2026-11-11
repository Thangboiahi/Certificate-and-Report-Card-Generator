/**
 * Failures the image proxy reports to its caller. `code` is a stable, machine-readable contract
 * (the generation report shows a message per code); `status` is the HTTP status the route sends.
 * Messages are written for the end user and never include upstream response bodies.
 */
export type ProxyErrorCode =
  | 'UNAUTHENTICATED'
  | 'SERVER_MISCONFIGURED'
  | 'MISSING_URL'
  | 'INVALID_URL'
  | 'BLOCKED_DESTINATION'
  | 'TOO_MANY_REDIRECTS'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'NOT_AN_IMAGE'
  | 'IMAGE_TOO_LARGE';

const STATUS_BY_CODE: Record<ProxyErrorCode, number> = {
  UNAUTHENTICATED: 401,
  SERVER_MISCONFIGURED: 500,
  MISSING_URL: 400,
  INVALID_URL: 400,
  BLOCKED_DESTINATION: 403,
  TOO_MANY_REDIRECTS: 502,
  UPSTREAM_ERROR: 502,
  UPSTREAM_TIMEOUT: 504,
  NOT_AN_IMAGE: 415,
  IMAGE_TOO_LARGE: 413,
};

export class ProxyError extends Error {
  readonly code: ProxyErrorCode;
  readonly status: number;

  constructor(code: ProxyErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProxyError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}
