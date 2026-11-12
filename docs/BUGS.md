# Bugs

Active stack traces, failed attempts and their final resolutions. Newest first.
Format per entry: **Symptom** · **Trace / failed attempts** · **Resolution** (or _open_).

## Open

### B-001 · `/login` does not exist, so every sign-in redirect lands on a 404 (found 2026-11-12, pre-flight audit)

**Symptom** · A signed-out visitor who opens `/dashboard/vault`, `/dashboard/issue`, `/dashboard/institution` or
`/admin` is redirected (307) to `/login?next=…`, which returns 404. Not a redirect loop: `/login` has no
rule in `ROUTE_RULES`, so it is public and the redirect chain ends there. The same redirect comes from
`requireRouteAccess` in `src/lib/auth/session.ts`.

**Trace** · Smoke test on the production build (`node .next/standalone/server.js`): `GET /dashboard/vault` →
`307 /login?next=%2Fdashboard%2Fvault`; `GET /login` → `404`. `/claim/{token}`, `/v/{shareId}`, `/editor` → 200.
Already listed as an open gap in `STATE.md` and `PLAN.md` (Phase 1).

**Resolution** · _open._ Needs the `/login` page (a feature, so out of scope for this audit). `PasswordlessSignIn` can be
reused and `safeReturnPath` already validates `?next=`. Recipients are unaffected: they sign in on the claim page.
Must exist before real users reach the dashboards.

## Resolved

_No build errors were found in the 2026-11-12 pre-flight audit (`npm run build`, lint, typecheck and format check all
passed on the first run), so there is nothing to log here. Earlier fixes are recorded in `DEVLOG.md` session entries._
