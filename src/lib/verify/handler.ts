/**
 * `POST /api/verify/mint` (Phase 14, ADR-035): pre-mints verification ids for a batch of documents
 * before their QR codes are drawn.
 *
 *   { "credentialName": "Class 10 certificate", "recipientNames": ["Asha Rao", null, ...] }
 *   → 200 { "items": [{ "id": "<43 chars>", "url": "https://app.example.in/verify/<id>" }, ...] }
 *
 * Same-origin, session cookie, any signed-in user (an institution's staff, or a Micro-Issuer). The
 * items come back in the order of `recipientNames`. Addresses are built from `APP_ORIGIN`; only
 * when that is unset (local development) from this request's own origin.
 */
import 'server-only';

import { adminFirestore, FirebaseConfigError } from '@/lib/server/firebase-admin';
import { error, gate, json, log } from '@/lib/server/json-route';

import { verifyUrl } from './ids';
import { mintStubs, parseMint, StubError } from './stubs';

function originFor(request: Request): string {
  const configured = process.env.APP_ORIGIN?.trim();
  return configured && URL.canParse(configured)
    ? new URL(configured).origin
    : new URL(request.url).origin;
}

export async function handleMint(request: Request): Promise<Response> {
  const checked = await gate(
    request,
    { kind: 'signed-in' },
    'Sign in to create verification codes.',
  );
  if (!checked.ok) return checked.response;
  try {
    const input = parseMint(checked.body);
    const ids = await mintStubs(adminFirestore(), checked.user, input);
    const origin = originFor(request);
    return json(200, { items: ids.map((id) => ({ id, url: verifyUrl(origin, id) })) });
  } catch (cause) {
    if (cause instanceof StubError) return error(400, cause.code, cause.message);
    log('ERROR', 'verification mint failed', { cause: String(cause) });
    if (cause instanceof FirebaseConfigError) {
      return error(500, 'SERVER_MISCONFIGURED', 'The database is not configured on the server.');
    }
    return error(503, 'UNAVAILABLE', 'Verification codes could not be created. Try again shortly.');
  }
}
