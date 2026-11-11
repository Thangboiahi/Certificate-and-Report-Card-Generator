# Guide for coding agents working on this repository

@AGENTS.md

## What this project is

A bulk document generator (certificates, report cards, ID cards, letters) for the Indian B2B and
education market. PDFs are generated **in the browser** by a Web Worker running pdf-lib; the
server is a thin Next.js 16 app on Cloud Run. The project owner is referred to as "the
executive"; they are not a developer.

## Read these before changing anything

1. `docs/PLAN.md` — scope, roadmap, current status, open questions, what is needed from the
   executive.
2. The latest entry in `docs/DEVLOG.md` — where the last session stopped.
3. `docs/DECISIONS.md` — why things are built the way they are. Check it before proposing a
   different approach; many alternatives were already measured and rejected.
4. `docs/ARCHITECTURE.md` — how the pieces fit together.

## Record-keeping protocol (mandatory)

These documents are the project's memory across sessions. The executive asked for them
explicitly. In every session that changes the project:

- **A significant technical decision** (new dependency, changed approach, trade-off accepted) →
  add an ADR to `docs/DECISIONS.md`. Never delete or rewrite an old ADR; mark it
  `Superseded by ADR-0NN`.
- **Scope, roadmap or status changed** → update `docs/PLAN.md` (status tables, backlog, risks,
  the "needed from the executive" list).
- **The system works differently** → update `docs/ARCHITECTURE.md`.
- **Before finishing** → add a dated entry at the top of `docs/DEVLOG.md`: what was built, what
  was learned, how it was verified (commands, numbers), what is still open. Update
  `CHANGELOG.md` under "Unreleased".
- Commit in logical steps with messages that explain why, and push.

Say plainly what was verified and what was not. Do not mark roadmap items done without running
them.

## Commands

| Command                           | What it does                                                      |
| --------------------------------- | ----------------------------------------------------------------- |
| `npm run dev`                     | Dev server on http://localhost:3000 (playground at `/playground`) |
| `npm test`                        | Unit tests (Vitest, Node environment)                             |
| `npm run typecheck`               | `next typegen` + `tsc --noEmit`                                   |
| `npm run lint`                    | ESLint                                                            |
| `npm run format`                  | Prettier                                                          |
| `npm run verify`                  | Everything above plus a production build — run before pushing     |
| `node scripts/e2e-playground.mjs` | Drives the playground in Chromium: Worker + proxy end to end      |

## Rules of the codebase

- **Only `src/lib/pdf-engine/` imports `pdf-lib` or `@pdf-lib/fontkit`.** Both are pinned to exact
  versions because the engine relies on a few of their internals (ADR-006, ADR-008). Do not bump
  them casually; `src/lib/pdf-engine/fonts.test.ts` guards the assumptions.
- **The engine stays environment-agnostic** — no `fetch`, DOM, Worker or Node APIs inside
  `src/lib/pdf-engine`. Network and storage are injected (ADR-013).
- **Template schema changes** (`src/lib/template/types.ts`): additive optional fields only,
  otherwise bump `TEMPLATE_SCHEMA_VERSION` and write a migration (ADR-003). Keep `schema.ts` in
  step — the compiler enforces it.
- **Never loosen the image proxy's checks** (`src/lib/image-proxy/ssrf.ts`, `safe-fetch.ts`)
  without a test that proves the new behaviour is safe (ADR-005).
- **Text rendering changes must be checked visually** for Indian scripts against a browser
  rendering of the same font (ADR-007). `tests/output/` holds the rendered pages after a test run.
- Next.js 16 specifics: no `runtime` / `dynamic` / `revalidate` exports; API routes that must run
  per request start with `await connection()` (ADR-002).
- Geometry is always in PDF points from the top-left of the displayed page (ADR-003).

## Environment notes

- Node 22.12+ locally; the container image uses the current LTS.
- Docker may be unavailable in cloud sandboxes; the production build can still be checked with
  `npm run build && node .next/standalone/server.js`.
- Chromium and Playwright are preinstalled in cloud sessions (used by the e2e script).
