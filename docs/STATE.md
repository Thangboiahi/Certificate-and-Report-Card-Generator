# State

**Updated:** 2026-11-12 (session 11) · **Branch:** `ccr-23292c99-dwsyq6`

## Current phase

Phase 9 — **awaiting the brief** (the AI add-on is already sold at checkout but not fulfilled).
Phase 7 — Passwordless Claiming & The Vault: **complete** (vault dashboard, share page, index).
Phase 8 — Escrow Payment Engine: complete, verified against a mock of Razorpay (ADR-028).

## Active blockers

- No Razorpay account yet (E13): nothing has run against Razorpay's test mode.

## Next immediate task

Wait for the Phase 9 brief. Small gaps carried over from Phase 7 (not blocking):

- `/login` page: the proxy redirects signed-out visitors to `/login?next=…`, which does not exist
  yet (the claim page has its own sign-in). `PasswordlessSignIn` can be reused.
- `scripts/e2e-claim.mjs`: email-link and phone-OTP sign-in in the browser. The e2e scripts create
  verified accounts directly, so the sign-in UI is unit/emulator-tested only, never clicked through.

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

E13 Razorpay keys + Route · E19 Linked Account onboarding · E17 Meta WhatsApp · E18 Resend domain
· Q4–Q9 (see `PLAN.md`; Q8 = platform fee / AI add-on price / escrow hold).
