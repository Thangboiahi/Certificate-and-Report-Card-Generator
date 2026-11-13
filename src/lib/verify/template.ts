/**
 * Template helpers for verification QR codes (ADR-035). Pure: no network, no browser.
 */
import type {
  DataRow,
  Placeholder,
  QrPlaceholder,
  TemplateDefinition,
  TemplatePage,
} from '@/lib/template';

import { VERIFY_ID_COLUMN, VERIFY_QR_TEMPLATE, VERIFY_URL_COLUMN } from './ids';

const VERIFY_COLUMNS = [VERIFY_URL_COLUMN, VERIFY_ID_COLUMN];

/** Does any field read the verification id or address? Then rows need ids before generation. */
export function usesVerification(placeholders: readonly Placeholder[]): boolean {
  return placeholders.some(({ binding }) => {
    if (binding.kind === 'column') return VERIFY_COLUMNS.includes(binding.column);
    if (binding.kind === 'template') {
      return VERIFY_COLUMNS.some((column) => binding.template.includes(`{{${column}}}`));
    }
    return false;
  });
}

const QR_SIZE = 90;
const MARGIN = 28;

/** A QR code that prints the verification address, bottom-right of the first page. */
export function verificationQr(page: TemplatePage, takenIds: ReadonlySet<string>): QrPlaceholder {
  let id = 'verification-qr';
  for (let n = 2; takenIds.has(id); n++) id = `verification-qr-${n}`;
  return {
    id,
    type: 'qr',
    label: 'Verification QR',
    pageIndex: 0,
    box: {
      x: Math.max(0, page.width - QR_SIZE - MARGIN),
      y: Math.max(0, page.height - QR_SIZE - MARGIN),
      width: QR_SIZE,
      height: QR_SIZE,
    },
    binding: { kind: 'template', template: VERIFY_QR_TEMPLATE },
    errorCorrection: 'M',
    foreground: '#000000',
    quietZone: 4,
  };
}

/** Adds a verification QR unless the template already has one. */
export function withVerificationQr(template: TemplateDefinition): TemplateDefinition {
  const page = template.pages[0];
  if (!page || usesVerification(template.placeholders)) return template;
  return {
    ...template,
    placeholders: [
      ...template.placeholders,
      verificationQr(page, new Set(template.placeholders.map((p) => p.id))),
    ],
  };
}

/** Sample values for a test PDF, so the QR is drawn (it will not verify). */
export function sampleVerificationRow(origin: string): DataRow {
  return {
    [VERIFY_ID_COLUMN]: 'TEST-ONLY',
    [VERIFY_URL_COLUMN]: new URL('/verify/test-only', origin).toString(),
  };
}
