# Project Plan

The single place to see what we are building, where we are, what comes next, and what is waiting
on a decision. Updated at the end of every working session.

**Last updated:** 2026-11-12 (session 7 — Phase 5, CRM Kanban and dispatch)

Related records: [ARCHITECTURE.md](./ARCHITECTURE.md) (how it works) ·
[DECISIONS.md](./DECISIONS.md) (why) · [DEVLOG.md](./DEVLOG.md) (history)

---

## 1. What we are building

A web app that turns **one template + one spreadsheet** into **hundreds or thousands of filled
documents**: certificates, report cards, ID cards, admit cards, membership cards, letters — any
document that is the same design filled in for many people.

**Who it is for:** schools, coaching institutes, colleges, event organisers and small businesses
in India. Typical user: an office administrator on a phone or a modest laptop, working from a
Google Sheet, often with names in a regional language.

**What makes it different:**

- It runs in the customer's browser, so it is cheap to operate and recipient data (children's
  names and photos) is not stored by us.
- It is designed for phones first, including placing fields by tapping on the template.
- It handles Indian scripts properly, multi-page documents, and photos.

### V6 direction (from session 2): a B2B2C credential platform

Beyond generating documents, the platform issues **credentials into recipients' vaults**:

- **Independent users** keep the credentials issued to them in a personal vault.
- **Micro-Issuers** (individuals) design templates and issue credentials under their own name.
- **Institutions** issue through their **staff** and **admin**, spending prepaid **credits**.
- **Super Admins** run the platform (institutions, tiers, users, revenue).

Phase 1 of V6 (roles, sessions, route protection, Firestore rules) is done — see the roadmap.

## 2. Fixed constraints (set by the executive)

| Area       | Constraint                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------- |
| Hosting    | Next.js 15+ (App Router) in Docker on Google Cloud Run, scale-to-zero                           |
| Ecosystem  | Firebase Auth (Google Sign-In), Firestore, Cloud Storage, Google Sheets API, Google Drive API   |
| UX         | Mobile-first, minimalist, light/dark themes (next-themes), Framer Motion, "Tap-to-Place" editor |
| Admin      | Super Admin dashboard secured with Firebase Custom Claims: tiers, users, Razorpay metrics       |
| Processing | In the browser: Web Workers (comlink) + pdf-lib, to keep backend compute minimal                |
| Documents  | Multi-page templates; placeholders of type text, image and QR; coordinates carry a page index   |
| Images     | Fetched through a Next.js proxy route (CORS); drawn without distortion (cover / contain)        |

## 3. Roadmap — 9-phase B2B2C architecture

Set by the executive on 2026-11-12. It replaces the earlier M0–M7 milestone roadmap (kept in git
history and DEVLOG session 1–2 entries). Phases are defined by the executive one at a time; a
phase's scope is recorded here when its brief arrives, never guessed in advance.

Status key: ✅ done and verified · 🟡 in progress · ⬜ not started

| Phase | Name                                           | Status                                 |
| ----- | ---------------------------------------------- | -------------------------------------- |
| 1     | RBAC & Foundation                              | 🟡 (login page, super-admin seed open) |
| 2     | Universal Uploader & Image Editor              | ✅                                     |
| 3     | Core PDF Engine (Web Worker, ZIP, image proxy) | ✅                                     |
| 4     | Canvas UI & Workspace Toggles                  | ✅ (real-phone check open)             |
| 5     | CRM & Kanban Dashboards (dispatch)             | ✅ (live provider accounts open)       |
| 6–9   | To be briefed                                  | ⬜                                     |

### Phase 1 — RBAC & Foundation (two items open)

| Item                                                                                         | Status |
| -------------------------------------------------------------------------------------------- | ------ |
| Role and record types (`UserRole`, institution, vault item)                                  | ✅     |
| Custom-claims management with institution directory sync and session revocation              | ✅     |
| Session cookies (`/api/auth/session`), server-side guards                                    | ✅     |
| Route protection proxy for `/admin`, `/dashboard/institution`, `/dashboard/vault`, `/editor` | ✅     |
| Firestore rules for institutions, templates, vault items                                     | ✅     |
| Local Firebase emulator workflow with placeholder `.env.local` (no live project, no billing) | ✅     |
| `/login` page (Google Sign-In UI) wired to the Auth emulator                                 | ⬜     |
| Seeding the first super admin in the emulator                                                | ⬜     |

### Phase 2 — Universal Uploader & Image Editor

Every upload passes a client-side Preview ➔ Crop/Audit ➔ Confirm gateway.

| Item                                                                                 | Status          |
| ------------------------------------------------------------------------------------ | --------------- |
| `imageEditor.ts`: canvas crop (`getCroppedImg`) + compression to ≤ 200 KB            | ✅              |
| `ImageCropModal`: full-screen on phones, zoom slider and pinch, fixed aspect ratio   | ✅              |
| `CsvPreviewModal`: first 5 rows, red warning and blocked confirm for missing columns | ✅              |
| `UniversalUploadZone`: drop/tap, routes images and CSVs to the right modal           | ✅              |
| Wiring into real screens (template upload, data intake)                              | ⬜ later phases |

### Phase 3 — Core PDF Engine (Web Worker & image proxy)

| Item                                                                                                  | Status |
| ----------------------------------------------------------------------------------------------------- | ------ |
| `src/workers/pdf.worker.ts`: `generatePdfBatch(template, rows, settings)` → one ZIP (Blob)            | ✅     |
| `src/lib/pdfEngine.ts`: client wrapper via `Comlink.wrap`, progress, cancel, `saveBlob`               | ✅     |
| `/api/proxy-image`: accepts the session cookie (same-origin worker fetches) as well as a bearer token | ✅     |
| 2,500-row batch verified in Chromium; worker heap stays flat                                          | ✅     |
| Measured on a real mid-range Android phone                                                            | ⬜     |

### Phase 4 — Canvas UI & Workspace Toggles

The "Tap-to-Place" editor and the toggle between a person's vault and their Micro-Issuer tools.
Decisions in ADR-022 and ADR-023.

| Item                                                                                                                                                   | Status          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| `src/store/templateStore.ts` (Zustand): `activeTemplate`, `selectedPlaceholderId`, `dataRows`, `updatePlaceholderCoords(id, x%, y%)`, nudge, font size | ✅              |
| `src/components/canvas/MobileEditor.tsx`: pdf.js background, percent-positioned fields, drag, tap-to-place                                             | ✅              |
| `src/components/canvas/PropertyBar.tsx`: Framer Motion bottom sheet, D-pad nudge (1/10 pt), font size                                                  | ✅              |
| `src/components/dashboard/WorkspaceToggle.tsx`: "My Digital Vault" ⇄ "Issue Credentials" (shadcn Tabs)                                                 | ✅              |
| `/editor` (sample template, Test PDF via the worker), `/dashboard/issue` (guarded issuer workspace)                                                    | ✅              |
| Positions on screen = positions printed by the worker (poppler-checked, plain and rotated pages)                                                       | ✅              |
| Checked on a real mid-range Android phone                                                                                                              | ⬜              |
| Editing a customer's own uploaded template and saving it to Firestore                                                                                  | ⬜ later phases |
| Resize handles, adding/removing fields, undo                                                                                                           | ⬜ not briefed  |

### Phase 5 — CRM & Kanban Dashboards, dispatch

Decisions in ADR-024 and ADR-025.

| Item                                                                                                   | Status           |
| ------------------------------------------------------------------------------------------------------ | ---------------- |
| `KanbanBoard` (`@hello-pangea/dnd`): New Requests · Pending User Data · Ready to Issue · Issued        | ✅               |
| `POST /api/dispatch/whatsapp`: Meta Cloud API Utility template with claim link and expiry              | ✅ (mocked)      |
| `POST /api/dispatch/email`: Resend batch with claim link and expiry warning                            | ✅ (mocked)      |
| Credits deducted in a transaction before sending; refunds for failures; idempotent `dispatches` ledger | ✅               |
| Sending through real Meta and Resend accounts                                                          | ⬜ needs E17/E18 |
| Storing requests (`credential_requests`) and saving board moves                                        | ⬜ not briefed   |
| Claim tokens: issuing, storing, `/claim/{token}` page and QR                                           | ⬜ not briefed   |
| Reconciling dispatches left `sending` after a crash                                                    | ⬜ before launch |

### Foundation already built (before the phase plan)

Available to every phase; verified in sessions 1–2:

- PDF generation engine (multi-page, Indian scripts, images, QR, separate/merged output) and its
  Web Worker; developer playground.
- SSRF-safe image proxy (`/api/proxy-image`).
- Template schema and validation.
- Dockerfile for Cloud Run (written, not yet built).

## 4. What is needed from the executive

### Decided (2026-11-12)

| #      | Decision                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| E1, E2 | **No live GCP/Firebase or billing for now.** Develop against the local Firebase emulators with placeholder `.env.local` values. |
| E7, E8 | Mock CSVs and a blank Canva template will be provided at the data-intake phase.                                                 |
| E10    | **Approved: ADR-015** — Google access only via `drive.file` + Google Picker (no security assessment).                           |
| E11    | Target device: a **mid-range Android phone**. Largest batch: **2,500 rows**.                                                    |

### Still open

| #   | Item                                                                                                        | Needed when                    |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------------ |
| P   | Briefs for Phases 6–9                                                                                       | Before each phase              |
| E17 | Meta WhatsApp Business: verified business, sender number, approved Utility template (4 parameters, ADR-024) | Before real WhatsApp dispatch  |
| E18 | Resend account with a verified sending domain and the sender address                                        | Before real email dispatch     |
| E3  | Region — recommended **asia-south1 (Mumbai)**; Firestore's region is permanent                              | When a live project is created |
| E4  | Deployment access (you run commands, or a deploy service account / GitHub Actions)                          | When going live                |
| E5  | Product name and domain                                                                                     | OAuth consent screen, launch   |
| E6  | Super Admin email(s) for the live project (an emulator account is used until then)                          | When going live                |
| E9  | How customers store photos today (sheet links, Google Form uploads, a folder)                               | Data-intake phase              |
| E12 | Pricing: tiers and what each includes                                                                       | Billing phase                  |
| E13 | Razorpay account (KYC complete), test keys first                                                            | Billing phase                  |
| E14 | Business details for GST invoices                                                                           | Billing phase                  |
| E15 | Privacy policy and terms, incl. children's data (DPDP Act)                                                  | Before launch                  |
| E16 | Support email and logo                                                                                      | Before launch                  |

## 5. Suggested improvements (backlog)

Ideas beyond the brief, ordered by expected value. None is committed until promoted to a
phase.

### High value

| #   | Idea                                                                                                                                        | Why it matters                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| B1  | **Shrink photos in the browser before embedding** (to ~300 DPI for their box)                                                               | A 5 MB phone photo in a 1-inch box makes a 5 MB card. Cuts file sizes 10–50×, speeds export |
| B2  | **Verification QR + hosted verification page** — each document gets an ID; scanning the QR opens our page confirming it is genuine          | Fights fake certificates; a paid feature that cannot be bypassed in the browser             |
| B3  | **Card sheets (N-up imposition)** — e.g. 10 ID cards per A4 with crop marks, front/back aligned for duplex printing; CR80 and other presets | This is how ID cards are actually printed                                                   |
| B4  | **Photos from a folder or ZIP**, matched by file name to a column (roll number)                                                             | How most schools actually keep photos                                                       |
| B5  | **Pre-flight report** before generating: missing columns, empty required cells, broken photo links, text that will not fit                  | Prevents discovering problems on page 400                                                   |
| B6  | **Send to recipients** by email and WhatsApp                                                                                                | Distribution is the next chore after generation; WhatsApp is the channel in India           |
| B7  | **Upload an image as a template** (PNG/JPG from Canva), converted to PDF on upload                                                          | Many customers do not have a PDF                                                            |
| B8  | **Curated font library** — Noto families for every Indian script plus popular certificate faces, tested with our engine                     | Regional languages work out of the box                                                      |

### Medium value

| #   | Idea                                                                                              |
| --- | ------------------------------------------------------------------------------------------------- |
| B9  | Computed columns: totals, percentage, grade, rank, serial numbers, Indian number and date formats |
| B10 | Conditional placeholders (show "Distinction" only above 75%)                                      |
| B11 | Table placeholder for a variable number of rows (subject-wise marks)                              |
| B12 | Barcode placeholder (Code 128) for library and ID cards                                           |
| B13 | Resumable batches (survive a closed tab) using on-device storage                                  |
| B14 | Template gallery with ready-made designs                                                          |
| B15 | Fill existing PDF form fields by name (for government-style forms)                                |
| B16 | Installable app (PWA) with offline generation                                                     |
| B17 | Workspaces: several staff members of one institution sharing templates, with roles                |
| B18 | Interface in Hindi and other languages                                                            |
| B19 | Try a direct browser fetch before using the proxy, to cut proxy traffic for hosts that allow it   |
| B20 | HarfBuzz shaping engine, if any script shows errors with the current shaper (see ADR-007)         |
| B21 | Right-to-left scripts (Urdu)                                                                      |
| B22 | DigiLocker / Academic Bank of Credits integration for issuing verifiable academic documents       |

### Platform hygiene (to schedule inside phases)

| #   | Idea                                                                   |
| --- | ---------------------------------------------------------------------- |
| B23 | Per-user rate limits and tier quotas on the image proxy                |
| B24 | Firebase App Check on API routes                                       |
| B25 | Error monitoring (Sentry or Cloud Error Reporting) and structured logs |
| B26 | Content-Security-Policy and other security headers for the app         |
| B27 | Automated visual regression tests of the engine's output in CI         |

## 6. Risks and open questions

| #   | Risk / question                                                                                  | Current position                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Indian-script rendering quality.** pdf-lib's own text drawing is wrong for several cases.      | Addressed by our own text drawing (ADR-007). Needs validation on real customer text in every launch language (E8).                                                                                                                                  |
| R2  | **Memory on low-end phones** for large batches or large photos.                                  | Engine streams files out one by one and can split merged output. B1 (photo shrinking) is the main remaining lever. Target set: mid-range Android, 2,500 rows (E11). Merged output must use `rowsPerFile` splitting at that size; to be load-tested. |
| R3  | **Limits enforced in the browser can be bypassed.**                                              | Tie paid value to server-side features (proxy quotas, verification pages, export). Decide with pricing (E12).                                                                                                                                       |
| R4  | **Google OAuth verification** is slow and has requirements (domain, privacy policy, demo video). | Least-privileged scope approved (ADR-015, `drive.file` + Picker): no security assessment; basic verification still needed before launch.                                                                                                            |
| R5  | **Private photos in Google Drive** (Google Form uploads) are not reachable by the proxy.         | Plan: user picks them with Google Picker and the browser reads them with the user's own access. To be designed in the data-intake phase (E9).                                                                                                       |
| R6  | **pdf-lib is unmaintained.**                                                                     | Pinned and isolated (ADR-006). A maintained, compatible fork exists.                                                                                                                                                                                |
| R7  | **Children's personal data** (DPDP Act): consent, retention, breach duties.                      | Architecture stores no recipient data on our servers. Legal review still needed (E15).                                                                                                                                                              |
| R8  | **Encrypted or unusual template PDFs** cannot be opened.                                         | Rejected with a clear message. Measure how often it happens.                                                                                                                                                                                        |
| R9  | **Proxy cost and abuse.**                                                                        | Authenticated only; limits on size and time. Rate limiting and quotas come with tiers (B23).                                                                                                                                                        |
| Q3  | Should issuing a credential always spend institution credits?                                    | If yes, issuance must move to a server route that debits credits in a transaction, and browser writes to `vault_items` be closed (ADR-018). Needed before the billing phase.                                                                        |
| Q4  | Should institution staff and admins also issue credentials personally (Micro-Issuer workspace)?  | Today every signed-in person sees both workspaces (ADR-023). Decide with the institution phase.                                                                                                                                                     |
| Q5  | Price of a dispatched message (credits per WhatsApp / email)? Placeholder: 1 credit each.        | Decide with pricing (E12). WhatsApp Utility messages cost the business money per message in India.                                                                                                                                                  |
| Q6  | Should Micro-Issuers (no institution, no credits) be able to dispatch?                           | Today only institution admins and staff can (ADR-024).                                                                                                                                                                                              |
| Q1  | Should free-tier documents carry a watermark?                                                    | Open — pricing decision (E12).                                                                                                                                                                                                                      |
| Q2  | Is a desktop-first power-user mode needed alongside mobile-first?                                | Open — depends on who the first customers are.                                                                                                                                                                                                      |

## 7. How we work

- Every working session ends with: updated status in this file, an entry in
  [DEVLOG.md](./DEVLOG.md), any new decision in [DECISIONS.md](./DECISIONS.md), and commits pushed.
- Nothing is called done until it has been run and checked; the dev log says how each item was
  verified.
- Decisions that cost money, affect customers' data, or are hard to undo are brought to the
  executive as a recommendation with the trade-off, not decided silently.
