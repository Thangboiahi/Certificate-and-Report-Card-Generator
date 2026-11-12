# Changelog

Newest first. Per-change detail: git history and the repository-root `CHANGELOG.md`.

## Completed

- **Pre-flight audit:** production build, lint, typecheck, 567 unit and 70 emulator tests all pass; routing and role/claim contract checked. No code changes. One open gap: `/login` page missing (BUGS B-001).

- **Phase 9 — AI Enrichment & Smart Audit:** `src/lib/ai/*`, `/api/ai/enrich`, `/api/ai/audit`,
  `SmartAuditCarousel`, `AiMagicButton` (ADR-029). Verified with mocked Gemini and a stubbed UI run;
  **not** run against the real Gemini API; per-user metering open.
- **Phase 7 — Passwordless Claiming & The Vault:** email-link and phone-OTP sign-in
  (`src/lib/firebase.ts`), public claim page `/claim/[token]` (free claim, or the Phase 8
  checkout), `VaultDashboard` grid with "Generate Public Link", public verification page
  `/v/[shareId]`, `ownerUid + issuedAt` index. Vault verified in Chromium against emulators
  (`scripts/e2e-vault.mjs`). **Not yet exercised in a browser:** the email-link and phone-OTP
  sign-in itself, and a `/login` page (see `STATE.md`).
- **Phase 8 — Escrow Payment Engine:** pay-to-claim checkout with a server-priced cart (claim fee
  - optional AI add-on), Razorpay Route split (platform fee kept, institution share transferred and
    held 7 days), webhook-only minting with exact signature checks, automatic refunds with transfer
    reversal, pull reconciliation and a sweep route. Verified against a mock of Razorpay.
- **Phase 6 — Audit Ledger & Time-Locked Claims:** `issued_batches` ledger, server-minted
  SHA-256-stored claim tokens with expiry and 30-day purge, `AuditLedger` table with free,
  bounded 1-Click Re-Issue, purge route for Cloud Scheduler.
- **Phase 5 — CRM Kanban & Dispatch:** 4-column Kanban board; WhatsApp (Meta Cloud API) and
  email (Resend) dispatch with credits deducted before sending, refunds, idempotent ledger.
- **Phase 4 — Mobile Canvas Editor:** Tap-to-Place editor (pdf.js background, drag, D-pad,
  font size), Zustand store in PDF points, vault/issuer workspace toggle.
- **Phase 3 — PDF Web Worker Engine:** `generatePdfBatch` → streamed ZIP, memory-flat to 2,500
  rows; image proxy accepts the session cookie.
- **Phase 2 — Universal Uploader:** dropzone, crop + ≤200 KB compression, CSV preview gate.
- **Phase 1 — RBAC Foundation:** roles as custom claims, session cookies, route proxy,
  Firestore rules, emulator tests. (`/login` page and first super-admin seed still open.)

## In progress

- Nothing. Next: `/login` page, then live API keys.
