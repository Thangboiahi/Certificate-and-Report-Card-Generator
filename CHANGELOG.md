# Changelog

All notable changes. Newest first. Details and reasoning: `docs/DEVLOG.md`, `docs/DECISIONS.md`.

## Unreleased

### Added

- Template schema for multi-page documents with text, image and QR placeholders, runtime
  validation and data bindings.
- `/api/proxy-image`: authenticated, SSRF-safe image relay for the browser-side engine.
- PDF generation engine: Indian-script text shaping, wrapping and shrink-to-fit, images with
  cover/contain, EXIF orientation and masks, vector QR codes, rotated/cropped template pages,
  separate and merged output.
- Web Worker (comlink) with image loading, shrinking and format conversion.
- Developer playground at `/playground`, sample template, end-to-end script.
- Dockerfile for Cloud Run (not yet built).
- Project records: `docs/PLAN.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `DEVLOG.md`, `CLAUDE.md`.
