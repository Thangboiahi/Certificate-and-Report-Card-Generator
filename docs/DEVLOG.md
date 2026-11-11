# Development Log

A dated entry for every working session, newest first: what was done, what was learned, how it
was verified, and what is left open. The line-by-line history is in git; this file is the story.

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

_(The engine's fonts, drawing, orchestration, Worker wrapper, playground and Dockerfile are being
built in the same session; this entry is completed at the end of it.)_

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

### Verified

- 167 unit tests pass (schema 13, bindings 8, proxy 120, text layout 26).
- Proxy tests run against a real local HTTP server: redirects to the metadata server, DNS
  rebinding, IPv4-in-IPv6 disguises, oversized and gzip-bomb bodies, stalled origins, forged
  tokens.
- `tsc --noEmit` and `eslint` are clean.

### Open at the time of writing

- Engine fonts / drawing / orchestration, Worker, playground, Dockerfile (in progress).
- The Google Drive direct-download rewrite is unit-tested as a string transformation but has not
  been exercised against real Drive links (needs sample data — PLAN.md item E7).
- Docker is not available in the development sandbox, so the image has to be built in CI or on a
  workstation.
