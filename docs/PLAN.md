# Project Plan

The single place to see what we are building, where we are, what comes next, and what is waiting
on a decision. Updated at the end of every working session.

**Last updated:** 2026-11-12 (end of session 2)

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

## 3. Roadmap

Status key: ✅ done and verified · 🟡 in progress · ⬜ not started

| #   | Milestone                 | What it delivers                                                                                                                                                           | Status                                   |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| M0  | **PDF engine foundation** | Template schema, image proxy, generation engine, Web Worker, developer playground, Cloud Run container                                                                     | ✅ (Docker image still to be built once) |
| M1  | **Platform**              | Firebase project wiring, Google Sign-In, Firestore data model and security rules, Cloud Storage, app shell (navigation, themes), CI/CD to Cloud Run                        | 🟡 RBAC done (V6 Phase 1)                |
| M2  | **Template editor**       | Upload a PDF or image as a template, render pages, Tap-to-Place, properties panel, font picker, live preview from the real engine                                          | ⬜                                       |
| M3  | **Data intake**           | Google Sheets via Picker, CSV/Excel upload, column mapping, pre-flight checks (missing columns, empty cells, unreachable photos), photos from links / Drive / local folder | ⬜                                       |
| M4  | **Generate and deliver**  | Batch run screen (progress, cancel, per-row report), ZIP download, export to Drive, merged print file                                                                      | ⬜                                       |
| M5  | **Billing and tiers**     | Razorpay checkout and webhooks, tier limits, GST invoices                                                                                                                  | ⬜                                       |
| M6  | **Super Admin**           | Custom-claims roles, user and tier management, usage and revenue metrics                                                                                                   | ⬜                                       |
| M7  | **Hardening and launch**  | Google OAuth verification, security review, monitoring, low-end Android testing, privacy policy and terms                                                                  | ⬜                                       |

Suggested order after M0: **M1 → M2 → M3 → M4** gives a usable product end to end (free, no
billing). M5–M7 turn it into a business. Google's OAuth verification (part of M7) takes weeks and
needs a domain and a privacy policy, so the paperwork should start during M2.

### M0 in detail (current)

| Item                                                                       | Status                |
| -------------------------------------------------------------------------- | --------------------- |
| Project scaffold, tooling, test setup                                      | ✅                    |
| Template schema: interfaces, runtime validation, data bindings             | ✅                    |
| `/api/proxy-image`: SSRF-safe image relay with auth                        | ✅                    |
| Engine maths: page geometry (rotation, crop), text layout, image fitting   | ✅                    |
| Engine fonts and text drawing (Indic shaping, kerning)                     | ✅                    |
| Engine images (JPG/PNG, EXIF orientation, cover/contain) and QR codes      | ✅                    |
| Engine orchestration: separate and merged output, progress, cancel, report | ✅                    |
| Web Worker wrapper (comlink) and developer playground                      | ✅                    |
| Dockerfile for Cloud Run                                                   | 🟡 written, not built |

### V6 Phase 1 — Foundation & RBAC (session 2)

| Item                                                                                         | Status |
| -------------------------------------------------------------------------------------------- | ------ |
| Role and record types (`UserRole`, institution, vault item)                                  | ✅     |
| Custom-claims management with institution directory sync and session revocation              | ✅     |
| Session cookies (`/api/auth/session`), server-side guards                                    | ✅     |
| Route protection proxy for `/admin`, `/dashboard/institution`, `/dashboard/vault`, `/editor` | ✅     |
| Firestore rules for institutions, templates, vault items                                     | ✅     |
| `/login` page (Google Sign-In UI) — needs the Firebase web config (E2)                       | ⬜     |
| Granting the first super admin on the real project (E6)                                      | ⬜     |

## 4. What is needed from the executive

Nothing below blocks M0. Items are grouped by the milestone that first needs them.

### Needed to start M1 (platform)

| #   | Item                                                                                                                      | Why                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| E1  | A Google Cloud project with billing enabled, and its project ID                                                           | Everything runs in it                                       |
| E2  | A Firebase project attached to it; Google Sign-In enabled; the web app config (public keys)                               | Login and database                                          |
| E3  | Region choice — recommended **asia-south1 (Mumbai)** for Cloud Run, Firestore and Storage                                 | Latency and data residency; Firestore's region is permanent |
| E4  | A way for us to deploy: either you run the commands we provide, or grant a deploy service account / GitHub Actions access | CI/CD                                                       |
| E5  | Product name and a domain name                                                                                            | Branding, OAuth consent screen, verification                |
| E6  | The email address(es) that should be Super Admin                                                                          | First custom claim                                          |

### Needed during M2–M3 (editor, data)

| #   | Item                                                                                                                             | Why                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| E7  | 3–5 real, anonymised samples: a certificate, a report card, an ID card (front and back), each with the spreadsheet that fills it | Acceptance tests against reality           |
| E8  | At least one sample in a regional language, and the list of languages to support at launch (Hindi, Marathi, Tamil, …)            | Font library and shaping tests             |
| E9  | How your customers store photos today: links in the sheet, Google Form uploads to Drive, or a folder on a computer               | Decides which photo source to build first  |
| E10 | Decision on ADR-015: accept "pick your files" (`drive.file` + Picker) instead of broad Drive access                              | Avoids a costly Google security assessment |
| E11 | Target device floor — e.g. "must work on a ₹8,000 Android phone with 3 GB RAM" — and the largest batch you expect (500? 5,000?)  | Sets memory budgets and chunk sizes        |

### Needed before M5–M7 (business)

| #   | Item                                                                                                    | Why                                       |
| --- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| E12 | Pricing: tiers, what each includes (documents per month, watermark, custom fonts, Drive export), prices | Tier engine and admin dashboard           |
| E13 | A Razorpay account (KYC complete); test keys first                                                      | Payments                                  |
| E14 | Business details for invoices: legal name, GSTIN, address                                               | GST-compliant invoices                    |
| E15 | Privacy policy and terms of service, including how children's data is handled (DPDP Act)                | Required by Google and by law             |
| E16 | Support email and logo                                                                                  | OAuth consent screen, transactional email |

## 5. Suggested improvements (backlog)

Ideas beyond the brief, ordered by expected value. None is committed until promoted to a
milestone.

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

### Platform hygiene (to schedule inside milestones)

| #   | Idea                                                                   |
| --- | ---------------------------------------------------------------------- |
| B23 | Per-user rate limits and tier quotas on the image proxy                |
| B24 | Firebase App Check on API routes                                       |
| B25 | Error monitoring (Sentry or Cloud Error Reporting) and structured logs |
| B26 | Content-Security-Policy and other security headers for the app         |
| B27 | Automated visual regression tests of the engine's output in CI         |

## 6. Risks and open questions

| #   | Risk / question                                                                                  | Current position                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Indian-script rendering quality.** pdf-lib's own text drawing is wrong for several cases.      | Addressed by our own text drawing (ADR-007). Needs validation on real customer text in every launch language (E8).                                                      |
| R2  | **Memory on low-end phones** for large batches or large photos.                                  | Engine streams files out one by one and can split merged output. B1 (photo shrinking) is the main remaining lever. Needs device testing (E11).                          |
| R3  | **Limits enforced in the browser can be bypassed.**                                              | Tie paid value to server-side features (proxy quotas, verification pages, export). Decide with pricing (E12).                                                           |
| R4  | **Google OAuth verification** is slow and has requirements (domain, privacy policy, demo video). | Use the least-privileged scope (ADR-015); start paperwork early.                                                                                                        |
| R5  | **Private photos in Google Drive** (Google Form uploads) are not reachable by the proxy.         | Plan: user picks them with Google Picker and the browser reads them with the user's own access. To be designed in M3 (E9).                                              |
| R6  | **pdf-lib is unmaintained.**                                                                     | Pinned and isolated (ADR-006). A maintained, compatible fork exists.                                                                                                    |
| R7  | **Children's personal data** (DPDP Act): consent, retention, breach duties.                      | Architecture stores no recipient data on our servers. Legal review still needed (E15).                                                                                  |
| R8  | **Encrypted or unusual template PDFs** cannot be opened.                                         | Rejected with a clear message. Measure how often it happens.                                                                                                            |
| R9  | **Proxy cost and abuse.**                                                                        | Authenticated only; limits on size and time. Rate limiting and quotas come with tiers (B23).                                                                            |
| Q3  | Should issuing a credential always spend institution credits?                                    | If yes, issuance must move to a server route that debits credits in a transaction, and browser writes to `vault_items` be closed (ADR-018). Needed before billing (M5). |
| Q1  | Should free-tier documents carry a watermark?                                                    | Open — pricing decision (E12).                                                                                                                                          |
| Q2  | Is a desktop-first power-user mode needed alongside mobile-first?                                | Open — depends on who the first customers are.                                                                                                                          |

## 7. How we work

- Every working session ends with: updated status in this file, an entry in
  [DEVLOG.md](./DEVLOG.md), any new decision in [DECISIONS.md](./DECISIONS.md), and commits pushed.
- Nothing is called done until it has been run and checked; the dev log says how each item was
  verified.
- Decisions that cost money, affect customers' data, or are hard to undo are brought to the
  executive as a recommendation with the trade-off, not decided silently.
