# Changelog

Newest first. Per-change detail: git history and the repository-root `CHANGELOG.md`.

## Completed

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

- **Phase 7 — Passwordless Claiming & The Vault** (see `STATE.md`).
