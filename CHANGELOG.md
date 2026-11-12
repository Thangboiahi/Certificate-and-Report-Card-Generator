# Changelog

All notable changes. Newest first. Details and reasoning: `docs/DEVLOG.md`, `docs/DECISIONS.md`.

## Unreleased

### Changed

- Roadmap replaced by the 9-phase B2B2C plan; ADR-015 accepted; local-emulator development until a live project exists.
- `TemplateRecord.ownerId` is now `ownerUid`, with `institutionId` and server timestamps.
- `/dashboard/vault` moved into the `(workspace)` route group (same URL) and is titled "My Digital Vault".

### Added

- Phase 4: Tap-to-Place editor at `/editor` (`MobileEditor` with pdf.js backgrounds, drag and tap-to-place; `PropertyBar` bottom sheet with D-pad and font size; Zustand `templateStore` in PDF points); `WorkspaceToggle` between "My Digital Vault" and "Issue Credentials"; guarded `/dashboard/issue`.
- Phase 3: `generatePdfBatch` returns a single ZIP of PDFs (streamed, memory-flat to 2,500 rows); worker at `src/workers/pdf.worker.ts`, client at `src/lib/pdfEngine.ts`; image proxy accepts the session cookie.
- Phase 2 upload gateway: `UniversalUploadZone`, `ImageCropModal` (crop + ≤ 200 KB compression), `CsvPreviewModal` (5-row preview, required-column check), shadcn Dialog.
- V6 Phase 1, roles and access control: role types, custom-claims management, session cookies
  (`/api/auth/session`), route protection (`src/proxy.ts`) for `/admin`,
  `/dashboard/institution`, `/dashboard/vault` and `/editor`, server-side page guards, and
  Firestore security rules for institutions, templates and vault items, with emulator tests.
- Template schema for multi-page documents with text, image and QR placeholders, runtime
  validation and data bindings.
- `/api/proxy-image`: authenticated, SSRF-safe image relay for the browser-side engine.
- PDF generation engine: Indian-script text shaping, wrapping and shrink-to-fit, images with
  cover/contain, EXIF orientation and masks, vector QR codes, rotated/cropped template pages,
  separate and merged output.
- Web Worker (comlink) with image loading, shrinking and format conversion.
- Developer playground at `/playground`, sample template, end-to-end script.
- Dockerfile for Cloud Run (not yet built).
- Project records: `docs/PLAN.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `DEVLOG.md`, `CLAUDE.md`.
