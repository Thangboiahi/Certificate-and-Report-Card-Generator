# Architecture

How the system works **today** (end of session 10: Phase 8 built, Phase 7 partly). Reasons for the choices are in
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
images that browsers cannot fetch themselves (CORS), and takes claim-fee payments (Razorpay).
Firebase Auth and Firestore rules run against the local emulators and Razorpay against a local mock;
live Firebase, Storage, Sheets, Drive and Razorpay accounts are **not connected yet**.

## Code map

| Path                                         | Purpose                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/lib/template/`                          | Template schema (`types.ts`), runtime validation (`schema.ts`), data bindings (`bindings.ts`) |
| `src/lib/pdf-engine/`                        | The generation engine. Only place that imports pdf-lib / fontkit                              |
| `src/lib/images/`                            | Image sniffing by magic bytes, EXIF orientation. Pure, shared by server and engine            |
| `src/lib/image-proxy/`                       | Proxy logic: auth, SSRF defences, safe fetch, handler (framework-independent)                 |
| `src/app/api/proxy-image/`                   | Thin Next.js route over the handler                                                           |
| `src/workers/`                               | Web Worker, comlink client, image loader, canvas image processor                              |
| `src/types/roles.ts`                         | Roles, claims contract, institution / vault item schemas                                      |
| `src/lib/auth/`, `src/proxy.ts`              | Claims management, sessions, route protection, server-side guards                             |
| `src/app/api/auth/session/`                  | Creates / clears the session cookie                                                           |
| `firebase/`, `firebase.json`                 | Firestore security rules and their emulator tests                                             |
| `src/components/ui/`, `src/lib/utils/`       | Upload gateway (Phase 2): dropzone, crop and CSV preview modals, image and CSV helpers        |
| `src/store/templateStore.ts`                 | Editor state (Zustand): active template in points, selection, preview rows (Phase 4)          |
| `src/lib/editor/`                            | Percent ↔ point conversion, pdf.js page display, CSS preview of fields                        |
| `src/components/canvas/`                     | Tap-to-Place canvas (`MobileEditor`) and its bottom sheet (`PropertyBar`)                     |
| `src/components/dashboard/`                  | `WorkspaceToggle`: vault ⇄ issuer workspaces                                                  |
| `src/app/editor/`                            | The editor screen (sample template until template upload is wired)                            |
| `src/app/dashboard/(workspace)/`             | Vault and issuer pages sharing the toggle layout                                              |
| `src/lib/dispatch/`, `src/app/api/dispatch/` | WhatsApp / email claim-link dispatch with the credit ledger (Phase 5)                         |
| `src/lib/crm/`, `src/types/crm.ts`           | Credential-request stages and Kanban board state                                              |
| `src/lib/claim/`, `src/app/claim/`           | Claim links: contact matching, free claims, minting into the vault, the claim page (Phase 7)  |
| `src/lib/razorpayClient.ts`                  | Typed Razorpay REST client and webhook signature check (Phase 8)                              |
| `src/lib/payments/`, `src/types/payments.ts` | Cart pricing and split, escrow engine, checkout / webhook / sweep handlers (Phase 8)          |
| `src/app/api/checkout/`, `api/webhooks/`     | Thin routes over `src/lib/payments/handler.ts`                                                |
| `src/app/playground/`                        | Developer harness that runs the whole stack on a sample job                                   |
| `tests/`, `scripts/`, `public/samples/`      | Test support and fixtures, e2e script and asset generators, sample template and photos        |

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
Browser ── /login or /claim: email link / SMS code (Firebase client SDK) ── ID token
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

`/login` (public, no rule) shows `PasswordlessSignIn`; after the cookie is set it reloads, and the server component
reads the verified session and redirects with `postLoginPath` (`src/lib/auth/access.ts`): `inst_admin`/`inst_staff` →
`/dashboard/institution`, `individual` → `/dashboard/vault`, `super_admin` → `/admin`, or a safe `?next=` the person
may open. The role is never taken from the browser.

| Path                       | Who                               |
| -------------------------- | --------------------------------- |
| `/admin/*`                 | super_admin                       |
| `/dashboard/institution/*` | inst_admin, inst_staff            |
| `/dashboard/vault/*`       | any signed-in, non-anonymous user |
| `/dashboard/issue/*`       | any signed-in, non-anonymous user |
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

## Tap-to-Place editor (Phase 4)

```
templateStore (Zustand) ── activeTemplate in POINTS ──────────────► generatePdfBatch (worker)
   ▲  updatePlaceholderCoords(id, x%, y%) · nudgePlaceholder(id, dx pt, dy pt) · setFontSize
   │
MobileEditor ── per page: <div aspect-ratio=w/h, container-type=inline-size>
   │              ├ <canvas> ← pdf.js (own worker) renders the background
   │              └ <button> per field: left/top/width/height in %, font-size in cqw
   └ PropertyBar (Framer Motion bottom sheet): D-pad 1/10 pt, font size, swipe to close
```

- The store is the single place that converts: percent of the field's own page → points,
  clamped to the page, rounded to 1/100 pt (`src/lib/editor/coordinates.ts`). Rendering converts
  back (`boxToPercent`). Edits replace only the touched placeholder object; canvas items are
  memoised on it.
- Gestures: tap selects; drag moves (touch: selected field only, so swipes scroll); tapping the
  page with a field selected centres it there; arrow keys nudge. Drag deltas are pixels divided
  by the page's on-screen width.
- pdf.js is loaded on first use (`src/lib/editor/pdf-preview.ts`) and parses in
  `src/workers/pdfjs.worker.ts`. Each page re-renders on resize at device pixel ratio (≤ 3×,
  ≤ 4,096 px). A page whose real size differs from `template.pages` by more than 0.5 pt shows a
  warning.
- Field previews are HTML text using the template's fonts (standard fonts → similar CSS faces;
  library fonts registered with `FontFace`). The engine's shrink-to-fit and shaping are not
  reproduced; `/editor`'s "Test PDF" runs the real worker on the previewed row.
- ADR-022.

## App shell and editor entry (Phase 11)

- `src/app/dashboard/layout.tsx` renders `AppHeader` (Avatar menu, Sign out) above every `/dashboard/*` page. The header only
  displays the session; pages and the proxy still decide access. Sign out: `signOutEverywhere` (`src/lib/firebase.ts`) ->
  `DELETE /api/auth/session` -> full load of `/login`.
- `/editor` shows `EditorGateway` while `templateStore.activeTemplate` is `null`. An uploaded PDF is used as is, a PNG/JPG is
  wrapped by `imageToPdf` (engine); `readPdfPages` gives the page sizes; `buildStarterTemplate` makes the template (one field
  per CSV column). The editor keeps the background bytes in component state (`EditorSession`); "Test PDF" hands the worker a
  copy. Nothing is stored. ADR-032.
- Failures surface as toasts: `Toaster` and `GlobalErrorToasts` in the root layout, `notifyError` (`src/lib/ui/notify.ts`) in
  components, `src/app/error.tsx` for render errors.

## Workspaces

`src/app/dashboard/(workspace)/layout.tsx` wraps `/dashboard/vault` and `/dashboard/issue` in
`WorkspaceToggle` (shadcn Tabs). The active tab is derived from the path; choosing one navigates
(optimistic highlight); the page is the active tab's panel. Each page checks access itself.
ADR-023.

## Dispatch (Phase 5)

```
POST /api/dispatch/{whatsapp|email}   (institution admin/staff, session cookie, same-origin)
  │ validate body (≤ 500 targets, phone/email, claim token, expiry in future, no duplicates)
  ▼
Tx 1: membership ✓ verified ✓ template ✓ balance ≥ n ✓ → creditBalance −= n,
      dispatches/{id} = sending, issued_batches/{id} = sending
  ▼
mint n tokens (256-bit) → claim_tokens/{sha256} = recipient, expiresAt, purgeAfter
  ▼
provider: Meta Cloud API (8 parallel)  |  Resend batch (100 per call, idempotency key)
  ▼
Tx 2: creditBalance += failed, dispatches/{id} = completed + per-recipient results,
      issued_batches/{id} = completed + counts
```

`id = sha256(institution, channel, idempotencyKey)`: a repeated key returns the stored outcome
without sending or charging. Links are `APP_ORIGIN/claim/{token}`. Environment variables in
`.env.example`; each channel returns 503 until configured. `dispatches` is server-only in the
Firestore rules. ADR-024.

## Audit ledger and claim tokens (Phase 6)

- `issued_batches/{id}`: one per dispatch; read server-side by `listIssuedBatches` and shown by
  `AuditLedger` (TanStack Table) on `/dashboard/institution` and `/dashboard/issue`.
- `claim_tokens/{sha256(token)}`: recipient name and contact, `expiresAt`, `purgeAfter`
  (= expiry + 30 days), `claimedAt`. `verifyClaimToken` refuses expired tokens immediately.
- `POST /api/dispatch/reissue {batchId}`: unclaimed recipients get fresh tokens and a new expiry
  (now + original validity) through the original channel; no credits; ≤ 3 per batch, 10 minutes
  apart.
- `POST /api/cron/purge-claim-tokens` (Bearer `CRON_SECRET`, Cloud Scheduler daily): deletes
  tokens past `purgeAfter`, marks batches with no tokens left as purged.
- Both collections are server-only; indexes in `firebase/firestore.indexes.json`. ADR-026.

## Pay-to-claim escrow (Phase 8)

```
Recipient (signed in with the contact the link was sent to)
  │ POST /api/checkout { token, addOns? }
  ▼
server: cart = Base Fee (token.feePaise) [+ AI add-on]  ── split: issuer = Base − platform fee
  │ Razorpay POST /orders { amount, transfers: [{ account: institution.razorpayAccountId,
  │                                               amount: issuer share, on_hold, on_hold_until }] }
  ▼
claim_orders/{orderId} = created ──► browser opens Razorpay Checkout, then polls GET /api/checkout
                                                                              │
Razorpay ── POST /api/webhooks/razorpay (payment.captured, X-Razorpay-Signature)│
  │ verify HMAC over raw bytes ✓                                               │ every ≥ 5 s:
  ▼                                                                            ▼ GET /orders/{id}/payments
settleCapturedPayment (one transaction) ◄──────────────────────────────────────┘ (also the 15-min sweep)
  ├─ ours? amount & currency match? token present and unclaimed?
  ├─ yes → vault_items/{tokenId} created, token claimed, batch claimedCount+1, order paid
  └─ no  → order refund_due (+ reason) → refund with reverse_all (transfer taken back) → refunded
```

- On capture Razorpay creates the transfer; it stays on hold (`ESCROW_HOLD_DAYS`, default 7) in the
  institution's Route balance before settling to its bank.
- The browser's Checkout callback is not trusted for anything; it only starts the polling.
- Pricing: `pricingFromEnv()` (`PLATFORM_FEE_BPS`, `AI_ENRICHMENT_FEE_PAISE`, `ESCROW_HOLD_DAYS`);
  a malformed value disables payments (503) rather than charging something else.
- Every step is idempotent (webhook replays, webhook vs poll vs sweep races). Refunds that fail
  leave `refundPending: true` for the next poll or sweep.
- `POST /api/cron/reconcile-payments` (Bearer `CRON_SECRET`): open orders 2 min – 3 days old and
  every order with `refundPending`. Shared cron authorisation: `src/lib/server/cron-auth.ts`.
- Dispatch refuses a claim fee when the institution has no `razorpayAccountId`.
- `claim_orders` is server-only in the rules; the composite index (status, createdAt) is in
  `firebase/firestore.indexes.json`. ADR-028.

## AI tools (Phase 9)

Two things happen to a sheet before documents are generated, both through Gemini and both on the
editor screen (`/editor`): **AI Magic** adds a column (translation, remark, custom) and **Smart Audit**
reviews the rows and applies bulk fixes written in plain language. ADR-029.

    browser                                   server                              Google
    AiMagicButton ─┐                          POST /api/ai/enrich ─┐
    SmartAuditCarousel ─ geminiClient.ts ───► POST /api/ai/audit  ─┴ handler.ts ─► gemini.ts ─► Gemini
          │            (validates answers)     same-origin, session, zod            (key, JSON mode, retry)
          ▼
    templateStore.applyAiPatch ◄── AuditPatch (schema.ts: allow-listed, applied to the real state)

- `src/lib/ai/schema.ts` — pure and shared: limits, zod schemas, `AuditPatch`, `buildAuditContext`
  (what the model sees), `applyAuditPatch` (what it may change), `filterPatchToContext`.
- The patch holds column rules (`uppercase`, `lowercase`, `titlecase`, `trim`, `collapse_spaces`),
  single-cell fixes for sampled rows, and text-styling changes. It is never code and never trusted:
  unknown rows, columns and placeholders are skipped and reported.
- `AI_NOT_CONFIGURED` (503) until `GEMINI_API_KEY` is set. Use is not metered yet.

## CRM board (Phases 5 and 12)

`KanbanBoard` (`@hello-pangea/dnd`) shows credential requests in four stages; state logic in `src/lib/crm/board.ts`. Since
Phase 12 (ADR-033) the cards live in the server-only Firestore collection `credential_requests`:

- `RequestsSection` (server component, on `/dashboard/institution` and `/dashboard/issue`) loads the caller's board with the
  Admin SDK (`src/lib/crm/requests.ts`) and renders `LiveKanban`, or `IndexErrorAlert` if Firestore reports a missing index.
- `LiveKanban` (client) saves drags with `PATCH /api/requests`, adds cards with `POST`, and re-reads with `GET` every 15 s and on
  focus. It shows "No active requests" when the board is empty.
- Board scope comes from the session: `inst:<institutionId>` for institution staff and admins, `uid:<uid>` otherwise.
- Column order is a per-card number (midpoint inserts, `src/lib/crm/order.ts`); no composite index.

The vault page (`/dashboard/vault`) reads `vault_items` the same way (`listVaultItems`) and shows `IndexErrorAlert` with the Firebase
Console link when the `ownerUid` + `issuedAt` index is missing.

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

- `npm test` — 567 unit/integration tests (Node). Engine tests render PDFs with poppler
  (`pdftoppm`/`pdftotext`) and assert on pixels and word positions; they skip without poppler.
- `tests/showcase.test.ts` writes pictures to `tests/output/` for visual review.
- `node scripts/e2e-playground.mjs` (after `npm run build`) — production server + Chromium.
- `node scripts/e2e-ai.mjs` (after `npm run build`) — AI Magic and the Smart Audit carousel in
  Chromium with `/api/ai/*` stubbed; also checks the real routes refuse anonymous and cross-origin callers.
- `npm run test:emulator` — 70 tests against the Firebase Auth + Firestore emulators (claims,
  sessions, proxy, rules, dispatch, the escrow engine).
- `firebase emulators:exec --only auth,firestore --project demo-v6 'node scripts/e2e-auth.mjs'`
  (after `npm run build`) — 53 auth checks against the production server, including the
  workspace toggle in Chromium.
- `firebase emulators:exec --only auth,firestore --project demo-v6 'node scripts/e2e-dispatch.mjs'`
  (after `npm run build`) — 44 checks: dispatch routes against a recording mock of Meta and
  Resend, credits, claim tokens, the audit ledger and re-issue, the purge route, and the Kanban
  board in Chromium.
- `node scripts/e2e-editor.mjs` (after `npm run build`) — the editor on a touch phone and a
  desktop: rendering, alignment, D-pad, font size, drag, tap-to-place, swipe-to-close, and the
  worker's PDF read back with `pdftotext -bbox`.
- `firebase emulators:exec --only auth,firestore --project demo-v6 'node scripts/e2e-checkout.mjs'`
  (after `npm run build`) — 52 checks: checkout, signed / forged webhooks, minting, replays,
  reconciliation, refunds with `reverse_all` against a recording mock of Razorpay's API, and the
  claim page on a phone in Chromium with Razorpay Checkout stubbed.
