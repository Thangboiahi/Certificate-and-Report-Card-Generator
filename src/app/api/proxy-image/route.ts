/**
 * GET /api/proxy-image?url=<image address>
 *
 * Why this exists: documents are generated in the browser (a Web Worker running pdf-lib), and the
 * photos to place on them live on other websites. Browsers refuse to hand a page the bytes of a
 * cross-origin image unless that site opts in (CORS), and most do not. This route fetches the
 * image server-side and relays it from our own origin, so the Worker can read it.
 *
 * Request:   `Authorization: Bearer <Firebase ID token>`
 * Success:   200 with the raw image bytes — read them with `response.arrayBuffer()`.
 * Failure:   JSON `{ "error": { "code", "message" } }` with a 4xx/5xx status.
 *
 * All behaviour lives in `src/lib/image-proxy/` (security model: `ssrf.ts`, `safe-fetch.ts`).
 */
import { connection, type NextRequest } from 'next/server';

import { handleProxyImageRequest } from '@/lib/image-proxy/handler';

export async function GET(request: NextRequest): Promise<Response> {
  // Marks the handler as request-time only. With Cache Components enabled, Next.js would
  // otherwise try to prerender GET handlers at build time; a proxy must never be cached.
  await connection();
  return handleProxyImageRequest(request);
}
