/**
 * Runtime validation for the Template Schema.
 *
 * `types.ts` is the contract people read; this file is the same contract enforced at runtime, for
 * the moments a template crosses a trust boundary (loaded from Firestore, received by the Web
 * Worker, imported from a file). Each schema is annotated with its interface, so if the two drift
 * apart the project stops compiling.
 */
import { z } from 'zod';

import {
  TEMPLATE_SCHEMA_VERSION,
  type Box,
  type DataBinding,
  type FontSource,
  type HexColor,
  type ImagePlaceholder,
  type Placeholder,
  type QrPlaceholder,
  type TemplateDefinition,
  type TemplateFont,
  type TextPlaceholder,
} from './types';

/** Hard limits. They exist to fail fast on corrupt data, not to shape the product. */
export const TEMPLATE_LIMITS = {
  maxPages: 500,
  maxPlaceholders: 5000,
  maxFonts: 100,
  /** 200 in — far beyond any real page, close enough to catch unit mistakes (px or mm as pt). */
  maxPageSide: 14_400,
  maxFontSize: 2000,
  maxQuietZone: 16,
} as const;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const hexColor = z.custom<HexColor>(
  (value) => typeof value === 'string' && HEX_COLOR.test(value),
  'Expected a colour like #1A2B3C',
);

const id = z.string().min(1).max(128);
const finite = z.number().refine(Number.isFinite, 'Expected a finite number');
const positive = finite.refine((n) => n > 0, 'Must be greater than 0');
const unitInterval = finite.refine((n) => n >= 0 && n <= 1, 'Must be between 0 and 1');

const box = z.object({
  x: finite,
  y: finite,
  width: positive,
  height: positive,
}) satisfies z.ZodType<Box>;

const binding = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('column'), column: z.string().min(1) }),
  z.object({ kind: z.literal('template'), template: z.string() }),
  z.object({ kind: z.literal('static'), value: z.string() }),
]) satisfies z.ZodType<DataBinding>;

const fontSource = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('standard'),
    name: z.enum([
      'Helvetica',
      'Helvetica-Bold',
      'Helvetica-Oblique',
      'Helvetica-BoldOblique',
      'Times-Roman',
      'Times-Bold',
      'Times-Italic',
      'Times-BoldItalic',
      'Courier',
      'Courier-Bold',
      'Courier-Oblique',
      'Courier-BoldOblique',
    ]),
  }),
  z.object({ kind: z.literal('library'), key: z.string().min(1) }),
  z.object({ kind: z.literal('uploaded'), storagePath: z.string().min(1) }),
]) satisfies z.ZodType<FontSource>;

const font = z.object({
  id,
  label: z.string(),
  source: fontSource,
}) satisfies z.ZodType<TemplateFont>;

const placeholderBase = {
  id,
  label: z.string(),
  pageIndex: z.int().min(0),
  box,
  rotation: finite.optional(),
  opacity: unitInterval.optional(),
  binding,
  required: z.boolean().optional(),
};

const textPlaceholder = z.object({
  ...placeholderBase,
  type: z.literal('text'),
  style: z.object({
    fontId: id,
    fontSize: positive.refine((n) => n <= TEMPLATE_LIMITS.maxFontSize, 'Font size is too large'),
    color: hexColor,
    align: z.enum(['left', 'center', 'right']),
    verticalAlign: z.enum(['top', 'middle', 'bottom']),
    lineHeight: finite.refine((n) => n >= 0.5 && n <= 5, 'Line height must be between 0.5 and 5'),
    textTransform: z.enum(['none', 'uppercase', 'lowercase', 'capitalize']).optional(),
  }),
  fit: z.object({
    wrap: z.boolean(),
    shrinkToFit: z.boolean(),
    minFontSize: positive,
    maxLines: z.int().min(1).optional(),
    overflow: z.enum(['visible', 'clip', 'ellipsis']),
  }),
  fallbackText: z.string().optional(),
}) satisfies z.ZodType<TextPlaceholder>;

const imagePlaceholder = z.object({
  ...placeholderBase,
  type: z.literal('image'),
  fit: z.enum(['cover', 'contain', 'fill']),
  position: z.object({ x: unitInterval, y: unitInterval }).optional(),
  shape: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('rectangle') }),
      z.object({ kind: z.literal('rounded'), radius: finite.refine((n) => n >= 0, 'Must be ≥ 0') }),
      z.object({ kind: z.literal('ellipse') }),
    ])
    .optional(),
  border: z.object({ width: positive, color: hexColor }).optional(),
  background: hexColor.optional(),
}) satisfies z.ZodType<ImagePlaceholder>;

const qrPlaceholder = z.object({
  ...placeholderBase,
  type: z.literal('qr'),
  errorCorrection: z.enum(['L', 'M', 'Q', 'H']),
  foreground: hexColor,
  background: hexColor.optional(),
  quietZone: z.int().min(0).max(TEMPLATE_LIMITS.maxQuietZone),
}) satisfies z.ZodType<QrPlaceholder>;

const placeholder = z.discriminatedUnion('type', [
  textPlaceholder,
  imagePlaceholder,
  qrPlaceholder,
]) satisfies z.ZodType<Placeholder>;

const pageSide = positive.refine(
  (n) => n <= TEMPLATE_LIMITS.maxPageSide,
  'Page is implausibly large — sizes are in points (1/72 in)',
);

export const templateDefinitionSchema: z.ZodType<TemplateDefinition> = z.object({
  schemaVersion: z.literal(TEMPLATE_SCHEMA_VERSION),
  kind: z.enum(['certificate', 'report', 'id-card', 'card', 'letter', 'other']),
  source: z.object({
    storagePath: z.string(),
    fileName: z.string(),
    byteSize: z.int().min(0),
    sha256: z.string(),
  }),
  pages: z
    .array(z.object({ width: pageSide, height: pageSide }))
    .min(1)
    .max(TEMPLATE_LIMITS.maxPages),
  fonts: z.array(font).max(TEMPLATE_LIMITS.maxFonts),
  placeholders: z.array(placeholder).max(TEMPLATE_LIMITS.maxPlaceholders),
  output: z.object({ fileNameTemplate: z.string() }),
});

/** One problem found in a template. `path` locates it, e.g. `placeholders.3.style.fontId`. */
export interface TemplateIssue {
  path: string;
  message: string;
}

export type TemplateValidationResult =
  { ok: true; template: TemplateDefinition } | { ok: false; issues: TemplateIssue[] };

/**
 * Rules that span several fields, which a structural schema cannot express: ids must be unique,
 * references must resolve, and placeholders must sit on a page that exists.
 */
function findConsistencyIssues(template: TemplateDefinition): TemplateIssue[] {
  const issues: TemplateIssue[] = [];

  const fontIds = new Set<string>();
  template.fonts.forEach((entry, index) => {
    if (fontIds.has(entry.id)) {
      issues.push({ path: `fonts.${index}.id`, message: `Duplicate font id "${entry.id}"` });
    }
    fontIds.add(entry.id);
  });

  const placeholderIds = new Set<string>();
  template.placeholders.forEach((entry, index) => {
    const at = `placeholders.${index}`;

    if (placeholderIds.has(entry.id)) {
      issues.push({ path: `${at}.id`, message: `Duplicate placeholder id "${entry.id}"` });
    }
    placeholderIds.add(entry.id);

    const page = template.pages[entry.pageIndex];
    if (!page) {
      issues.push({
        path: `${at}.pageIndex`,
        message: `Page ${entry.pageIndex + 1} does not exist — the template has ${template.pages.length} page(s)`,
      });
    } else {
      const { x, y, width, height } = entry.box;
      const outside = x >= page.width || y >= page.height || x + width <= 0 || y + height <= 0;
      if (outside) {
        issues.push({ path: `${at}.box`, message: 'The box lies completely outside its page' });
      }
    }

    if (entry.type === 'text') {
      if (!fontIds.has(entry.style.fontId)) {
        issues.push({
          path: `${at}.style.fontId`,
          message: `Unknown font "${entry.style.fontId}" — add it to the template's fonts`,
        });
      }
      if (entry.fit.minFontSize > entry.style.fontSize) {
        issues.push({
          path: `${at}.fit.minFontSize`,
          message: 'minFontSize cannot be larger than fontSize',
        });
      }
    }
  });

  return issues;
}

/**
 * Validates untrusted input as a template. On success the returned template contains only known
 * fields (unknown keys are dropped), so it is safe to hand to the engine.
 */
export function validateTemplate(input: unknown): TemplateValidationResult {
  const parsed = templateDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  const issues = findConsistencyIssues(parsed.data);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, template: parsed.data };
}
