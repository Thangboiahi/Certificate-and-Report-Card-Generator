# Changelog

All notable changes. Newest first. Details and reasoning: `docs/DEVLOG.md`, `docs/DECISIONS.md`.

## Unreleased

### Changed

- Admin SDK initialises with an explicit service account (`FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`) when set; otherwise unchanged (ADR-031).
- Paid claims go through `/api/checkout` and are minted only from a verified Razorpay webhook or the server's own Razorpay check; `/api/claim/order` (Phase 7 work in progress) is removed and `/api/claim` claims free credentials only.
- Dispatch refuses a claim fee when the institution has no Razorpay Linked Account (`PAYOUT_ACCOUNT_MISSING`, nothing charged).
- Institutions may carry `razorpayAccountId` (set by super admins).
- Dispatch requests carry `templateId` and a batch `tokenExpiry`; claim tokens are minted by the server (no per-recipient `claimToken`/`expiresAt`).
- Roadmap replaced by the 9-phase B2B2C plan; ADR-015 accepted; local-emulator development until a live project exists.
- `TemplateRecord.ownerId` is now `ownerUid`, with `institutionId` and server timestamps.
- `/dashboard/vault` moved into the `(workspace)` route group (same URL) and is titled "My Digital Vault".

### Added

- `/login` page (B-001): email-link / SMS sign-in via `PasswordlessSignIn`, then redirect by role (`inst_admin`/`inst_staff` → `/dashboard/institution`, `individual` → `/dashboard/vault`, `super_admin` → `/admin`; a safe `?next=` the user may open wins). `roleHomePath` and `postLoginPath` in `src/lib/auth/access.ts`; login checks in `scripts/e2e-auth.mjs`.
- Phase 9, AI enrichment and Smart Audit: `src/lib/ai/` (`geminiClient.ts` browser API with `enrichDataBatch` and `processAiAuditCommand`; server-only Gemini client; zod-validated, allow-listed JSON patches); `POST /api/ai/enrich` and `POST /api/ai/audit` (sign-in required, 503 without `GEMINI_API_KEY`); `SmartAuditCarousel` (swipeable row review, issue flags, chat commands, undo) and `AiMagicButton` (translate / remarks / custom column) in the editor; `applyAiPatch` and `restoreSnapshot` on the template store; `scripts/e2e-ai.mjs`. Usage is not metered yet (ADR-029).
- Phase 8, escrow payment engine: `src/lib/razorpayClient.ts`; `POST /api/checkout` (cart: claim fee + optional AI add-on, Razorpay Route transfer to the institution held in escrow); `GET /api/checkout` (status with reconciliation); `POST /api/webhooks/razorpay` (`payment.captured` mints the vault item and consumes the claim token); automatic refunds with transfer reversal; `POST /api/cron/reconcile-payments`; cart and confirmation on the claim page; `claim_orders` ledger.
- Phase 7: passwordless sign-in (email link, phone OTP), `/claim/[token]`, free claims into the vault, vault sharing API; `VaultDashboard` on `/dashboard/vault` (grid of owned credentials, "Generate Public Link" / stop sharing); public verification page `/v/[shareId]`; `vault_items` `ownerUid + issuedAt` index; `scripts/e2e-vault.mjs`.
- Phase 6: `AuditLedger` with 1-Click Re-Issue (`POST /api/dispatch/reissue`, no credits); `issued_batches` ledger; server-minted, SHA-256-stored, time-locked claim tokens (`tokenManager.ts`) and `POST /api/cron/purge-claim-tokens`.
- Phase 5: `KanbanBoard` for credential requests (`@hello-pangea/dnd`); `POST /api/dispatch/whatsapp` (Meta Cloud API) and `POST /api/dispatch/email` (Resend) with credits deducted before sending, refunds and an idempotent `dispatches` ledger.
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
