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

# Local Development Master Plan: UI Polish & Live Integration

## Phase 11: Global App Shell & State Cleanup
*The backend is built, but the frontend is currently locked in testing states. This phase strips dummy data and implements global navigation.*

1. **Global Auth Navigation:** Build a global layout shell (`app/dashboard/layout.tsx`). Include a top navigation bar with a User Profile dropdown (`shadcn/ui` Avatar). Add a functional "Logout" button that calls Firebase `signOut()`, clears the Next.js session cookie, and routes to `/login`.
2. **Editor Upload Gateway:** The `/editor` route is stuck rendering the "Sample certificate". Update `store/templateStore.ts` to initialize `activeTemplate` as `null`. Wire the main `/editor` page to render `UniversalUploadZone.tsx` when empty, so users can upload a fresh PDF/PNG template or CSV. 
3. **Global Error Handling:** Implement a global toast notification system (`shadcn/ui` Toaster) to catch and display backend errors gracefully (e.g., Gemini AI failures, Firebase permission denials) rather than crashing the UI components.

## Phase 12: Live Data Wiring & Database Indexes
*Replacing static UI elements with active Firestore listeners.*

1. **Dashboard Kanban Wiring:** The Institutional Dashboard currently displays static "Sample requests". Wire the `@hello-pangea/dnd` Kanban board to read from and write to the live Firestore `issued_credentials` and `requests` collections based on our established `UserRole` schemas.
2. **Firestore Composite Indexes:** The Digital Vault is failing to load due to `FAILED_PRECONDITION` index errors. Extract the exact index creation links from the local terminal logs, click them to build the composite indexes in the Firebase Console, and wire the Vault UI to map and render real `VaultItemSchema` data.
3. **Empty States:** Build clean, branded "Empty State" illustrations for the Kanban board and the Vault for when a new user logs in and has no data yet.

## Phase 13: Public-Facing Architecture
*Building the pages that unauthenticated users interact with.*

1. **The Public Verification Page:** Build `app/verify/[id]/page.tsx`. When a QR code is scanned, this page queries Firestore to ensure the credential is valid (not revoked), verifies the SHA-256 hash, and displays a high-res preview of the certificate with the issuing institution's logo. Include a "1-Click Add to LinkedIn" button.
2. **The Marketing Landing Page:** Build `app/page.tsx`. This is the public homepage. Implement a Hero section ("Issue Verifiable Credentials in Seconds"), a pricing breakdown, and clear Call-to-Action buttons routing to `/login` or `/editor` (for guest access).

## Phase 14: Pre-Launch & DevOps
*Final checks before live deployment.*

1. **Razorpay Test Mode Run:** Execute a complete end-to-end checkout using Razorpay's test UPI credentials to verify the Route/Escrow split functions perfectly for Institutional documents.
2. **Dockerization:** Create the final `Dockerfile` and `.dockerignore` optimized for Next.js standalone output. 
3. **Google Cloud Run Deployment:** Push the container to Google Artifact Registry and deploy to Cloud Run, injecting the live production `.env` variables securely into the Cloud Run dashboard.
