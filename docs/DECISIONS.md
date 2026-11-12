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
| 015 | Google access via `drive.file` + Google Picker only                                    | Accepted |
| 016 | Elevated roles as Firebase custom claims: one role, one institution                    | Accepted |
| 017 | Sessions: Firebase session cookies, verified in the proxy and again in server code     | Accepted |
| 018 | Firestore rules model for institutions, templates and vault items                      | Accepted |
| 019 | Security is tested against Firebase emulators; emulators can never be on in production | Accepted |
| 020 | Upload gateway: shadcn/ui primitives copied in; compression on the main thread         | Accepted |
| 021 | Batch output: streamed ZIP of Blobs; the image proxy stays same-origin (no CORS)       | Accepted |
| 022 | Tap-to-Place editor: pdf.js to display, percent on screen, points in the store         | Accepted |
| 023 | Workspace toggle: one route per workspace; the tabs follow the address                 | Accepted |
| 024 | Dispatch: credits deducted in a transaction before sending; refunds; idempotent ledger | Accepted |
| 025 | CRM Kanban with `@hello-pangea/dnd`; optimistic moves; not persisted yet               | Accepted |
| 026 | Audit ledger, server-minted hashed claim tokens, bounded free re-issue, purge sweep    | Accepted |
| 027 | Passwordless claiming bound to the contact the link was sent to; vault sharing links   | Accepted |
| 028 | Escrow payment engine: server-priced cart, Route split on hold, webhook-only minting   | Accepted |

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

---

## ADR-021 — Batch output: streamed ZIP of Blobs; the image proxy stays same-origin (no CORS)

**Date:** 2026-11-12 · **Status:** Accepted

**ZIP without holding the batch in memory.** `generatePdfBatch` returns one ZIP for up to 2,500
rows on a mid-range phone. Held as byte arrays in the worker, 2,500 PDFs (≈ 70 MB in the
playground sample, far more with photo-heavy templates) plus JSZip's copy would crash the tab.
Instead each PDF becomes a `Blob` as soon as it is produced (the browser's blob store holds it
outside the JS heap and can page it to disk); JSZip reads those back one at a time while writing
the archive with `generateInternalStream`, and output chunks are gathered into Blobs every 4 MB.
Entries are STORED (PDFs are already compressed). Measured: 2,500 rows → 71.2 MB ZIP with the
worker's heap peaking at 35 MB. The result is a `Blob`, not an `ArrayBuffer`, for the same reason.
A cancelled batch returns no ZIP.

**No permissive CORS on `/api/proxy-image` (the brief asked for it).** The Web Worker fetches the
proxy from the app's own origin, and same-origin responses never taint a canvas, so CORS headers
add nothing. `Access-Control-Allow-Origin: *` would only let other websites use the proxy (and the
images it fetches) — ADR-005's same-origin design is kept. Instead the proxy now also accepts the
session cookie, which the browser attaches to the worker's same-origin fetches automatically, so
the worker needs no token plumbing; a bearer ID token still works (e.g. anonymous guests). The
cookie is SameSite=Lax, so other sites' pages cannot make the browser send it on sub-requests.

**Text sizing.** The brief's "shrink while `font.widthOfTextAtSize` exceeds `maxWidth`" is
implemented by the engine's shrink-to-fit (ADR-007) with shaped widths; pdf-lib's
`widthOfTextAtSize` is wrong for Indian scripts and for kerned text.

**Consequences.** Separate-file batches run at ~40 rows/s on the development machine (each PDF is
the full template saved again); expect several times slower on a phone (~4–6 minutes for 2,500).
Merged output is ~7× faster and smaller when per-person files are not required.

---

## ADR-022 — Tap-to-Place editor: pdf.js to display, percent on screen, points in the store

**Date:** 2026-11-12 · **Status:** Accepted

**Context.** Phase 4 asked for a mobile editor that renders the PDF background, places fields as
absolutely positioned `div`s using percentages, and keeps coordinates exact for the PDF Web
Worker.

**Decision.**

- **Units.** On screen everything is a percentage of the rendered page (`left`, `top`, `width`,
  `height`), so a field sits on the same spot of the artwork at any screen width. The store
  (`src/store/templateStore.ts`, Zustand) keeps the template exactly as the worker consumes it — PDF
  points from the top-left of the displayed page (ADR-003) — and every action converts once
  (`src/lib/editor/coordinates.ts`). Stored values are clamped to the page and rounded to 1/100 pt
  (0.0035 mm) so repeated conversions leave no float tails. `activeTemplate` goes to
  `generatePdfBatch` unchanged; nothing else converts.
- **Font size on screen** is `fontSize / pageWidth × 100` `cqw` of the page element (a CSS size
  container), so the preview is at true scale without measuring in JavaScript.
- **Background rendering: pdf.js** (`pdfjs-dist` 6.4.299, pinned). pdf-lib cannot rasterise, and
  phones' built-in PDF viewers cannot be overlaid. pdf.js is loaded only by the editor (129 KB
  gzipped) and parses in its own worker (363 KB gzipped, `src/workers/pdfjs.worker.ts`). At scale
  1 its viewport is the displayed page in points, so the editor warns when the file does not
  match the template's recorded page sizes. Canvas resolution follows the device pixel ratio,
  capped at 3× and 4,096 px per side for phone memory.
- **Interaction.** Tap selects; dragging moves; with a field selected, tapping its page centres
  the field there (the "tap-to-place" gesture); arrow keys nudge 1 pt (Shift 10 pt). On touch
  screens only the **selected** field is draggable — otherwise a swipe that happens to start on a
  field would move it instead of scrolling. This rule is enforced in code, not left to
  `touch-action`, because browsers do not always hand such swipes to scrolling.
- **Property bar**: a non-modal Framer Motion bottom sheet (`framer-motion` 14.6.0), so another
  field can be tapped behind it. D-pad buttons repeat while held (400 ms, then every 60 ms); steps
  1 pt and 10 pt; font size −/+ and a slider. When the size goes below the shrink-to-fit minimum,
  the minimum follows (the schema requires `minFontSize ≤ fontSize`). Swipe the handle down,
  press Escape or the close button to dismiss. Animations respect "reduce motion".
- The preview is HTML text: position, box, size, colour and alignment are exact, but
  shrink-to-fit, Indic shaping and line breaks are the engine's and may differ slightly. The
  editor's "Test PDF" button generates the previewed row in the real worker.

**Why percentages are not stored** (they were considered in ADR-003): font sizes and borders would
still need points, and a template would be meaningless without its page size.

**Verified.** Unit tests round-trip every whole-point position through percent and back exactly;
a store → engine → poppler test checks edited positions on a plain and a `/Rotate 90` page;
`scripts/e2e-editor.mjs` drives the editor on a touch phone and a desktop and reads the worker's
PDF back with `pdftotext -bbox` (the name prints inside the edited box, centred within 1.5 pt).

**Revisit when** templates need many pages (render only visible pages), resizing handles are
added, or field rotation becomes editable (clamping currently ignores rotation).

---

## ADR-023 — Workspace toggle: one route per workspace; the tabs follow the address

**Date:** 2026-11-12 · **Status:** Accepted

**Decision.** "My Digital Vault" (`/dashboard/vault`) and "Issue Credentials"
(`/dashboard/issue`) stay separate routes, each with its own server-side access check (ADR-017).
`WorkspaceToggle` is shadcn/ui Tabs (`@radix-ui/react-tabs` 1.2.1, copied in as
`src/components/ui/tabs.tsx`) whose value is derived from the path; choosing a tab navigates, with
an optimistic highlight (`useOptimistic`) and a Framer Motion sliding pill. The current page is
rendered as the active tab's panel. Both pages share a `(workspace)` route-group layout, so URLs
did not change. `/dashboard/issue` has an explicit `signed-in` rule: any signed-in,
non-anonymous person may be a Micro-Issuer.

**Why not two client-side panels on one page.** Each workspace will load different data with
different permissions; separate routes keep links, Back and server-side checks working, and do
not load the issuer's tools for someone only opening their vault.

**Consequences.** Institution staff and admins also see both workspaces (their institution
dashboard is separate). Whether institution members should issue personally is a product
question (PLAN Q4).

---

## ADR-024 — Dispatch: credits deducted in a transaction before sending; refunds; idempotent ledger

**Date:** 2026-11-12 · **Status:** Accepted (request format amended by ADR-026: tokens are now
minted by the server)

**Context.** Phase 5 asked for `POST /api/dispatch/whatsapp` (Meta WhatsApp Cloud API, Utility
template with the claim link and an expiry warning) and `POST /api/dispatch/email` (Resend), with
credits deducted from `institutions/{id}.creditBalance` **before** the external APIs are called.

**Decision.**

- **Who:** institution admins and staff only (session cookie, revocation checked, same-origin).
  Membership is re-checked against the institution document (claims can lag), and the
  institution must be `verified` — an unverified account must not be able to message thousands
  of people from our sender. Micro-Issuers have no credit balance, so they cannot dispatch yet.
- **Charge first, then send, then settle.** One Firestore transaction checks membership,
  verification and balance, deducts `1 credit × recipients` and creates `dispatches/{id}`
  (`status: sending`). Only then is the provider called. A second transaction refunds one credit
  per failed recipient and stores per-recipient results. Concurrent dispatches cannot overspend
  (tested: three parallel dispatches of 3 from 10 credits leave exactly 1).
- **Idempotency.** The body carries `idempotencyKey`; the record id is
  `sha256(institution, channel, key)`. Re-posting the same key returns the stored outcome
  (`replayed: true`) without sending or charging; reusing it for a different recipient count is
  refused (409). Resend batches also carry an idempotency key. WhatsApp has none, so the record
  is the only guard.
- **Claim links are built on the server** from `APP_ORIGIN` + a validated token
  (`/claim/{token}`); the request cannot supply a URL. A hijacked staff account therefore cannot
  use our WhatsApp number or email domain for phishing links. `APP_ORIGIN` becomes required for
  dispatch.
- **WhatsApp:** template named by `WHATSAPP_CLAIM_TEMPLATE`, body parameters {{1}} name,
  {{2}} issuer, {{3}} link, {{4}} expiry (en-IN date, India time). 8 requests in parallel, 10 s
  timeout each. Phone numbers normalised to E.164 digits; bare 10-digit numbers must be Indian
  mobiles.
- **Email:** Resend batch API, 100 per call; names HTML-escaped; expiry warning in the body.
- **Limits:** 500 recipients per request; duplicates and already-expired links are refused.
- **Privacy:** dispatch records hold counts, results and provider message ids — no phone numbers
  or emails (DPDP data minimisation). `dispatches` is closed to all clients in the rules.
- **Not configured → 503 before anything is charged.**

**Price.** One credit per message per channel is a placeholder until pricing (PLAN E12).

**Consequences / open.** If the server dies after charging and before settling, the record stays
`sending` with the full charge; a reconciliation job (from provider ids) is needed before launch.
Claim tokens are only format-checked: storing and redeeming them (the `/claim` page) is not built
yet. Meta requires an approved template, a verified business and a registered number; Resend
requires a verified sending domain (PLAN E17, E18).

---

## ADR-025 — CRM Kanban with `@hello-pangea/dnd`; optimistic moves; not persisted yet

**Date:** 2026-11-12 · **Status:** Accepted

**Decision.** `KanbanBoard` uses `@hello-pangea/dnd` 18.0.1 (as briefed; the maintained fork of
react-beautiful-dnd) for mouse, touch (press and hold) and keyboard dragging with screen-reader
announcements. Four fixed stages (`src/types/crm.ts`). Moves apply at once; an optional `onMove`
persists them, and a rejected promise rolls the move back with a message. Pure state logic is in
`src/lib/crm/board.ts`. On phones the columns form a horizontally snapping strip.

**Not persisted.** No brief defines where requests come from (recipient self-service form, CSV
import, Google Sheets) or who may move them, so the board shows sample requests on the
institution dashboard and the issuer workspace. A `credential_requests` collection with rules
comes with that brief.

---

## ADR-026 — Audit ledger, server-minted hashed claim tokens, bounded free re-issue, purge sweep

**Date:** 2026-11-12 · **Status:** Accepted

**Context.** Phase 6: track dispatched batches for "1-Click Re-Issue" without new credits, and
enforce expiry of claim links so stale data does not pile up.

**Decision.**

- **Ledger.** Every dispatch writes `issued_batches/{id}` (same id as `dispatches/{id}`) in the
  credit transaction: `issuerUid`, `templateId` (+ name), `recipientCount`, `dispatchedAt`
  (server time), `tokenExpiry`, channel, sent/failed counts, re-issue count and outcome,
  `purgedAt`.
- **Tokens are minted by the server** (changes the Phase 5 request): 32 random bytes,
  base64url. Only the SHA-256 is stored, as the id of `claim_tokens/{hash}`, with the
  recipient's name and contact (needed to re-issue), `expiresAt`, `purgeAfter` and `claimedAt`.
  A database leak therefore yields no working link, and a request can no longer choose a token.
  The request names a `templateId` of the caller's institution (checked in the transaction) and
  one `tokenExpiry` for the batch, at most 90 days ahead.
- **Expiry is enforced at verification**, not by the sweep: `verifyClaimToken` refuses a token
  from its expiry instant on (`now >= expiry`).
- **Purge.** `purgeExpiredClaimTokens` deletes tokens whose `purgeAfter` (expiry + 30 days) has
  passed, in pages, and stamps `purgedAt` on a batch once none of its tokens remain. The 30-day
  grace keeps re-issue possible for latecomers; after it, the recipients' personal data is gone
  (DPDP minimisation) and the ledger row stays with counts only. Run daily by Cloud Scheduler via
  `POST /api/cron/purge-claim-tokens` with `CRON_SECRET` (constant-time comparison).
- **Re-issue is free, so it is bounded:** unclaimed recipients only (including previously failed
  deliveries), fresh tokens (old links die), new expiry = now + the batch's original validity,
  through the original channel; at most 3 per batch, 10 minutes apart; a lock prevents
  concurrent runs and is taken over after 15 minutes if its worker died. Members of the batch's
  institution (checked against the directory) or the issuer of a personal batch; anyone else gets 404. A refused attempt is not counted.
- `issued_batches` and `claim_tokens` are server-only in the rules; the ledger is read with the
  Admin SDK during server rendering. Composite indexes are declared in
  `firebase/firestore.indexes.json`.

**Why not let re-issue resend the old links.** They may have expired or leaked; fresh tokens make
the newest message the only working one.

**Open.** Claiming (setting `claimedAt`, creating the vault item, the `/claim` page) is not
built. Whether re-issues should be free without limit, or cost credits, is a pricing question
(Q5). If the server stops mid re-issue, some recipients may hold renewed links that were never
sent; a later re-issue covers them.

---

## ADR-027 — Passwordless claiming bound to the contact the link was sent to; vault sharing links

**Date:** 2026-11-12 · **Status:** Accepted (written in session 10 for the Phase 7 code of session 9;
the browser sign-in flows are not yet tested — see PLAN Phase 7. Payment part amended by ADR-028.)

**Context.** Phase 7: recipients claim the credential behind a claim link (ADR-026) into their own
vault without creating a password, and can share it.

**Decision.**

- **Sign-in is passwordless only:** Firebase email link or phone OTP (`src/lib/firebase.ts`). The
  fresh ID token is exchanged once for the httpOnly session cookie (ADR-017) and the browser-side
  Firebase session is dropped (in-memory persistence). The Firebase web configuration is read from
  the server's environment at request time and passed as a prop, so one build serves every
  environment and the emulator address only reaches a browser through a server that passed the
  emulator guard (ADR-019). `firebase` moved from dev to runtime dependencies.
- **A claim link only works for the person it was sent to.** The signed-in account must prove the
  same contact: the same phone number (OTP-verified) for WhatsApp links, or the same email address
  verified by Firebase for email links (`contactMatches`). A forwarded link is useless to anyone
  else. The session therefore carries `phoneNumber` and `emailVerified`.
- **The public claim page** shows who issued what and a masked contact (`+91 ••••••3210`,
  `a•••@example.in`); the recipient's name only to the matching signed-in user. `referrer:
no-referrer` and `noindex`, because the token is in the address.
- **Claiming** is one transaction: token marked claimed (`claimedAt`, `claimedByUid`),
  `vault_items/{tokenId}` created (so a second claim finds the same item), batch `claimedCount`
  incremented. Claiming twice returns the same item.
- **Sharing:** the owner turns on an unguessable `shareId` (256-bit) for a public verification page
  `/v/{shareId}`; turning it off deletes the id, so old links die.
- Dispatch may set an optional claim fee (`claimFeePaise`, ₹1–₹10,000) stored on each token.

**Amended by ADR-028:** the session-9 code took the Razorpay Checkout callback's signature from the
browser as proof of payment and minted from it. That path (`/api/claim/order`, `payment` in
`/api/claim`) was replaced before release: paid claims are minted only from a captured payment that
Razorpay itself vouches for.

---

## ADR-028 — Escrow payment engine: server-priced cart, Route split on hold, webhook-only minting

**Date:** 2026-11-12 · **Status:** Accepted (prices and hold period are placeholders, PLAN E12/Q8;
verified against a mock of Razorpay's API, not yet against Razorpay test mode, PLAN E13)

**Context.** Phase 8 brief: a dynamic pay-as-you-go checkout (Base Fee + AI Fee) with Razorpay
Route revenue splitting — the platform fee to the main account, the remainder to the institution's
`razorpayAccountId` — and a `payment.captured` webhook that mints the `VaultItem` and consumes the
claim token, with exact signature verification so nobody can mint by forging a payment.

**Decision.**

- **What is sold:** claiming one credential. The cart is priced on the server only:
  **Base Fee** = the claim fee on the token (set by the issuer at dispatch), plus optional
  **add-ons** — today `ai_enrichment` (the "AI Fee"), priced by `AI_ENRICHMENT_FEE_PAISE`. The add-on
  is **off unless that variable is set**: Phase 9 has not defined what AI enrichment delivers, and
  we should not sell it before it exists. A vault item records the add-ons it was bought with, for
  Phase 9 to fulfil.
- **Split (Razorpay Route, transfers created with the order):** issuer share = Base Fee − platform
  fee; platform fee = `PLATFORM_FEE_BPS` of the Base Fee (default 10 %, rounded to the paisa,
  capped at 50 %), lowered when needed so the transfer is never under Razorpay's ₹1 minimum.
  Add-ons stay entirely with the platform. Razorpay's own fee is charged to the main account, so
  the platform fee must cover it (≈2 % + GST).
- **Escrow:** the transfer is created `on_hold` until `ESCROW_HOLD_DAYS` (default 7) after checkout.
  Until then the money sits in the institution's Route balance but does not settle to its bank, so
  a payment that cannot be honoured can be refunded with `reverse_all: true`, which takes the
  transfer back.
- **Payout account:** `InstitutionSchema.razorpayAccountId` (`acc_…`), set by a super admin after
  Razorpay has onboarded the institution as a Linked Account (rules: super admins only, format
  checked). No account → checkout refuses (`ISSUER_NOT_PAYABLE`) and **dispatch refuses a claim fee
  before charging credits** (`PAYOUT_ACCOUNT_MISSING`), so recipients never receive a link they
  cannot pay. Micro-Issuers cannot dispatch yet (ADR-024), so they have no payout path; the engine
  takes the payee from the token's issuer and is ready for one.
- **Minting only from what Razorpay vouches for.** The browser's Checkout callback proves nothing
  and mints nothing; the page just polls `GET /api/checkout`. A paid claim is minted by:
  1. the **webhook** `payment.captured`, after an exact check of `X-Razorpay-Signature`
     (HMAC-SHA256 over the raw request bytes with `RAZORPAY_WEBHOOK_SECRET`, hex, constant-time;
     size-limited; nothing read or written before it passes), or
  2. **pull reconciliation**: our own authenticated `GET /orders/{id}/payments`, made by the status
     poll (at most every 5 s per order) and by a sweep (`POST /api/cron/reconcile-payments`, Cloud
     Scheduler every 15 minutes, `CRON_SECRET`) over open orders 2 minutes to 3 days old.
     Both apply `settleCapturedPayment`: one transaction checks the order is ours and the amount and
     currency match, then mints `vault_items/{tokenId}` (with `orderId`, `paymentId`, `addOns`), marks
     the token claimed and the order `paid`. Idempotent under replays and races (tested: six
     concurrent deliveries mint once).
- **Captures that cannot be honoured are refunded, never kept:** credential already claimed (paid
  twice, e.g. two tabs), claimed by someone else, link purged, amount mismatch, or a stray second
  capture on a settled order. The order records `refund_due` with the reason in the same
  transaction; the refund (`reverse_all`) is attempted at once and retried by the poll and the
  sweep (`refundPending`). A refund Razorpay already made (our call timed out) is recognised from
  the payment's `amount_refunded`.
- **A capture after the link's expiry is honoured** if the order was opened while it was valid
  (the recipient started paying in time).
- **Webhook answers:** 401 bad signature, 413 oversized, 503 not configured; 200 for events we do
  not act on and for signed but unusable payloads (Razorpay disables a webhook that fails for 24 h;
  the sweep covers those); 500 only when the capture could not be recorded, so Razorpay retries.
  Refunds inside the webhook are capped at 2 s per call (Razorpay waits 5 s).
- **Records:** `claim_orders/{razorpayOrderId}` (server-only in the rules): payer, cart, split,
  Linked Account, hold end, status `created → paid | refund_due → refunded`, payment and refund
  ids. Razorpay receives ids and the credential's name only — no names, emails or phone numbers.
- **No `razorpay` npm package.** `src/lib/razorpayClient.ts` is a ~250-line typed client over
  `fetch` (orders with transfers, order payments, payment fetch, refund, webhook verification),
  initialised once from the environment (`getRazorpayClient`). Reasons: its fetch is injectable, so
  tests and the end-to-end run use a recording mock via `RAZORPAY_API_BASE_URL` (the SDK hard-codes
  its host); the SDK's webhook check compares with `===`, not in constant time; it would add axios
  to the server. Revisit if we need many more Razorpay APIs (subscriptions, payouts).
- Replaces the Phase 7 WIP payment path (ADR-027): `/api/claim/order` removed; `/api/claim` is for
  free credentials only (402 for paid ones).

**Consequences / open.** Prices, the add-on and the hold period are placeholders (E12, Q8). Route
must be enabled on the Razorpay account and each institution onboarded as a Linked Account with
KYC (E13, E19). Not yet exercised against Razorpay's test mode, in particular whether `reverse_all`
reverses a transfer created milliseconds earlier on capture. GST invoices for the platform fee and
add-ons are not produced (E14). Refunds that keep failing stay `refundPending` and are logged as
errors; there is no operator screen for them yet.

---

## ADR-029 — AI enrichment and Smart Audit: server-held Gemini key, strict JSON, allow-listed patches

**Date:** 2026-11-12 · **Status:** Accepted (metering open, see below)

**Context.** Phase 9 brief: a `geminiClient` with `enrichDataBatch(rows, prompt, targetCol)` and
`processAiAuditCommand(command, currentState)`, a swipeable `SmartAuditCarousel` with an AI chat
box, and an `AiMagicButton` for translations and remarks. Gemini outputs must be strict JSON so
applying a patch can never crash the UI. The brief's `lib/…` / `components/…` paths map to `src/`.

**Decision.**

- **The key never reaches the browser.** `src/lib/ai/geminiClient.ts` (the brief's file) is the
  browser-side API; it calls `POST /api/ai/enrich` and `POST /api/ai/audit` (`handler.ts`:
  same-origin → JSON → signed-in non-guest → configured → zod-valid body). Gemini itself is called
  only from `src/lib/ai/gemini.ts` (`server-only`) with `GEMINI_API_KEY`; no key = 503
  `AI_NOT_CONFIGURED`. No `@google/genai` package: a ~150-line typed client over `fetch`, injectable
  and mockable via `GEMINI_API_BASE_URL`, same reasoning as ADR-028 (no SDK in the server bundle).
  `GEMINI_MODEL` defaults to `gemini-2.5-flash` (not verified against a live key).
- **Strict JSON, three layers.** (1) Gemini is called with `responseMimeType: application/json` and
  a `responseSchema`; truncated answers (`finishReason ≠ STOP`) are discarded unparsed. (2) The
  text is parsed and validated with zod (`schema.ts`); one retry, then `BAD_MODEL_OUTPUT` (502).
  (3) The browser validates the server's response again before anything touches the store.
- **The patch is data, not code, and is allow-listed.** `AuditPatch` = `dataRows.transforms`
  (rule per column: uppercase, lowercase, titlecase, trim, collapse_spaces — computed locally on
  every row), `dataRows.cells` (single-cell fixes, only for rows the model was shown),
  `placeholders` (text styling: textTransform, align, verticalAlign, #RRGGBB, fontSize 4–2000).
  `applyAuditPatch` skips anything naming a missing column, row or placeholder, or a non-text
  placeholder, reports what was skipped, never throws and never mutates. Bulk fixes therefore cost
  one small request whatever the sheet size (2,500 rows are never sent for an audit).
- **Enrichment** returns `{ i, value }` per row, matched back by index: skipped, repeated or invented
  indexes are dropped, so a missing answer is blank, never shifted onto a neighbour. Batches of 40
  rows, 2 in flight, cancellable. The new column cannot overwrite an existing one; names like
  `__proto__` are refused.
- **Data minimisation (DPDP).** Spreadsheet content is student data. Enrichment sends only the
  columns the person ticks (translate sends exactly one); audit sends headers, ≤ 25 sample rows,
  cells clipped to 300 chars. The UI says so before the first call. Cell content is wrapped as
  untrusted `<data>` in the prompt and the model's output is bounded by the allow-lists above, so a
  hostile cell cannot do more than propose an allow-listed edit that the person sees and can undo.
- **Undo.** `templateStore.applyAiPatch` applies rows and styling in one update and returns the
  report; the carousel keeps one snapshot and `restoreSnapshot` puts it back.
- **Limits.** Prompt/command ≤ 500 chars, ≤ 40 rows and ≤ 40 columns per enrichment request, ≤ 25
  sample rows per audit, ≤ 200 cell edits per patch.

**Consequences / open.**

- **Not metered.** Nothing is charged or rate-limited per call: access is sign-in only. Gemini spend
  is therefore an open exposure for any signed-in user. Before launch decide the model (credits per
  row like dispatch, ADR-024, or the Phase 8 "AI add-on") and add a per-user quota. Until then the
  add-on stays off (`AI_ENRICHMENT_FEE_PAISE` unset) and the key should carry a Google-side budget cap.
- Translations are only as good as the model; the template font must contain the script (ADR-007).
- Not run against the real Gemini API (no key): the request shape follows Google's documented
  `generateContent` structured-output format and is unit-tested against a mock.

---

## ADR-030 — `/login`: reuse passwordless sign-in, route by role on the server

**Status:** Accepted (session 14, resolves B-001).

**Context.** The proxy and `requireAccess` send signed-out visitors to `/login?next=…`, which did not exist. The brief
asked for Google Sign-in and/or passwordless email, and for a redirect by role after sign-in.

**Decision.**

- **Passwordless only (email link + SMS code), by reuse of `PasswordlessSignIn`.** It is already built, unit- and
  emulator-tested and implements ADR-027 (no passwords, browser-side Firebase session dropped after the cookie is set).
  Google Sign-In would add a provider to configure and a popup flow with its own failure modes, for no capability the
  institution staff lack. Revisit if staff ask for it; it fits `establishSession` unchanged.
- **The role comes from the server.** After the cookie is set the page reloads (`window.location.replace`) and the
  server component reads the verified session cookie, then redirects with the pure function `postLoginPath`. Nothing
  about the role is read from, or trusted from, the browser. The session route stays unchanged (204, no body).
- **`?next=` is honoured only when safe and permitted:** same-origin path (`safeReturnPath`), not `/login`, and allowed
  for that user by the shared `ROUTE_RULES`; otherwise the role's home. So no open redirect, no landing on a 403/404.
- `/login` stays public (no `ROUTE_RULES` entry); a signed-in visitor is redirected away, so there is no loop.

**Consequences.** Next streams a redirect issued inside `<Suspense>` (status 200 with `NEXT_REDIRECT` and a meta
refresh) rather than a 307; browsers follow it at once, and the e2e script asserts the target from the body. A true 307
would need the proxy to verify the cookie on `/login` as well; not worth a second copy of the role logic.

---

## ADR-031 — Admin SDK: explicit service account from environment variables, else ambient identity

**Status:** accepted · 2026-11-12. Refines the credentials note in ADR-017/ADR-019 context.

**Context.** Serverless hosting has no ambient identity the Admin SDK can pick up, so Application Default Credentials fail.
**Decision.** `firebase-admin.ts` uses `cert()` from `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY` (literal `\n` turned into
newlines) with project `NEXT_PUBLIC_FIREBASE_PROJECT_ID`. If neither is set it initialises with the project id only, as before,
so the emulator tests and Cloud Run's own identity still work. Setting only one is a configuration error.
**Consequence.** The private key lives in environment variables (cloud secret store, never git). Rotate it if exposed.
