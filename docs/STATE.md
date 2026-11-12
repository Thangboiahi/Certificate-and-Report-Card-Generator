# State

**Updated:** 2026-11-12 · **Branch:** `ccr-23292c99-dwsyq6`

## Current phase

Phase 7 — Passwordless Claiming & The Vault (in progress).

## Active blockers

- API rate-limit pause. Waiting to resume Phase 7 execution.

## Next immediate task

Finish the Firebase Auth flows (magic link / SMS OTP), the `app/claim/[token]` page and the
`VaultDashboard` UI, then verify and record them.

### Phase 7 work already on disk (typecheck and lint clean; NOT yet tested)

- `src/lib/firebase.ts`: client Auth (email link, phone OTP, session exchange).
- `src/lib/server/firebase-client-config.ts`: request-time web config.
- `src/lib/claim/`: `contact.ts`, `razorpay.ts`, `claim.ts`, `handler.ts`.
- `src/lib/server/json-route.ts`: shared same-origin/JSON/auth gate.
- `src/lib/vault/vault.ts`: list, share on/off, public lookup.
- API: `POST /api/claim`, `/api/claim/order`, `/api/vault/share`.
- UI: `components/auth/PasswordlessSignIn.tsx`, `components/claim/ClaimFlow.tsx`,
  `app/claim/[token]/page.tsx`.
- Dispatch: optional `claimFeePaise`; `SessionUser` carries `phoneNumber`, `emailVerified`.

### Phase 7 still to do

- `components/vault/VaultDashboard.tsx`, vault page wiring, public `/v/[shareId]` page, `/login`.
- `ownerUid + issuedAt` composite index; rules entry and test for `claim_orders`.
- Unit + emulator tests, `scripts/e2e-claim.mjs` (email link, OTP, fee via stubbed Razorpay).
- ADR-027 and records.

## Needed from the executive

E13 Razorpay keys · E17 Meta WhatsApp · E18 Resend domain · Q4–Q7 (see `PLAN.md`).
