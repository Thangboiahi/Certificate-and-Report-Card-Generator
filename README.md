# Bulk Document Generator

Certificates, report cards, ID cards and letters for everyone on a list: one template and one
spreadsheet in, hundreds of filled PDFs out, generated in the browser. Built for the Indian
education and B2B market (Indian scripts, photos, QR verification).

**Status:** milestone M0 (engine foundation) complete; the product around it (sign-in, editor,
data intake, billing, admin) is next. See [docs/PLAN.md](docs/PLAN.md).

## Try it

```bash
npm install
npm run dev          # http://localhost:3000/playground
```

For the image proxy locally, create `.env.local` with `IMAGE_PROXY_ALLOW_ANONYMOUS=true`
(ignored on Cloud Run).

## Commands

| Command                                | Purpose                                          |
| -------------------------------------- | ------------------------------------------------ |
| `npm test`                             | Unit and integration tests                       |
| `npm run verify`                       | Format, lint, types, tests, production build     |
| `node scripts/e2e-playground.mjs`      | Browser end-to-end check (after `npm run build`) |
| `docker build -t document-generator .` | Cloud Run image (see DEVLOG: not yet verified)   |

## Documentation

- [docs/PLAN.md](docs/PLAN.md) — scope, roadmap, what is needed from the owner, ideas
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how it works
- [docs/DECISIONS.md](docs/DECISIONS.md) — why
- [docs/DEVLOG.md](docs/DEVLOG.md) — history
- [CLAUDE.md](CLAUDE.md) — instructions for coding agents
