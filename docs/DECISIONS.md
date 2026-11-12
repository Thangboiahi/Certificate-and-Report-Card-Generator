# Architecture Decision Records

Every significant technical decision is recorded here: what we decided, why, what we gave up, and
when to revisit it. This is the file to open when someone asks "why is it built this way?" or
"can we change X?".

**Rules for this file**

- One entry per decision, numbered, newest at the bottom.
- Never delete or rewrite history. To change a decision, add a new entry and mark the old one
  `Superseded by ADR-0NN`.
- Status is one of: `Proposed` (needs the executive's sign-off), `Accepted`, `Superseded`.
- "Revisit when" names the concrete signal that should make us reconsider.

| #   | Decision                                                                               | Status   |
| --- | -------------------------------------------------------------------------------------- | -------- |
| 001 | Generate PDFs in the browser; keep the server thin                                     | Accepted |
| 002 | Next.js 16 (App Router, Cache Components) as a Cloud Run container                     | Accepted |
| 003 | Template geometry: points, top-left of the displayed page                              | Accepted |
| 004 | Placeholders bind to data by column / token template / static value                    | Accepted |
| 005 | Image proxy security model                                                             | Accepted |
| 006 | pdf-lib 1.17.1, pinned and isolated behind `src/lib/pdf-engine`                        | Accepted |
| 007 | Draw text glyph-by-glyph from fontkit's shaping output                                 | Accepted |
| 008 | One warm font instance per job, shared by every document                               | Accepted |
| 009 | Two output modes: separate files and one merged print file                             | Accepted |
| 010 | Handle rotated/cropped PDFs with transforms, not per-shape maths                       | Accepted |
| 011 | Images: honour EXIF orientation; `cover`/`contain` by clipping                         | Accepted |
| 012 | QR codes drawn as vector squares                                                       | Accepted |
| 013 | The engine is environment-agnostic; the Worker is a thin adapter                       | Accepted |
| 014 | Project memory lives in `docs/` and is updated every session                           | Accepted |
| 015 | Google access via `drive.file` + Google Picker only                                    | Proposed |
| 016 | Elevated roles as Firebase custom claims: one role, one institution                    | Accepted |
| 017 | Sessions: Firebase session cookies, verified in the proxy and again in server code     | Accepted |
| 018 | Firestore rules model for institutions, templates and vault items                      | Accepted |
| 019 | Security is tested against Firebase emulators; emulators can never be on in production | Accepted |
| 020 | Upload gateway: shadcn/ui primitives copied in; compression on the main thread         | Accepted |

---

## ADR-001 — Generate PDFs in the browser; keep the server thin

**Date:** 2026-11-11 · **Status:** Accepted (constraint set by the executive)

**Context.** The product generates hundreds or thousands of PDFs per batch for price-sensitive
customers (schools, coaching centres, small businesses). Server-side rendering would make compute
cost grow with usage and would require recipient data (children's names and photos) to sit on our
servers.

**Decision.** All document generation runs in the customer's browser, in a Web Worker, using
pdf-lib. The server (Next.js on Cloud Run, scale-to-zero) only serves the app, authenticates
users, relays images that browsers cannot fetch directly, and later handles billing.

**Why.** Near-zero marginal cost per document; recipient data never needs to be stored by us
(a strong privacy position under India's DPDP Act); works on a phone.

**Consequences.**

- Batch size is bounded by the device's memory and CPU. The engine therefore streams results out
  one file at a time and offers chunking for merged output (ADR-009).
- Usage limits enforced only in the browser can be bypassed by a determined user. Limits that
  matter commercially must be tied to something the server controls (the image proxy, verification
  pages, export tokens). See docs/PLAN.md, risk R3.
- We cannot use server-only tools (headless Chrome, HarfBuzz native, ImageMagick).

**Revisit when** customers need batches that phones cannot handle (tens of thousands of documents)
or features that need a server (scheduled generation, API access). A server-side worker could then
reuse the same engine, which is deliberately free of browser dependencies (ADR-013).

---

## ADR-002 — Next.js 16 (App Router, Cache Components) as a Cloud Run container

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** The brief asks for Next.js 15+. The current release is 16.4, whose project generator
enables Cache Components and Partial Prefetching by default and builds with Turbopack.

**Decision.** Use Next.js 16.4 exactly as `create-next-app` generates it, with
`output: 'standalone'` for a small Docker image. TypeScript stays on 5.9 and ESLint on 9, the
versions the Next.js template pins, although TypeScript 7 and ESLint 10 exist.

**Why.** Staying on the framework's default path means the least friction on upgrades. The
standalone output contains only the files the server needs, which keeps the image small and cold
starts short on scale-to-zero.

**Consequences.**

- With Cache Components, `GET` route handlers are prerendered at build time unless they touch
  request data. API routes that must run per request call `await connection()` first
  (`src/app/api/proxy-image/route.ts`). The `runtime`, `dynamic` and `revalidate` exports must not
  be used.
- Next.js 16 differs from older versions in ways that are easy to get wrong from memory. The
  bundled docs in `node_modules/next/dist/docs/` are the reference (see `AGENTS.md`).

**Revisit when** TypeScript 7 becomes the Next.js template default, or if Cache Components gets
in the way of the mostly client-side dashboard.

---

## ADR-003 — Template geometry: points, top-left of the displayed page

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** Placeholder positions are created by tapping on a rendered page (pdf.js, CSS pixels,
origin top-left) and consumed by pdf-lib (PDF user space: origin bottom-left, before the page's
own rotation, possibly offset by a crop box). Something has to translate, and the stored format
has to stay meaningful for years.

**Options considered.**

1. Store raw PDF user-space coordinates. Simple for the engine, but the editor would need to
   understand rotation and crop boxes, and stored numbers would be unintuitive.
2. Store fractions of the page (0–1). Resolution-independent, but font sizes and borders would
   need a second unit, and aspect-ratio reasoning gets awkward.
3. Store PDF points measured from the top-left of the page _as displayed_ (after rotation and
   crop). **Chosen.**

**Decision.** `Box { x, y, width, height }` in points (1/72 in), origin top-left of the displayed
page, y down. Every placeholder has a zero-based `pageIndex`. The template also records each
page's displayed size.

**Why.** It is exactly what pdf.js reports at scale 1, so tap-to-place is one division by the
render scale. Font sizes are in the same unit. Print sizes are exact (an 85.6 × 54 mm card is
242.65 × 153.07 pt).

**Consequences.** The engine owns the conversion to user space (ADR-010). If a customer replaces
the background with a different-sized PDF, placeholders keep their absolute positions rather than
scaling; the editor will need a "rescale" action for that case.

**Schema evolution.** The template carries `schemaVersion` (currently 1). Adding optional fields
is always safe. Any other change bumps the version and ships with a migration. Runtime validation
(`schema.ts`) is tied to the TypeScript interfaces with `satisfies`, so they cannot drift apart.

**Revisit when** we add template "themes" that must adapt to several page sizes.

---

## ADR-004 — Placeholders bind to data by column / token template / static value

**Date:** 2026-11-11 · **Status:** Accepted

**Decision.** Each placeholder has a `binding`:

- `column` — one column of the data source;
- `template` — text with `{{Column}}` tokens (e.g. a verification URL for a QR code);
- `static` — the same value on every document.

The engine only substitutes. It does not compute (no totals, grades, serial numbers, date
formatting).

**Why.** A discriminated union keeps the common case (pick a column) trivial for the editor and
for validation, while tokens cover composition. Keeping computation out of the engine keeps it
small and predictable; computed values are added as extra columns by the data layer before
generation.

**Consequences.** Features like "grade from marks", "rank", "serial number CERT-2026-0001" or
Indian number formatting belong to a future "computed columns" step in data intake
(docs/PLAN.md, backlog), not to the template schema.

**Revisit when** customers need per-placeholder formatting that cannot reasonably be a column
(e.g. the same date shown in two formats).

---

## ADR-005 — Image proxy security model

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** The Worker cannot read cross-origin images without CORS, so `/api/proxy-image`
fetches them. The URLs come from customer spreadsheets, which makes the route a classic
Server-Side Request Forgery (SSRF) target: on Cloud Run, a request to `169.254.169.254` returns
the service account's access tokens.

**Decision.** Defence in depth, each layer independently tested:

1. **Authentication.** A valid Firebase ID token is required. An anonymous mode exists for local
   development and is ignored whenever `K_SERVICE` is set, which Cloud Run always does.
2. **URL rules before any network use.** `http`/`https` only, default ports only, no embedded
   credentials, no single-label or internal host names.
3. **Address rules.** Private, loopback, link-local, carrier-NAT, multicast and reserved ranges
   are refused for IPv4, IPv6, and IPv4 hidden inside IPv6 (mapped, compatible, NAT64, 6to4). For
   IPv6 only global unicast (2000::/3) is allowed.
4. **DNS pinning.** The outgoing socket resolves names through our own lookup, which rejects the
   request unless every resolved address is public. The connection is made to the checked
   addresses, which defeats DNS rebinding.
5. **Post-connect check.** The socket's real remote address is checked again before the response
   is read.
6. **Redirects** are followed manually (max 5) and every hop goes through layers 2–5.
7. **Content rules.** Size limit (8 MiB default, applied after decompression), total time limit
   (15 s default), and the response must _be_ an image according to its magic bytes. The
   `Content-Type` we send is derived from those bytes, never from the origin.
8. **Response hardening.** `nosniff`, a `sandbox` CSP, same-origin resource policy, no CORS
   headers (so other sites cannot use our proxy), private browser caching only.
9. **Logging.** Only the host name is logged. Full URLs can contain access tokens and personal
   data.

**Buffer, don't stream.** The image is read fully into memory (bounded) before responding. A
streamed relay would tie the upstream deadline to the customer's connection speed — a slow phone
would cause timeouts mid-image. Peak memory is `max size × concurrent requests`; Cloud Run
concurrency and memory must be set with that in mind (docs/ARCHITECTURE.md).

**Built on `node:http(s)`, not `fetch`.** We need to control DNS for the socket and inspect every
redirect; `fetch` offers neither without an extra dependency.

**Not yet done.** Per-user rate limits and quotas (planned with tiers, milestone M5). Firebase App
Check to restrict the route to our own app.

**Revisit when** proxy egress becomes a visible cost (then: try a direct CORS fetch first and fall
back to the proxy), or when memory pressure shows up in Cloud Run metrics (then: stream with a
first-chunk sniff).

---

## ADR-006 — pdf-lib 1.17.1, pinned and isolated behind `src/lib/pdf-engine`

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** The brief specifies pdf-lib. Its last release (1.17.1) was in 2021; it is stable and
widely used but no longer maintained. Known gaps: it cannot open encrypted PDFs, ignores OpenType
positioning, and ignores EXIF orientation.

**Decision.** Use `pdf-lib@1.17.1` and `@pdf-lib/fontkit@1.1.1` at exact versions. Only files
under `src/lib/pdf-engine/` may import them. Where pdf-lib falls short we write our own drawing
code on top of its low-level operators (ADR-007, ADR-011) rather than patching the library.

**Why.** Exact pinning makes it safe to rely on a few internal details (ADR-008). Isolation means
a future switch to a maintained fork (`@cantoo/pdf-lib` is API-compatible and can open encrypted
PDFs) touches one folder.

**Consequences.** Password-protected templates are rejected with a clear message. A test asserts
the internal details we rely on, so an accidental upgrade fails loudly instead of subtly.

**Revisit when** customers hit encrypted templates often, or a security issue is reported in
pdf-lib.

---

## ADR-007 — Draw text glyph-by-glyph from fontkit's shaping output

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** The market is India: names and text in Devanagari, Bengali, Tamil, Telugu, Kannada,
Malayalam, Gujarati, Gurmukhi and Odia are core, not an edge case. We tested pdf-lib's built-in
text drawing against Chromium's renderer (which uses HarfBuzz, the reference shaper). Findings,
all reproduced in this repository's test suite:

1. **Crash.** Any Indic text threw `regeneratorRuntime is not defined` inside fontkit. Fix: load
   `regenerator-runtime` before fontkit.
2. **Garbled spacing without subsetting.** With `subset: false`, glyphs produced by shaping
   (conjuncts, half-forms) have no width entry in the PDF, so viewers space them wrongly. With
   `subset: true` the widths are right.
3. **Positioning ignored.** fontkit computes OpenType GPOS positions (mark placement, kerning) and
   pdf-lib discards them. Example: Bengali "শ্রী" rendered with its lower mark displaced by a full
   character width. Latin text loses all kerning ("AVATAR", "To").
4. **Mixed scripts mis-shaped.** fontkit picks one script per string, so in
   "Class 10 कक्षा" the Hindi part is shaped with Latin rules and conjuncts break.

**Decision.** For embedded fonts the engine does its own text drawing:

- split each word into single-script runs (`script-runs.ts`);
- shape each run with fontkit, keeping glyph ids **and positions**;
- emit PDF text operators directly (`TJ` with per-glyph adjustments, new text positions for
  vertical offsets), so every glyph lands where the shaper put it;
- measure text from the same shaped advances, so layout and drawing cannot disagree;
- always embed fonts with `subset: true`.

The 14 standard PDF fonts take the same path with kerning from their built-in metrics.

**Why not HarfBuzz (WASM) now.** It is the gold standard but adds a ~1 MB download and a second
font pipeline. fontkit's shaper plus correct positioning matched the reference in our tests. The
shaping step sits behind one function, so HarfBuzz can replace it later without touching layout
or drawing.

**Consequences.**

- Text stays real text (selectable, searchable), and files stay small because fonts are subset.
- Right-to-left scripts (Urdu, Arabic) are not supported yet; the engine warns when it sees them.
- A font has no fallback: if the chosen font lacks a character, the engine warns and the viewer
  shows a blank box. Our curated font library must therefore pair each Indic family with Latin
  (the Noto families do).

**Revisit when** a customer reports a shaping error we can reproduce against Chromium — that is
the trigger to bring in HarfBuzz — or when Urdu support is requested.

---

## ADR-008 — One warm font instance per job, shared by every document

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** Measured on the development machine: creating a font object and shaping its first
string costs ~18 ms for Noto Sans Devanagari, because the shaping tables are decoded lazily per
instance. pdf-lib creates a new instance for every document, so 1,000 certificates would spend
~18 s per font doing identical work — far more than the ~3 ms each document otherwise takes.

**Decision.**

1. Register a small caching wrapper as pdf-lib's "fontkit". It returns the same parsed font for
   the same bytes, so all documents in a job share one warm instance. Each document still gets
   its own subset.
2. Shape each distinct word once per job and cache the result (bounded LRU).
3. Register the shaped glyphs with a document's font subset directly, instead of asking pdf-lib
   to shape the same text again. This uses four internal members of pdf-lib's subset embedder.
   If they are ever missing the engine falls back to the public `encodeText`, which is slower but
   equivalent.

**Result.** Per-document font cost dropped from ~24 ms to ~4.6 ms with byte-identical output.

**Consequences.** We depend on pdf-lib internals — acceptable only because the version is pinned
exactly (ADR-006) and a unit test checks the fast path is active.

**Revisit when** pdf-lib is replaced or upgraded.

---

## ADR-009 — Two output modes: separate files and one merged print file

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** Customers want either one PDF per person (to send or upload) or one big PDF to print.

**Decision.**

- **`separate`** — for each row the template PDF is loaded afresh and drawn on. The output is the
  customer's original file plus our additions, so links, metadata and form fields survive.
- **`merged`** — a new document is created; each template page is embedded **once** as a reusable
  object and stamped onto a new page per row. `rowsPerFile` splits very large batches into several
  files.

**Evidence** (development machine, 1.5 MB template with a full-page image):

| Approach                             | Result                              |
| ------------------------------------ | ----------------------------------- |
| Load template + draw + save, per row | ~3.2 ms per document                |
| Copy pages from a parsed template    | ~3.0 ms per document (no real gain) |
| Merged, 1,000 rows × 2 pages         | 0.48 s total, 2.06 MB output        |

Loading per row costs the same as copying pages and is more faithful, so we load. In merged mode
the background is stored once: 2,000 pages weigh barely more than the template itself.

**Consequences.** Merged output drops the template's interactive features (links, form fields),
which is fine for printing. Separate output cannot be smaller than the template, so 1,000
certificates on a 1.5 MB background are 1.5 GB in total — files are therefore handed to the caller
one at a time, never accumulated in memory.

**Revisit when** we add N-up imposition for ID cards (several cards per sheet with crop marks),
which builds on the merged path.

---

## ADR-010 — Handle rotated/cropped PDFs with transforms, not per-shape maths

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** Real templates come from Canva, Word, scanners and phone apps. Many have a `/Rotate`
entry (a landscape page stored as rotated portrait) or a crop box that does not start at zero.
pdf-lib draws in raw coordinates and ignores both, so naive drawing lands sideways or shifted.

**Decision.** Before drawing on a page the engine installs one transform that maps "the page as
displayed, origin bottom-left" to raw user space. Each placeholder then gets its own transform
(position, plus rotation about its centre). All drawing code works in the placeholder's own box:
`(0,0)` is its bottom-left corner. Every placeholder is wrapped in save/restore, so clipping and
colours cannot leak.

**Why.** Rotation is handled in exactly one function (`computePageFrame`) and verified for all
four orientations, instead of being a special case in every drawing routine.

**Revisit when** — not expected. This is a foundation.

---

## ADR-011 — Images: honour EXIF orientation; `cover`/`contain` by clipping

**Date:** 2026-11-11 · **Status:** Accepted

**Decision.**

- The image type is decided from magic bytes. JPEG and PNG are embedded directly (JPEG bytes are
  stored as-is, with no recompression).
- JPEG EXIF orientation is read and applied when drawing, including the swap of width and height
  for quarter turns. Without this, portrait photos from phones appear sideways on ID cards.
- `cover` scales the image to fill the box and clips the overflow; `contain` scales it to fit;
  `fill` stretches. `position` (like CSS `object-position`) chooses what is kept — setting
  `y: 0.2` keeps faces in frame for portrait crops.
- The clip shape can be a rectangle, rounded rectangle or ellipse, with an optional border.
- An image used on several rows (a logo, a signature) is downloaded once per job and embedded
  once per output file.

**Consequences.** Images are embedded at full resolution. A 5 MB phone photo placed in a 1-inch
box makes a 5 MB document. Downscaling to print resolution in the browser before embedding is the
most valuable follow-up (docs/PLAN.md, backlog B1); the engine has a hook for it.

**Revisit when** output sizes are measured on real customer data.

---

## ADR-012 — QR codes drawn as vector squares

**Date:** 2026-11-11 · **Status:** Accepted

**Decision.** QR matrices are computed with `qrcode-generator` (small, dependency-free, no DOM)
and drawn as filled rectangles in a single path, merging horizontal runs of dark modules.

**Why.** Vector output stays sharp at any print size and adds only a few hundred bytes. The
library works unchanged in a Web Worker and in Node.

**Consequences.** Other barcode types (Code 128 for library and ID cards) are not covered; they
are a separate backlog item.

---

## ADR-013 — The engine is environment-agnostic; the Worker is a thin adapter

**Date:** 2026-11-11 · **Status:** Accepted

**Decision.** `src/lib/pdf-engine` uses no browser, Worker or Node APIs. Everything environmental
is passed in: template and font bytes, a function that loads an image for a reference, an
optional image pre-processor, an abort signal, and callbacks for progress and finished files. The
Web Worker (`src/workers`) wires those to `fetch`, the proxy and comlink.

**Why.** The whole engine is unit-tested in Node in milliseconds, including pixel-level checks of
its output. The same code could run in a server worker later (ADR-001). The editor's preview will
call the same engine, so preview and final output cannot differ.

**Consequences.** The engine never talks to storage or the network itself. Loading template
files, fonts and auth tokens is the app's job.

---

## ADR-014 — Project memory lives in `docs/` and is updated every session

**Date:** 2026-11-11 · **Status:** Accepted

**Context.** Development happens in separate sessions that start without memory of the previous
ones. The executive asked for a durable record of the plan, progress and history.

**Decision.** Four living documents, versioned with the code:

- `docs/PLAN.md` — scope, roadmap, status, open questions, what is needed from the executive;
- `docs/ARCHITECTURE.md` — how the system works today;
- `docs/DECISIONS.md` — this file;
- `docs/DEVLOG.md` — a dated entry per working session;

plus `CHANGELOG.md` for released changes. `CLAUDE.md` instructs every future session to read them
first and update them before finishing. Git history remains the line-by-line record.

**Why.** Records kept next to the code are reviewed, versioned and never out of reach of the next
session.

---

## ADR-015 — Google access via `drive.file` + Google Picker only

**Date:** 2026-11-11 · **Status:** Accepted (approved by the executive on 2026-11-12)

**Context.** We need to read a customer's Google Sheet and write PDFs to their Drive. Google
classifies OAuth scopes: broad Drive scopes (`drive`, `drive.readonly`) are _restricted_ and
require a paid annual third-party security assessment; `spreadsheets.readonly` is _sensitive_ and
requires verification; `drive.file` is _non-sensitive_ and only grants access to files the user
explicitly picks or the app creates.

**Proposal.** Request only `drive.file`. The user chooses their spreadsheet (and, where photos are
private Drive files, the photos) with Google Picker; the app reads the sheet through the Sheets
API under that same scope and creates the output folder itself.

**Why.** Avoids the security assessment (cost and weeks of delay), asks customers for the least
access — which matters when the data is about children — and keeps Google's consent screen
unalarming.

**Trade-off.** One extra step for the user (picking files) and no silent access to "all sheets".
Private photo folders need a multi-select in Picker rather than a pasted folder link.

**Revisit when** the Picker flow proves too clumsy in user testing.

---

## ADR-016 — Elevated roles as Firebase custom claims: one role, one institution

**Date:** 2026-11-12 · **Status:** Accepted

**Context.** V6 adds a credential platform with five roles: `guest`, `individual` (including
Micro-Issuers), `inst_staff`, `inst_admin` and `super_admin`. Access must be decided identically by
the proxy, server code and Firestore security rules.

**Decision.**

- `guest` and `individual` are never stored: they are derived from the token (anonymous or absent
  → guest; any other sign-in → individual).
- The three elevated roles are custom claims: `{ role: 'super_admin' }` or
  `{ role: 'inst_admin' | 'inst_staff', institutionId }`. A user holds **one** elevated role and
  belongs to **one** institution. Malformed claims count as no role (fail closed).
- Claims are the authority. `institutions/{id}.adminUid` / `staffUids` are a directory for
  display, kept in step by `setUserRole` with a fixed order: add to the new directory → swap the
  claims in one write → remove from the old directory → revoke sessions if any access was taken
  away. A failure at any step leaves at most the access the user had before.
- One admin per institution: replacing an admin is an explicit two-step change.
- Unrelated custom claims on a user are preserved.

**Why.** Claims travel inside every verified token, so checks cost no database reads (rules
included). Single role + single institution keeps rules and checks simple and auditable.

**Consequences.** Someone who works for two institutions needs two accounts. Claim changes reach
a user only when they sign in again — demotions force this by revoking sessions. The first
super admin must be granted out of band (Admin SDK with the project owner's credentials).

**Revisit when** multi-institution staff become a real need (then: a membership collection
checked by rules, at the cost of a read per check).

---

## ADR-017 — Sessions: Firebase session cookies, verified in the proxy and again in server code

**Date:** 2026-11-12 · **Status:** Accepted

**Decision.**

- After Google Sign-In in the browser, the fresh ID token is posted to `POST /api/auth/session`,
  which mints a Firebase **session cookie** (`__session`, httpOnly, Secure, SameSite=Lax,
  5 days). It requires a non-anonymous account, an unrevoked token and a sign-in within the last
  5 minutes, and only accepts same-origin calls (login-CSRF protection).
- **`src/proxy.ts`** (Next.js 16 renamed `middleware.ts` to `proxy.ts`; the old name is
  deprecated) runs on the Node.js runtime, so it verifies the cookie with the Admin SDK — a real
  cryptographic check, not a cookie-presence check. Privileged areas (`/admin`,
  `/dashboard/institution`) also check revocation with Firebase Auth, so a demoted user is locked
  out immediately; ordinary areas skip that network call.
- The proxy matcher covers every request except build assets, and route rules are matched on a
  canonical path (decoded, lower-cased, slashes collapsed). Encoded, re-cased and dot-segment
  variants of protected paths were tested against the production server; none got through.
- **Defence in depth:** pages, route handlers and server actions re-verify through
  `requireRouteAccess` / `authorize` (`src/lib/auth/session.ts`), as Next's security guidance
  requires. Pages read the session inside `<Suspense>` (Cache Components).
- If verification cannot run (misconfiguration, Google key fetch failure) the proxy answers 503
  rather than treating the user as signed out.

**Why.** Session cookies work for server rendering, can be revoked, and keep tokens out of page
scripts. Verifying in the proxy gives correct HTTP statuses (307/403) before rendering; verifying
again in server code means a proxy bypass (as in CVE-2025-29927) exposes nothing.

**Consequences.** Privileged pages make two Auth calls per request (proxy + page). Acceptable for
low-traffic admin areas; a short per-instance cache is the optimisation if needed. Pages deny
with 404 (hiding privileged areas) while the proxy uses 403.

---

## ADR-018 — Firestore rules model for institutions, templates and vault items

**Date:** 2026-11-12 · **Status:** Accepted

**Decision** (`firebase/firestore.rules`):

- **institutions:** read by that institution's staff/admin and super admins; written only by
  super admins, with shape validation (`creditBalance` a non-negative integer).
- **templates:** personal templates (`institutionId: null`) are managed by their owner (a
  Micro-Issuer); institution templates by that institution's admin, readable by its staff.
  `ownerUid`, `institutionId` and `createdAt` are immutable; timestamps must be server times.
  The brief's `owner_uid` is spelled `ownerUid` to match every other field in the schema.
- **vault_items:** created by the issuer — a Micro-Issuer under their own uid, or staff/admin for
  their institution — and only from a template belonging to that issuer. A new
  `issuerType: 'institution' | 'individual'` field removes the ambiguity of `issuerId` alone.
  `issuedAt` must be the server time (no backdating); `expiresAt` must be in the future or null.
  Read by the recipient (`ownerUid`), the issuer and super admins. The only allowed update is a
  one-way revocation (`valid` → `revoked` with a server `revokedAt`). Deletes are denied:
  credentials are records.
- Anonymous sessions are never accounts, whatever claims they carry. Everything else is denied.

**Consequences.** Issuing directly from the browser does not consume institution credits — rules
cannot safely debit `creditBalance` (only super admins may write institutions). Before credits
are enforced, issuance should move to a server route that debits credits in a transaction, and
`vault_items` creation should then be closed to clients. Logged as PLAN Q3.

---

## ADR-019 — Security is tested against Firebase emulators; emulators can never be on in production

**Date:** 2026-11-12 · **Status:** Accepted

**Decision.** Claims, sessions, the proxy and the rules are tested against the real Firebase Auth
and Firestore emulators (`npm run test:emulator`, project `demo-v6`), and end to end against the
production build (`scripts/e2e-auth.mjs`). The rules suite was checked to be meaningful: with
allow-all rules, 14 of its 18 tests fail.

With an emulator variable set, the Admin SDK accepts **unsigned** tokens. Initialisation
therefore refuses to run when an emulator variable is present on Cloud Run (`K_SERVICE`), or in
any production build unless `ALLOW_FIREBASE_EMULATOR=true` (local end-to-end tests only).

**Limits.** The emulator always checks revocation and never checks signatures, so those two
behaviours are verified only by Firebase's own guarantees and code review.

---

## ADR-020 — Upload gateway: shadcn/ui primitives copied in; compression on the main thread

**Date:** 2026-11-12 · **Status:** Accepted

**Decision.**

- shadcn/ui is a copy-in component collection, not a package: `src/components/ui/dialog.tsx` is
  its Dialog (Radix UI) adapted to be full-screen on phones, with `cn` in `src/lib/utils/cn.ts`.
  No shadcn CLI or `components.json` yet; add them when more primitives are needed.
- `browser-image-compression` runs with `useWebWorker: false`: its worker mode downloads the
  library from a CDN at run time. The crop is already scaled to ≤ 1600 px, so compression on the
  main thread is quick. If the result is still over 200 KB, dimensions shrink by 30 % per retry.
- Photos are saved as JPEG (white behind transparency); PNGs stay PNG so logos and signatures
  keep transparency.
- The CSV gate blocks Confirm on missing required columns (exact match after trimming, with a
  hint for case/spacing near-matches), on empty files, and above 2,500 rows (PLAN E11).
- Uploads are limited to JPG, PNG and WebP images (20 MB before editing) and CSV (5 MB). HEIC
  from iPhones is not accepted yet: Chromium cannot decode it.
