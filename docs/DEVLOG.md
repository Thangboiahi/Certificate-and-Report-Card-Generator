# Development Log

A dated entry for every working session, newest first: what was done, what was learned, how it
was verified, and what is left open. The line-by-line history is in git; this file is the story.

---

## 2026-11-12 — Session 10: Phase 8, escrow payment engine (Razorpay Route)

**Built.**

- `src/lib/razorpayClient.ts`: typed client over `fetch` — orders with Route `transfers`, an
  order's payments, payment fetch, refund (`reverse_all`), exact webhook signature check
  (HMAC-SHA256 over the raw bytes, constant-time); `getRazorpayClient()` initialised from the
  environment. Replaces `src/lib/claim/razorpay.ts`.
- `src/lib/payments/pricing.ts`: server-priced cart (Base Fee + optional AI add-on), platform/issuer
  split never below Razorpay's ₹1 transfer minimum, pricing from the environment.
- `src/lib/payments/escrow.ts`: `createClaimCheckout`, `settleCapturedPayment` (mint or refund due,
  one transaction), `refundOutstanding`, `reconcileOrder`, `getCheckoutStatus`,
  `reconcileOpenCheckouts`. `claim_orders/{orderId}` ledger.
- Routes: `POST /api/checkout`, `GET /api/checkout?orderId=`, `POST /api/webhooks/razorpay`,
  `POST /api/cron/reconcile-payments` (cron auth now shared in `src/lib/server/cron-auth.ts`).
- Claim page: cart with the AI add-on, Razorpay Checkout, then polling until the server confirms.
- `InstitutionSchema.razorpayAccountId` (rules: super admins only, `acc_…` format); `claim_orders`
  closed in the rules; composite index; dispatch refuses a claim fee without a payout account.
- Phase 7 WIP payment path removed (`/api/claim/order`, payment proof in `/api/claim`): it minted
  from the browser's Checkout signature. `/api/claim` is now for free credentials only.
- ADR-027 (Phase 7 decisions, written now), ADR-028. `.env.example`, `CLAUDE.md` updated.

**Decided beyond the brief.** The AI add-on is off unless `AI_ENRICHMENT_FEE_PAISE` is set (Phase 9
has not defined it; we should not sell it yet). Issuer share held 7 days (the "escrow"). Captures
that cannot be honoured are refunded automatically. A capture after link expiry is honoured when
checkout began in time. No `razorpay` npm package (reasons in ADR-028).

**Found and fixed.** A refund for an amount-mismatch capture used the order's amount instead of
the captured amount (Razorpay would refuse it); refunds now record and use the captured amount. The
auth emulator test still expected the pre-Phase-7 session shape (no `phoneNumber` /
`emailVerified`) and had been failing since session 9.

**Verified.**

- 544 unit tests (34 new): client request shapes, auth header, error mapping, id validation (no
  malformed id reaches a URL), RFC 4231 HMAC vector, signature rejects one changed byte /
  re-serialised JSON / wrong secret / bad lengths; pricing defaults, overrides, malformed env,
  split invariants over 0–50 % fees and ₹1–₹10,000; the webhook touches no database before the
  signature passes (unsigned, forged, tampered, invalid UTF-8, oversized, other events).
- 70 emulator tests (20 new): checkout split and hold; eight refusals that open nothing at
  Razorpay; mint once under six racing deliveries; replays; unknown orders and non-captured
  payments ignored; refunds with `reverse_all` for duplicate purchase, purged link, amount
  mismatch, stray capture; failed refund retried; refund already made recognised; status poll
  throttled to 5 s and settles a lost webhook; sweep window (2 min – 3 days) and refund retries;
  dispatch payout guard charges nothing; rules for `razorpayAccountId` and `claim_orders`.
- `scripts/e2e-checkout.mjs`, 52/52 on the production build with a recording mock of Razorpay:
  401/403/409/400 refusals; client-sent amount ignored; ₹149 order with a ₹90 transfer to the
  Linked Account held 7 days, no personal data sent; five forged webhook variants rejected with
  nothing minted; signed capture mints; replay idempotent; pull reconciliation; duplicate payment
  refunded with `reverse_all`; sweep route auth; claim page on a Pixel 7 profile: cart ₹100 → ₹149
  with the add-on, stubbed Checkout, "Added to your vault" after the signed webhook, no script
  errors. Screenshots in `tests/output/e2e-checkout-*.png`.
- e2e-dispatch and e2e-auth (53/53) still pass; `npm run verify` clean.

**Not verified.** Nothing ran against Razorpay itself (no keys, E13): real Checkout, Route
transfers, webhook delivery and whether `reverse_all` catches a transfer created at capture.
Recipients in the tests were created with verified emails directly: the Phase 7 email-link and
phone-OTP sign-in in the browser is still untested.

**Open.** Phase 7 items (VaultDashboard, `/v/[shareId]`, `/login`, sign-in e2e); Razorpay test mode
(E13) and Linked Account onboarding (E19); pricing Q8; Micro-Issuer payouts Q9; admin screen for
`razorpayAccountId` and failing refunds; Cloud Scheduler job for the sweep; GST invoices (E14).

---

## 2026-11-12 — Session 8: Phase 6, audit logs and time-locked claims

**Built.**

- `src/types/audit.ts`: `IssuedBatchSchema` and the claim-token document; retention and
  re-issue limits; `reissueBlock` shared by server and table.
- `src/lib/utils/tokenManager.ts`: 256-bit tokens, SHA-256 ids, `isTokenExpired`,
  `verifyClaimToken`, `purgeExpiredClaimTokens` (paged, idempotent).
- Dispatch now mints the tokens, checks the template belongs to the institution, and writes
  `issued_batches` + `claim_tokens`. Request: `templateId` + one `tokenExpiry` (≤ 90 days);
  recipients carry no tokens.
- `POST /api/dispatch/reissue` (free, bounded) and `POST /api/cron/purge-claim-tokens`
  (`CRON_SECRET`).
- `src/components/dashboard/AuditLedger.tsx` (shadcn `table.tsx` + `@tanstack/react-table`
  8.21.3) with "1-Click Re-Issue", on the institution dashboard and issuer workspace.
- Rules close `issued_batches` and `claim_tokens`; `firebase/firestore.indexes.json` added.
  ADR-026.

**Verified.**

- 509 unit tests (16 new): token format and uniqueness, SHA-256, expiry at the exact instant,
  retention date, `reissueBlock` cases, new request validation (no client tokens or URLs, ≤ 90
  days, template id).
- 50 emulator tests (7 new): batch and hashed tokens recorded; replay mints nothing; another
  institution's template refused with nothing charged; re-issue renews only unclaimed links,
  charges nothing, kills old links, keeps claimed ones; cooldown, limit, 404 for outsiders,
  "nothing to re-issue" not counted; purge respects the 30-day grace, pages, marks the batch,
  blocks re-issue, is idempotent; ledger lists only the caller's institution.
- `scripts/e2e-dispatch.mjs`, 44/44 on the production build: tokens stored by hash only;
  ledger shows 2 batches with "30 days left"; clicking Re-Issue sent 3 new WhatsApp links
  (1 undeliverable again), balance unchanged, button then in cooldown; second re-issue 409;
  other institution 404; purge route 401 / 200 / 503 without secret. Auth e2e 53/53;
  `npm run verify` clean.

**Open.** No claim page yet (tokens are verified but nothing redeems them). Cloud Scheduler job
to be created when a live project exists. Q7 (retention periods) for the executive.

---

## 2026-11-12 — Session 7: Phase 5, CRM Kanban and dispatch

**Built.**

- `src/components/dashboard/KanbanBoard.tsx` (`@hello-pangea/dnd` 18.0.1): New Requests, Pending
  User Data, Ready to Issue, Issued; mouse, touch and keyboard drags; optimistic moves with
  rollback. Shown with sample requests on `/dashboard/institution` and `/dashboard/issue`.
- `POST /api/dispatch/whatsapp` (Meta WhatsApp Cloud API, Utility template: name, issuer, claim
  link, expiry) and `POST /api/dispatch/email` (Resend 6.35.0, batches of 100). Logic in
  `src/lib/dispatch/`.
- Credits deducted in a Firestore transaction before any provider call, refunds for failed
  recipients, idempotent `dispatches` ledger (server-only in the rules). ADR-024, ADR-025.
- Shared same-origin check (`src/lib/server/same-origin.ts`); `.env.example` documents the
  provider variables.

**Decided beyond the brief.** Dispatch requires a verified institution and directory membership;
claim links are built from `APP_ORIGIN`, never accepted from the request; records hold no contact
details; a bare 10-digit number must be an Indian mobile.

**Verified.**

- 493 unit tests (33 new): validation (phones, duplicates, expiry, injected URLs), WhatsApp
  payload and concurrency ≤ 8, per-recipient failures, Resend batching with idempotency keys,
  HTML escaping, board moves.
- 43 emulator tests (9 new): credits gone before the provider is called; refunds; replay without
  re-send; three concurrent dispatches charged exactly; unverified / insufficient / non-member
  refused with nothing charged; `dispatches` closed to every client.
- `scripts/e2e-dispatch.mjs`, 28/28 on the production build with a recording mock of Meta and
  Resend: 401 / 403 (individual, cross-site, stale member, unverified) / 400; 3 WhatsApp
  recipients with one undeliverable → charged 3, refunded 1; exact template parameters; replay
  sends nothing; email batch escaped with link and expiry; 402 with nothing sent; 503 when not
  configured; Kanban mouse, keyboard and touch long-press drags; columns scroll sideways on a
  phone.
- e2e-auth 53/53 still; `npm run verify` clean.

**Open.** No real Meta or Resend account (E17, E18), so live delivery is untested. Requests are
not stored and moves not saved; claim tokens are not issued or redeemable; no reconciliation of
dispatches stuck in `sending`. Pricing per message (Q5) and Micro-Issuer dispatch (Q6) open.

---

## 2026-11-12 — Session 6: Phase 4, canvas UI and workspace toggle

**Built.** The Tap-to-Place editor and the vault/issuer toggle, as briefed:

- `src/store/templateStore.ts` (Zustand): `activeTemplate`, `selectedPlaceholderId`, `dataRows`;
  `updatePlaceholderCoords(id, xPercent, yPercent)` plus `nudgePlaceholder` and `setFontSize`.
  The store converts percent → points (`src/lib/editor/coordinates.ts`), so the template is always
  in the worker's units.
- `src/components/canvas/MobileEditor.tsx`: pdf.js renders each page; fields are percent-positioned
  buttons with true-scale text (`cqw`). Tap to select, drag, tap the page to place the selected
  field, arrow keys.
- `src/components/canvas/PropertyBar.tsx`: Framer Motion bottom sheet with a hold-to-repeat D-pad
  (1 / 10 pt) and font size; swipe down to close.
- `src/components/dashboard/WorkspaceToggle.tsx` (shadcn Tabs) in a `(workspace)` layout over
  `/dashboard/vault` and the new guarded `/dashboard/issue`.
- `/editor` on the sample template with a "Test PDF" button that runs the edited template through
  the PDF worker. `scripts/e2e-editor.mjs`; e2e-auth extended.
- New pinned dependencies: zustand 5.0.16, framer-motion 14.6.0, @radix-ui/react-tabs 1.2.1,
  pdfjs-dist 6.4.299 (all released ≥ 2 weeks ago). ADR-022, ADR-023.

**Found and fixed.** On a touch screen a swipe that started on an unselected field dragged it
instead of scrolling the page (headless Chrome did not hand the swipe to scrolling despite
`touch-action`). Touch now only drags the selected field. pdf.js 6 moved `destroy()` from the
document to its loading task. A tap during a scroll fling only stops the fling — the e2e waits.

**Verified.**

- 460 unit tests (21 new): every whole-point position round-trips through percent exactly; store
  clamping, nudging, font-size limits, untouched placeholders keep identity; a store → engine →
  poppler test confirms edited positions print in place on a plain and a `/Rotate 90` page.
- `scripts/e2e-editor.mjs`, 36/36 (390×844 touch and 1280×900): both pages rendered; the "Name"
  overlay within 0.75 px of points × scale; D-pad exactly 1 pt per tap and 10 pt with the step
  switch; font 34 → 35; hold-to-repeat (12 pt in 1 s); arrow keys; drag delta = pixels ÷ scale
  within 0.05 pt; swiping an unselected field leaves it alone; tap-to-place centres the field within
  one pixel; the worker's PDF prints "Aarav Sharma" inside the edited box, centred within 1.5 pt
  (`pdftotext -bbox`); swipe closes the sheet; no script errors.
- e2e-auth, 53/53 with the emulators: `/dashboard/issue` 307 signed out, 200 for an individual,
  `/editor` 200 for guests; in Chromium the toggle navigates vault ⇄ issue, follows Back, works
  from the keyboard.
- Playground and upload browser suites still pass; `npm run verify` clean. pdf.js adds 129 KB
  (gzipped) to the editor only, plus a 363 KB parsing worker.

**Open.** Not tried on a real phone (pinch-zoom and real touch scrolling in particular). The editor
edits the sample template only: upload of a customer's template and saving to Firestore are not
briefed yet. Preview text does not shrink-to-fit or shape like the engine (Test PDF shows the
truth). Q4 (should institution members get the issuer workspace) added to the plan.

---

## 2026-11-12 — Session 5: Phase 3, core PDF engine (worker, ZIP, proxy)

**Built.** The worker moved to `src/workers/pdf.worker.ts` and gained
`generatePdfBatch(template, dataRows, settings, callbacks?)`, which returns one ZIP as a Blob
(`src/workers/zip-writer.ts`, JSZip streaming). The client moved to `src/lib/pdfEngine.ts`
(`Comlink.wrap`, `generatePdfBatch`/`generate`/`readPdfPages`, `saveBlob`). The image proxy
accepts the session cookie. The playground gained a ZIP mode and a 2,500-row batch;
`scripts/e2e-batch.mjs` was added. Decisions in ADR-021 (including why the proxy did not get the
permissive CORS headers the brief asked for).

**Found and fixed.** Through comlink every property of a remote object looks like a function, so
the worker cannot test whether an optional callback was supplied; the client now always supplies
both batch callbacks.

**Verified.** `scripts/e2e-batch.mjs` (Chromium, production build): 2,500 rows → 2,500 uniquely
named PDFs in a 71.2 MB ZIP in 64 s; the worker's V8 heap, sampled 257 times over the DevTools
protocol, peaked at 35.2 MB; sampled PDFs open with two pages; cancelling at ~200 rows returns no
ZIP; the worker keeps working afterwards. 439 unit tests (ZIP writer, proxy cookie auth) pass;
the playground and upload browser suites still pass; tsc, eslint, build clean.

**Open.** Not measured on a real mid-range Android phone (speed estimate ~4–6 min for 2,500
separate files). The batch is not yet started from a real screen.

---

## 2026-11-12 — Session 4: Phase 2, universal uploader and image editor

**Built.** `src/lib/utils/imageEditor.ts` (canvas crop, compression to ≤ 200 KB),
`src/lib/utils/csv.ts` (PapaParse, header checks), `src/components/ui/dialog.tsx` (shadcn
Dialog), `ImageCropModal`, `CsvPreviewModal`, `UniversalUploadZone`, a harness at
`/playground/uploads`, `scripts/e2e-uploads.mjs`. Decisions in ADR-020.

**Verified.** `scripts/e2e-uploads.mjs` in Chromium at 390×844 (touch) and 1280×900: 20/20
checks — the crop modal fills a phone screen and is a centred dialog on desktop; a 3000×4000 noisy
photo came out as a 173 KB, 976×1302 (exactly 3:4) JPEG; a CSV missing columns shows the red
warning with a near-match hint and blocks Confirm; a valid CSV previews 5 rows and passes all 12;
other file types are refused; no script errors. 435 unit tests pass; tsc, eslint, build clean.

**Open.** Not yet wired into real screens. HEIC photos are not accepted. Not tested on a real
phone (pinch zoom was not exercised; the slider and buttons were).

---

## 2026-11-12 — Session 3: administrative update from the executive

No code changes. Decisions recorded:

- **No live GCP/Firebase or billing yet.** All Firebase work runs against the local emulators
  (`npm run test:emulator`, project `demo-v6`) with placeholder `.env.local` values
  (`.env.example` now documents an emulator section).
- **Samples:** mock CSVs and a blank Canva template arrive at the data-intake phase.
- **ADR-015 approved:** Google access only via `drive.file` + Google Picker.
- **Scale target:** mid-range Android phone, batches up to 2,500 rows.
- **Roadmap:** the M0–M7 milestones are discarded in favour of the executive's 9-phase B2B2C
  architecture. PLAN.md now shows Phase 1 (RBAC & Foundation) as current; Phases 2–9 are recorded
  as each brief arrives.

---

## 2026-11-12 — Session 2: V6 Phase 1, foundation and role-based access control

**Goal.** The product grows into a B2B2C credential platform (V6). Establish roles (guest,
individual/Micro-Issuer, institution staff and admin, super admin) as Firebase custom claims,
route protection, and Firestore security rules for institutions, templates and vault items.

### Built

- `src/types/roles.ts` — roles, the claims contract, `InstitutionSchema`, `VaultItemSchema`.
- `src/lib/auth/access.ts` — pure RBAC: claim parsing, role derivation, route table, decisions.
- `src/lib/auth/customClaims.ts` — Admin SDK role management (directory sync, revocation on
  demotion) and cookie / ID-token verification.
- `src/lib/auth/session.ts`, `session-cookie.ts`, `src/app/api/auth/session/route.ts` — session
  cookies and server-side guards; guarded placeholder pages for `/admin`,
  `/dashboard/institution`, `/dashboard/vault`.
- `src/proxy.ts` — route protection (Next.js 16's replacement for `middleware.ts`).
- `firebase/firestore.rules`, `firebase.json` — rules and emulator configuration.
- Tests: `access.test.ts`, `session.test.ts`, `auth.emulator.test.ts`,
  `firestore.rules.emulator.test.ts`, `scripts/e2e-auth.mjs`.

### Deviations from the brief (all recorded in ADRs 016–018)

- `middleware.ts` → `src/proxy.ts`: the old name is deprecated in Next.js 16. Files live under
  `src/` because the project uses a `src` directory.
- Templates use `ownerUid` (the brief wrote `owner_uid`) to match the rest of the schema;
  `TemplateRecord.ownerId` was renamed and gained `institutionId` and server timestamps.
- Vault items gained `issuerType` and `revokedAt`; deletes are denied; revocation is one-way.
- `InstitutionSchema.adminUid` is nullable (an institution can exist before its admin).
- Writes to institution templates are admin-only; staff can read them and issue from them.

### Found and fixed along the way

- The session route's same-origin check compared against the URL Next reconstructs, which
  differs behind the standalone server; every sign-in was refused. Now compares the `Origin`
  host with the `Host` / `X-Forwarded-Host` header, as Next does for Server Actions.
- The Auth emulator always checks revocation, so a test assuming the opposite was rewritten.

### Verified

- `npm test`: 430 tests pass (access policy 64, page guard 6, plus all earlier suites).
- `npm run test:emulator`: 34 pass — claims (role walk with directory sync, idempotency, one
  admin per institution, invalid input), sessions (anonymous, stale sign-in, wrong project,
  expired, revoked), the session route (cookie attributes, cross-origin, malformed input) and the
  proxy (role × route table, disguised paths, revocation), plus 18 rules tests. With allow-all
  rules, 14 of the 18 rules tests fail, so they test something.
- `scripts/e2e-auth.mjs` against the production build: 47 checks pass — every role on every
  protected route, 13 disguised paths (`/%61dmin`, `/ADMIN`, `/api/../admin`,
  `/_next/static/../../admin`, …) none of which reached privileged content, RSC requests,
  revocation, sign-out, and fail-closed behaviour when emulator variables meet `K_SERVICE`.
- `scripts/e2e-playground.mjs` still passes with the proxy on every request.
- `tsc --noEmit`, `eslint`, `next build` clean.

### Open

- No `/login` page yet: unauthenticated visitors are redirected to `/login?next=…`, which 404s
  until the Google Sign-In UI is built (needs the Firebase web config, PLAN E2). Validate `next`
  with `safeReturnPath` there.
- Not run against a real Firebase project (needs E1/E2). Signature verification and the
  non-revocation path can only be exercised there.
- First super admin: grant out of band with the Admin SDK once the project exists (E6).
- Credits are not debited when credentials are issued from the browser (PLAN Q3, ADR-018).
- The Docker image is still unbuilt (session 1).

---

## 2026-11-11 — Session 1: foundation of the PDF engine

**Goal.** Starting from an empty repository, deliver the foundation of the generation engine:
the template schema, the image proxy, and the Web Worker engine for multi-page documents with
text, images and QR codes. Set up durable project records.

### Built

- **Project scaffold** — Next.js 16.4 (App Router, Turbopack, Tailwind 4, Cache Components),
  strict TypeScript, Vitest, Prettier, ESLint, standalone output for Cloud Run.
- **Template schema** (`src/lib/template`) — interfaces, zod validation tied to the interfaces,
  binding resolution, column discovery.
- **Image proxy** (`src/app/api/proxy-image`, `src/lib/image-proxy`) — authenticated, SSRF-safe
  relay with DNS pinning, manual redirects, size and time limits, magic-byte sniffing, share-link
  rewriting for Google Drive and Dropbox.
- **Engine maths** (`src/lib/pdf-engine`) — affine transforms, page geometry for rotated and
  cropped pages, object-fit rectangles, text wrapping / shrink-to-fit / ellipsis.
- **Records** — this log, PLAN.md, DECISIONS.md (15 ADRs), CLAUDE.md with the record-keeping
  protocol.

- **PDF engine** (`src/lib/pdf-engine`) — shaped text for Indian scripts, wrapping and
  shrink-to-fit, images (cover/contain/fill, position, EXIF, masks, borders), vector QR codes,
  multi-page templates incl. rotated/offset pages, `separate` and `merged` output, per-row
  reports, cancellation, back-pressure.
- **Web Worker** (`src/workers`) — comlink client/worker, image loader (local / same-origin /
  proxy), canvas image shrinker and converter.
- **Playground and e2e** — `/playground`, sample template and photos, `scripts/e2e-playground.mjs`.
- **Dockerfile** and `.dockerignore` (written, not built — see Open).

### Experiments and what they showed

All run on the development machine (Node 22). Scripts were throwaway; the conclusions are
captured in ADRs and reproduced by tests.

1. **Indic text crashes stock pdf-lib + fontkit.** `ReferenceError: regeneratorRuntime is not
defined` inside fontkit's Indic shaper. Loading `regenerator-runtime` first fixes it.
2. **`subset: false` garbles Indic spacing.** Glyphs created by shaping get no width entry.
   `subset: true` is correct and also keeps files tiny (2.6 KB for a document with one Hindi name).
3. **pdf-lib ignores OpenType positioning.** Compared against Chromium rendering the same font:
   Bengali "শ্রী" had its lower mark displaced; fontkit's own output contained the right offset
   (`xOffset: -716`) which pdf-lib drops. Latin kerning is dropped the same way.
4. **Mixed-script strings are mis-shaped.** "Class 10 कक्षा" breaks the conjunct because fontkit
   picks one script per string. Passing the script per run fixes it.
5. **Font cost per document.** New font instance + first shaping: ~18 ms (Noto Sans Devanagari).
   Sharing one warm instance across documents: total font cost per document 24 ms → 4.6 ms, with
   identical bytes.
6. **Output strategies.** Per row, 1.5 MB template: load+draw+save 3.2 ms; copyPages 3.0 ms.
   Merged: 1,000 rows × 2 pages in 0.48 s and 2.06 MB when template pages are embedded once.

→ ADR-007 (own text drawing), ADR-008 (shared font instance), ADR-009 (output modes).

### Things that were not obvious

- Next.js 16 with Cache Components prerenders `GET` route handlers at build time unless they
  touch request data, and forbids the `runtime` / `dynamic` exports. The proxy route calls
  `await connection()` first. Next's bundled docs (`node_modules/next/dist/docs`) are the
  reference — see AGENTS.md.
- Vitest 5 needs `@types/node` 22 or newer; the Next template pins 20. Bumped.
- TypeScript 7 and ESLint 10 exist, but the Next.js template still pins TypeScript 5 and ESLint 9.
  We follow the template.

### Things found and fixed along the way

- fontkit crashed on Telugu, Malayalam and Gurmukhi words (empty GPOS mark anchors); patched to
  skip empty anchors as HarfBuzz does, with a degraded-shaping fallback.
- pdf-lib's `EncryptedPDFError` breaks `instanceof`, so encrypted templates were reported as
  unreadable; now detected by message.
- A photo shown twice in one row was downloaded and embedded twice; now once (documents 238 KB →
  172 KB in the playground).

### Verified

- 360 tests pass (`npm test`). Engine output is checked with poppler: pixel colours for images,
  QR modules and backgrounds; word positions for text; all 8 EXIF orientations; 6 page
  geometries x 2 modes.
- Nine Indian scripts rendered by the engine match Chromium's rendering of the same fonts
  (visually, and ink overlap 0.80–0.85 after a ≤3 px shift; remaining difference is
  anti-aliasing, not placement).
- `npm run build` succeeds; `/api/proxy-image` is dynamic. `scripts/e2e-playground.mjs` passes
  against the standalone production server in Chromium: proxy checks over real HTTP (metadata IP
  and localhost refused; anonymous refused when `K_SERVICE` is set; a public image relayed),
  6 rows separate, 60 rows merged (252 KB), 300 rows in ~1 s, cancellation, phone viewport with
  no sideways scroll, no console errors.
- `tsc --noEmit` and `eslint` clean.

### Open

- **The Docker image has not been built.** An attempt hit Docker Hub's anonymous pull limit
  (HTTP 429), then, via `mirror.gcr.io`, `npm ci` failed inside the container with a
  self-signed-certificate error caused by this sandbox's network proxy (not by the Dockerfile).
  The Dockerfile follows Next's standalone layout and the standalone server is verified, but
  build it once in CI or on a workstation: `docker build -t document-generator .`
- Real Firebase ID-token verification is untested (no Firebase project yet; only rejection of
  bad tokens is tested). Needs PLAN.md E1–E2.
- Google Drive share-link rewriting is unit-tested only, not against real Drive links (E7).
- Image shrinking/conversion runs in Chromium only; not tested on Safari or low-end Android (E11).
- Right-to-left text (Urdu) unsupported; fonts have no fallback for missing characters.
- Per-user proxy rate limits and App Check not done (B23, B24).
