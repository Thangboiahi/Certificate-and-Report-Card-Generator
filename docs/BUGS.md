# Bugs

Active stack traces, failed attempts and their final resolutions. Newest first.
Format per entry: **Symptom** · **Trace / failed attempts** · **Resolution** (or _open_).

## Open

_None._

## Resolved

### B-001 · `/login` does not exist, so every sign-in redirect lands on a 404 (found 2026-11-12, pre-flight audit; **resolved 2026-11-12**)

**Symptom** · A signed-out visitor who opens `/dashboard/vault`, `/dashboard/issue`, `/dashboard/institution` or
`/admin` is redirected (307) to `/login?next=…`, which returns 404. Not a redirect loop: `/login` has no
rule in `ROUTE_RULES`, so it is public and the redirect chain ends there. The same redirect comes from
`requireRouteAccess` in `src/lib/auth/session.ts`.

**Trace** · Smoke test on the production build (`node .next/standalone/server.js`): `GET /dashboard/vault` →
`307 /login?next=%2Fdashboard%2Fvault`; `GET /login` → `404`. `/claim/{token}`, `/v/{shareId}`, `/editor` → 200.
Already listed as an open gap in `STATE.md` and `PLAN.md` (Phase 1).

**Resolution** · **Resolved (session 14).** `src/app/login/page.tsx` now exists. It is public (no `ROUTE_RULES` entry,
so no redirect loop) and renders `PasswordlessSignIn` (email link or SMS code) through `LoginForm`. After sign-in the session
cookie is set by the existing `/api/auth/session` and the page is reloaded; the server component then reads the verified
session and redirects with `postLoginPath` (`inst_admin`/`inst_staff` → `/dashboard/institution`, `individual` →
`/dashboard/vault`, `super_admin` → `/admin`; a `?next=` the person may open wins; unsafe or forbidden `next` and `/login`
itself are ignored). Verified: 14 new unit tests, 14 new route checks and 7 Chromium checks in `scripts/e2e-auth.mjs`
(74 checks, all ok). Not clicked through with a real email link or SMS (emulator only).

_No build errors were found in the 2026-11-12 pre-flight audit (`npm run build`, lint, typecheck and format check all
passed on the first run), so there is nothing to log here. Earlier fixes are recorded in `DEVLOG.md` session entries._
