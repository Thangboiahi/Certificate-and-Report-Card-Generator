# State

**Updated:** 2026-11-12 (session 10) · **Branch:** `ccr-23292c99-dwsyq6`

## Current phase

Phase 8 — Escrow Payment Engine: **built and verified against a mock of Razorpay** (ADR-028).
Phase 7 — Passwordless Claiming & The Vault: **still open** (items below).

## Active blockers

- No Razorpay account yet (E13): nothing has run against Razorpay's test mode.

## Next immediate task

Finish Phase 7, then wait for the Phase 9 brief:

- `components/vault/VaultDashboard.tsx`, vault page wiring, public `/v/[shareId]` page, `/login`.
- `ownerUid + issuedAt` composite index (vault listing).
- `scripts/e2e-claim.mjs`: email-link and phone-OTP sign-in in the browser (the Phase 8 e2e
  creates verified accounts directly and does not exercise them).

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
