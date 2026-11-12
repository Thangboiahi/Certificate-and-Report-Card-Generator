# Local TODO — fixes to execute once the local environment is booted

Written 2026-11-12 when cloud development was frozen (see `docs/STATE.md`). These are the mandatory
usability fixes found during the Phase 10 smoke test. Nothing here has been started. Follow the
record-keeping protocol in `CLAUDE.md` (ADR for decisions, DEVLOG/CHANGELOG entries, tests).

Notes in *italics* are what a quick look at the code found while writing this list. They are
unverified leads, not conclusions: confirm them first.

## 1. Global auth navigation (logout)

The app has no logout option.

- Build a global navigation header with a User Profile dropdown and a working **Sign out** button.
- Sign out must call Firebase `signOut()`, clear the server session cookie, and route to `/login`.
- *`signOut` currently appears only in `src/lib/firebase.ts`; no UI uses it. Check that
  `/api/auth/session` has a way to clear the cookie (add a DELETE if not).*
- Show the header on protected pages only. Keep `ROUTE_RULES` and `requireRouteAccess` intact (ADR-017).
- Test: after sign-out a protected URL redirects to `/login`; extend `scripts/e2e-auth.mjs`.

## 2. Editor upload gateway

`/editor` is locked into a hardcoded "Sample certificate".

- `src/store/templateStore.ts`: `activeTemplate` must start as `null`.
  *The store already types it `TemplateDefinition | null` and initialises it to `null` (line ~68).
  The hardcoded title is in `src/app/editor/editor-screen.tsx` (~line 115), and something loads a
  sample into the store: find where.*
- When `activeTemplate` is `null`, render `src/components/ui/UniversalUploadZone.tsx` on the `/editor` page.
- The "< Back" button must clear the store state (reset `activeTemplate` to `null`) and return to the gateway.
- Show the real template name in the title instead of "Sample certificate".
- Geometry stays in PDF points; only the store converts (ADR-022). Update `templateStore.test.ts` and run
  `node scripts/e2e-editor.mjs` and `node scripts/e2e-uploads.mjs`.

## 3. Institution dashboard: live wiring

The Kanban board shows static dummy requests.

- Replace the dummy data in `KanbanBoard` with live Firestore collections (credential requests).
- Writes (drag between columns) must persist and respect `firebase/firestore.rules`; extend the rules
  tests with any rules change (`npm run test:emulator`).
- Any new multi-field query needs an entry in `firebase/firestore.indexes.json`.
- Check `/dashboard/issue`: its "Sample certificate and report card" text also looks hardcoded.
- Test: `scripts/e2e-dispatch.mjs` against the emulators.

## 4. Vault and database indexes

The Digital Vault fails to load.

- *`firebase/firestore.indexes.json` already declares a `vault_items` index on `ownerUid` + `issuedAt`.
  It probably was never deployed to the live project.* Deploy with
  `npx firebase deploy --only firestore:indexes --project <live project id>` and wait until the
  indexes show as Enabled in the console. Check every other composite query in the code has an entry.
- Wire `VaultDashboard` (`/dashboard/vault`) to display real `VaultItemSchema` data from `vault_items`
  and remove any placeholder items.
- Test: `scripts/e2e-vault.mjs` against the emulators, then a manual check against the live project.

## Also open from Phase 10 (not in the list above)

- Manual email-link click-test with a real email to verify session minting (the main thing waiting on the Product Owner).
- `FIREBASE_WEB_API_KEY` must be set wherever the app runs (local `.env.local`, Cloud Run env); the key
  and a full-length `FIREBASE_PRIVATE_KEY` were only in the cloud session's environment.
- Remaining keys: Razorpay (E13), Gemini (E20), Meta WhatsApp (E17), Resend (E18).
