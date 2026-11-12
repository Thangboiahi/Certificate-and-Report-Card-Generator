# State

**Updated:** 2026-11-12 (session 16, Phase 10 smoke test) · **Branch:** `ccr-23292c99-dwsyq6`

## Current phase

**Current Phase: Phase 10 (Live Smoke Test).** Server boots cleanly with `.env.local` (Next.js loads it), but `/login`
shows "not available yet": the app reads `FIREBASE_WEB_API_KEY`, while `.env.local` only has `NEXT_PUBLIC_FIREBASE_API_KEY`.
Also: `FIREBASE_PRIVATE_KEY`/`FIREBASE_CLIENT_EMAIL` are not read by the code (Admin SDK uses Application Default
Credentials, `src/lib/server/firebase-admin.ts`), and `FIREBASE_PRIVATE_KEY` is only 40 characters (looks truncated).
**`.env.local` is tracked in git on the remote: treat every key in it as exposed and rotate.** Details in `docs/DEVLOG.md`.

Previous status:

**Ready for Phase 10: Live API Key Injection & Production Deployment.** All 9 build phases are on disk and the
pre-flight blocker B-001 (`/login` missing) is resolved: signed-out visitors now land on a working sign-in page and are
routed by role afterwards (`inst_admin`/`inst_staff` → `/dashboard/institution`, `individual` → `/dashboard/vault`,
`super_admin` → `/admin`). "Ready" means the code needs nothing more before keys; Phase 10 itself has not started.

Phase 9 — AI Enrichment & Smart Audit: **built** (ADR-029), verified with a mocked Gemini; needs a
Gemini key (E20) and a metering decision before it goes live. The checkout's AI add-on is still off.
Phase 7 — Passwordless Claiming & The Vault: **complete** (vault dashboard, share page, index, `/login`).
Phase 8 — Escrow Payment Engine: complete, verified against a mock of Razorpay (ADR-028).

## Active blockers

- No keys yet, so nothing has run against the real services: Razorpay (E13), Gemini (E20), Meta WhatsApp (E17),
  Resend (E18), and a live Firebase project (Auth providers, authorised domain for email links, SMS).

## Next immediate task

**Phase 10 — inject live keys and deploy.** In order: Firebase project (enable Email-link and Phone providers, add the
Cloud Run domain to authorised domains, seed the first super admin) → Razorpay (E13, steps below) → Resend (E18) →
Meta WhatsApp (E17) → Gemini (E20, decide metering first, ADR-029) → deploy to Cloud Run and run the e2e checks
against it. Known small gaps, none blocking:

- Email-link and phone-OTP sign-in (on `/login` and the claim page) are unit/emulator-tested; they have never been
  clicked through with a real email or SMS. First real test belongs in Phase 10.
- `/login` offers email link and SMS code only. Google Sign-In was considered and not added (ADR-030).
- `SmartAuditCarousel`'s `onConfirm` is not yet wired to dispatch/generate.
- `scripts/e2e-claim.mjs` (sign-in UI in a browser) is not written.

### Phase 9 on disk (verified: 567 unit, `scripts/e2e-ai.mjs`)

- `src/lib/ai/{schema,gemini,handler,geminiClient}.ts`, `POST /api/ai/{enrich,audit}`.
- `src/components/canvas/{SmartAuditCarousel,AiMagicButton}.tsx`, mounted on `/editor`.
- Not run against real Gemini; unmetered (see ADR-029).

### Phase 7 on disk (verified: 544 unit, 70 emulator, 10/10 `scripts/e2e-vault.mjs`)

- `src/lib/firebase.ts`, `src/components/auth/PasswordlessSignIn.tsx`, `/claim/[token]` + `ClaimFlow`.
- `src/components/vault/VaultDashboard.tsx` on `/dashboard/vault`; `/v/[shareId]`; `POST /api/vault/share`.

### Phase 8 on disk (verified: 544 unit, 70 emulator, 52/52 `scripts/e2e-checkout.mjs`)

- `src/lib/razorpayClient.ts`, `src/lib/payments/{pricing,escrow,handler}.ts`, `src/types/payments.ts`.
- `POST|GET /api/checkout`, `POST /api/webhooks/razorpay`, `POST /api/cron/reconcile-payments`.
- Claim page cart + Checkout + polling; dispatch payout-account guard; rules and index.

### When Razorpay keys arrive (E13)

1. Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`; enable Route; create the webhook
   (`/api/webhooks/razorpay`, event `payment.captured`) and set `RAZORPAY_WEBHOOK_SECRET`.
2. Create a test Linked Account, set it as an institution's `razorpayAccountId`.
3. Pay a test claim; confirm the transfer is on hold, then a duplicate payment refunds and reverses.

## Needed from the executive

E20 Gemini key + AI pricing · E13 Razorpay keys + Route · E19 Linked Account onboarding · E17 Meta WhatsApp · E18 Resend domain
· Q4–Q9 (see `PLAN.md`; Q8 = platform fee / AI add-on price / escrow hold).
