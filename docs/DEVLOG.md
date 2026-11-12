# Development Log

A dated entry for every working session, newest first: what was done, what was learned, how it
was verified, and what is left open. The line-by-line history is in git; this file is the story.

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
