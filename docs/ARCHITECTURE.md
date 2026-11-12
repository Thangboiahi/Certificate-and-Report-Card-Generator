# Architecture

How the system works **today** (end of session 2). Reasons for the choices are in
[DECISIONS.md](./DECISIONS.md); status and roadmap are in [PLAN.md](./PLAN.md).

## Overview

```
 Browser (customer's phone or laptop)                         Cloud Run (Next.js 16)
┌──────────────────────────────────────────────┐            ┌────────────────────────┐
│ Page (React)                                  │            │ App shell + API routes │
│   │  comlink                                  │   HTTPS    │                        │
│   ▼                                           │ ─────────► │ GET /api/proxy-image   │
│ Web Worker ── src/workers                     │  (photos)  │  auth → SSRF checks →  │
│   │ loads images (proxy), shrinks them        │ ◄───────── │  fetch → sniff → relay │
│   ▼                                           │            └────────────────────────┘
│ PDF engine ── src/lib/pdf-engine (pdf-lib)    │
│   template + fonts + rows ─► PDF files        │
└──────────────────────────────────────────────┘
```

Documents are generated in the browser. The server only authenticates, serves the app and relays
images that browsers cannot fetch themselves (CORS). Firebase, Firestore, Storage, Sheets, Drive
and Razorpay are **not wired yet** (milestones M1–M6).

## Code map

| Path                                    | Purpose                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/lib/template/`                     | Template schema (`types.ts`), runtime validation (`schema.ts`), data bindings (`bindings.ts`) |
| `src/lib/pdf-engine/`                   | The generation engine. Only place that imports pdf-lib / fontkit                              |
| `src/lib/images/`                       | Image sniffing by magic bytes, EXIF orientation. Pure, shared by server and engine            |
| `src/lib/image-proxy/`                  | Proxy logic: auth, SSRF defences, safe fetch, handler (framework-independent)                 |
| `src/app/api/proxy-image/`              | Thin Next.js route over the handler                                                           |
| `src/workers/`                          | Web Worker, comlink client, image loader, canvas image processor                              |
| `src/types/roles.ts`                    | Roles, claims contract, institution / vault item schemas                                      |
| `src/lib/auth/`, `src/proxy.ts`         | Claims management, sessions, route protection, server-side guards                             |
| `src/app/api/auth/session/`             | Creates / clears the session cookie                                                           |
| `firebase/`, `firebase.json`            | Firestore security rules and their emulator tests                                             |
| `src/app/playground/`                   | Developer harness that runs the whole stack on a sample job                                   |
| `tests/`, `scripts/`, `public/samples/` | Test support and fixtures, e2e script and asset generators, sample template and photos        |

## Template schema

A template is a background PDF plus placeholders (`text`, `image`, `qr`), each with `pageIndex`
and a `box` in points from the top-left of the displayed page. Text has font, colour, alignment,
`lineHeight` and fit rules (wrap, shrink-to-fit, min size, max lines, overflow). Images have
`cover` / `contain` / `fill`, `position`, shape and border. QR codes have error correction and
quiet zone. Bindings pull values by column, `{{token}}` template or static value. Full contract:
`src/lib/template/types.ts`.

## Engine

`generateDocuments(job, dependencies, handlers)`:

1. Validate the template; load the template PDF; check its pages match the template.
2. Build the font registry (one shared parsed font per job).
3. For each row: **plan** (resolve values; a missing required value fails the row), **prepare**
   (async: fonts, images, QR matrices), **draw** (synchronous, so pages are never half drawn).
4. `separate` mode loads the template per row; `merged` mode embeds template pages once and
   stamps them, optionally splitting into files (`rowsPerFile`).
5. Each finished file goes to `onDocument`, which is awaited (back-pressure); progress goes to
   `onProgress`; cancellation uses an `AbortSignal`.

Row problems are reported, not thrown. Job-level problems throw `EngineError` with a code.

### Coordinates and pages

`geometry.ts` maps the template's page space to PDF user space once per page (handles `/Rotate`
and offset crop boxes); each placeholder then draws in its own box-local frame with rotation
about its centre. Verified for 0/90/180/270 and offset origins in both output modes.

### Text

Words are split into single-script runs, shaped with fontkit (glyphs **and** positions), and
written as `TJ` operators with per-glyph adjustments. Layout (`text-layout.ts`) is pure: wrap,
bisection shrink-to-fit, max lines, ellipsis. Standard fonts get kerning from pdf-lib's tables.
fontkit is hardened against two failures found with real Indian fonts (missing regenerator
runtime; empty mark anchors in Telugu/Malayalam/Gurmukhi); if shaping still throws, the word
falls back and a `TEXT_SHAPING_DEGRADED` warning is raised. Not supported: right-to-left
scripts (warned).

### Images

JPEG/PNG embedded directly; EXIF orientation applied through the image transform; fit/position
computed in `geometry.ts` and clipped to rectangle, rounded rectangle or ellipse. The image
store deduplicates downloads, limits concurrency, prefetches upcoming rows and bounds memory.
A photo used in several boxes of one row is fetched and embedded once, sized for the largest box.
In the browser, an optional processor shrinks photos to the pixel size the box needs and
converts WebP/GIF/AVIF.

### EXIF orientation

PDF paints an image into the unit square with the stored top row at y = 1. For each of the eight
orientations `draw-image.ts` holds the matrix that turns the stored square upright; the result
is then scaled into the fitted rectangle. Tested for all eight with pixel checks.

## Image proxy (`/api/proxy-image?url=…`)

Request: `Authorization: Bearer <Firebase ID token>`. Success: raw image bytes. Failure: JSON
`{ error: { code, message } }`. Layers (details in ADR-005): auth, URL rules, address blocklists
(IPv4, IPv6, IPv4-in-IPv6), DNS pinning, post-connect check, manual redirects, size and time
limits, magic-byte verification, hardened response headers, host-only logging. Settings are read
from environment variables (`.env.example`).

The route calls `await connection()` so Next 16 never prerenders it.

## Authentication and roles (V6 Phase 1)

```
Browser ── Google Sign-In (Firebase client SDK) ── ID token
   │ POST /api/auth/session  (same-origin, fresh sign-in, not anonymous)
   ▼
__session cookie (httpOnly, Secure, SameSite=Lax, 5 days)
   │ every request
   ▼
src/proxy.ts ── verify cookie (Admin SDK) ── route rules ── 307 /login · 403 · next
   │                (+ revocation check on /admin, /dashboard/institution)
   ▼
pages / route handlers / server actions ── requireRouteAccess() / authorize()   (verify again)
```

| Path                       | Who                               |
| -------------------------- | --------------------------------- |
| `/admin/*`                 | super_admin                       |
| `/dashboard/institution/*` | inst_admin, inst_staff            |
| `/dashboard/vault/*`       | any signed-in, non-anonymous user |
| `/dashboard/*` (other)     | any signed-in user (fail closed)  |
| `/editor`                  | everyone, including guests        |

- **Roles** (`src/types/roles.ts`): guest and individual are derived from the token; the elevated
  roles are custom claims `{ role, institutionId? }`. Pure logic (claim parsing, route table,
  decisions) is in `src/lib/auth/access.ts` and shared by the proxy, server code and tests.
- **Claims management** (`src/lib/auth/customClaims.ts`): `setUserRole` / `grantSuperAdmin` /
  `setInstitutionRole` / `removeElevatedRole`, keeping `institutions/{id}` directory fields in step
  and revoking sessions on demotion. Verification helpers return `null` for bad tokens and throw
  when verification cannot run.
- **Firestore rules** (`firebase/firestore.rules`): see ADR-018. Deploy with
  `firebase deploy --only firestore:rules` (config in `firebase.json`).
- Environment: `FIREBASE_PROJECT_ID` (required), `APP_ORIGIN` (optional, public origin for the
  session route's same-origin check behind a proxy).

## Web Worker

`createPdfEngineClient()` starts the worker and wraps it with comlink. Callbacks (`onDocument`,
`onProgress`, `getAuthToken`) are proxied; finished files are transferred, not copied; failures
are returned as data and rebuilt as `EngineError`. The worker picks image sources in order:
caller-supplied local file → same-origin fetch → proxy with the user's token.

## Deployment

`next.config.ts` sets `output: 'standalone'`. The `Dockerfile` (three stages, Node 24 slim,
non-root user, `PORT=8080`, `HOSTNAME=0.0.0.0`) packages `.next/standalone`.
**Not yet built or run** — see DEVLOG. The standalone server itself was exercised by
`scripts/e2e-playground.mjs`.

Cloud Run notes for when it is deployed:

- The proxy buffers images: peak memory ≈ `IMAGE_PROXY_MAX_BYTES` × concurrent requests. Start
  with 512 MiB–1 GiB and concurrency ≤ 20, then tune from metrics.
- Set `FIREBASE_PROJECT_ID`. Cloud Run sets `K_SERVICE`, which permanently disables the
  anonymous development mode.
- Region: asia-south1 (Mumbai) recommended (PLAN.md, E3).

## Testing

- `npm test` — 430 unit/integration tests (Node). Engine tests render PDFs with poppler
  (`pdftoppm`/`pdftotext`) and assert on pixels and word positions; they skip without poppler.
- `tests/showcase.test.ts` writes pictures to `tests/output/` for visual review.
- `node scripts/e2e-playground.mjs` (after `npm run build`) — production server + Chromium.
- `npm run test:emulator` — 34 tests against the Firebase Auth + Firestore emulators (claims,
  sessions, proxy, rules).
- `firebase emulators:exec --only auth,firestore --project demo-v6 'node scripts/e2e-auth.mjs'`
  (after `npm run build`) — 47 auth checks against the production server.
