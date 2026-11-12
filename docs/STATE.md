# State

**Updated:** 2026-11-12 (session 23, Phase 14) · **Branch:** `claude/global-app-shell-state-f72bd1`

## Current phase

**Phase 14 (QR Pre-Minting & Containerisation): BUILT** (2026-11-12, ADR-035). Verification ids are now minted before generation: the editor's new
"Add verification QR" and "Generate all (ZIP)" ask `/api/verify/mint` for one 256-bit id per row (stored as `unclaimed` stubs), the QR on each PDF
prints `/verify/{id}`, and scanning it before the holder claims shows "Issued, not yet claimed". Dispatch can carry the id into the claim link, so
claiming keeps the printed id. Razorpay: the key already reaches the browser from the server (`RAZORPAY_KEY_ID`), so `NEXT_PUBLIC_RAZORPAY_KEY_ID` was
**not** added (see ADR-035); the pay screen now shows "Test mode" for `rzp_test_` keys; the cart maths was already correct and tested. Docker:
`output: 'standalone'`, the `Dockerfile` and `.dockerignore` already existed and were kept and hardened (`.claude` excluded, build cache mount, run-time
variables documented). Verified: typecheck, lint, 598 unit tests, 85 emulator tests (including new stub, dispatch-link and claim-adoption tests),
a production build served against the emulators and driven in a browser (3 rows -> 3 ids -> ZIP of 3 PDFs; a second run mints nothing; a signed-out
visitor sees "Issued, not yet claimed"), and the standalone server run exactly as the image's last stage lays it out (47 MB). **Not verified: the Docker
image itself (no Docker here), that a scanner decodes the QR on a PDF, `scripts/e2e-*.mjs`, a real Razorpay test payment, anything on the live project.**
Open: a mint quota; revoking unclaimed stubs has no screen; guests cannot mint; prices (E12). Phase 13 and 12 notes below still apply.

**Phase 13 (Public-Facing Architecture): BUILT** (2026-11-12, ADR-034). The homepage `/` is a responsive marketing page with calls to action to
`/login` and `/editor`. `/verify/{id}` is the public verification portal: green "Verified" with issuer, recipient, issue date and a
certificate preview; red "INVALID / REVOKED" (contact the issuer); amber "EXPIRED"; and "Add to LinkedIn profile" on valid ones only.
`{id}` is the unguessable **share id**, not the Firestore document id (that would expose credentials their owners never shared); `/v/{id}`
redirects. Verified against the emulators with a production build and a signed-out browser: all four states, document ids not resolving,
the old link redirecting, the LinkedIn URL's parameters, and the homepage on desktop and a 375 px phone. Unit tests: 577. Not verified: the
LinkedIn page itself (we only checked the URL we open), `scripts/e2e-vault.mjs` (updated, not run: no Playwright here), anything against the live
project. Open: the homepage shows no prices (PLAN E12); QR codes printed at generation time cannot point at `/verify` yet (the share id
does not exist until a recipient claims). Phase 12 (live Kanban and Vault) remains BUILT, with its live index still to build.

**Phase 12 (Dashboard Live Wiring & Vault): BUILT** (2026-11-12, ADR-033). The Kanban reads and writes Firestore
(`credential_requests`, server-only) through `/api/requests`, with no sample data left; the vault shows real `vault_items`; a missing
index now shows an alert with the exact Firebase Console link; both have empty states. Verified against the Auth and Firestore
emulators with a production build: typecheck, lint, 570 unit tests, 78 emulator tests, and a real signed-in browser session (board scoped to
the institution, move saved and still there after reload, add-request form, refresh picks up outside changes, empty states, vault
data, and the Phase 11 header on real `/dashboard` pages). Not verified: a mouse drag in the browser pane (synthetic events would not
complete a cross-column drop; `scripts/e2e-dispatch.mjs` now seeds real cards and checks persistence but was not run, no Playwright
here); the index alert against a real Firestore index failure (the emulator does not enforce indexes; covered by tests with the real
message format); anything against the live Firebase project. **Still manual:** build the `vault_items` index in the live project
(deploy `firebase/firestore.indexes.json`, or click the link the vault page now shows) and re-check. Phase 11 is COMPLETE (ADR-032).

**FROZEN: cloud development is paused (2026-11-12) and the project is moving to a local desktop environment.** Do not
continue in the cloud session. The mandatory usability fixes to do first once the local environment boots (logout/nav
header, editor upload gateway, live Kanban data, Vault indexes and real data) are in `docs/LOCAL_TODO.md`. The Phase 10
status below still stands.

**Awaiting the Human Product Owner (session 19):** the `/login` smoke test passed (HTTP 200, form rendered, config read from
the shell environment, see `docs/DEVLOG.md`). The next step is a manual email-link click-test to verify session minting
(sign in with a real email link, confirm the session cookie is set and the role redirect works). Not yet done; nothing
further runs until the results come back.

**Session 18: `/login` config now loads and the Admin SDK uses an explicit service account (ADR-031); ready for a manual click-test (real email link not yet tried).**

Earlier, attempt 2 (session 17): Auth was NOT online in the agent session. `/login` still shows "not available yet": this
container's `.env.local` is unchanged (no `FIREBASE_WEB_API_KEY`, `FIREBASE_PRIVATE_KEY` still 40 chars). The rotated values
have not reached it. Rerun once they do. See `docs/DEVLOG.md`.

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
- `src/components/vault/VaultDashboard.tsx` on `/dashboard/vault`; `/verify/[id]` (`/v/[shareId]` redirects); `POST /api/vault/share`.

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
