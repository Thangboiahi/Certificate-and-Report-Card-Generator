/**
 * State of the active Tap-to-Place editor (Zustand).
 *
 *     const name = useTemplateStore((s) => s.activeTemplate?.placeholders[0]);
 *     useTemplateStore.getState().updatePlaceholderCoords('name', 26.25, 34.3);
 *
 * The template is held exactly as the PDF Web Worker consumes it: geometry in PDF points from the
 * top-left of the displayed page (ADR-003). The canvas speaks percentages of the rendered page;
 * every action converts once, here, so `activeTemplate` can be handed to `generatePdfBatch`
 * unchanged. Edits are immutable: an edited placeholder gets a new object, untouched placeholders
 * keep theirs, so memoised canvas items re-render only when their own data changed.
 */
import { create } from 'zustand';

import { applyAuditPatch, type ApplyReport, type AuditPatch } from '@/lib/ai/schema';
import { clampBoxPosition, percentToPoints, roundPoints } from '@/lib/editor/coordinates';
import {
  TEMPLATE_LIMITS,
  type DataRow,
  type Placeholder,
  type Points,
  type TemplateDefinition,
} from '@/lib/template';

/** Smallest font size the editor offers. The schema allows anything above zero. */
export const MIN_EDITOR_FONT_SIZE: Points = 4;

export interface TemplateStoreState {
  /** The template being edited, or `null` before one is loaded. */
  activeTemplate: TemplateDefinition | null;
  /** The placeholder whose property bar is open. */
  selectedPlaceholderId: string | null;
  /** Rows used to preview real values on the canvas (and, later, to generate the batch). */
  dataRows: DataRow[];

  /** Starts editing a template. Clears the selection. */
  loadTemplate(template: TemplateDefinition, dataRows?: DataRow[]): void;
  setDataRows(dataRows: DataRow[]): void;
  /** Appends placeholders (fields for a new CSV's columns). Ids already in use are skipped. */
  addPlaceholders(placeholders: Placeholder[]): void;
  /** Appends placeholders (e.g. fields for a newly uploaded CSV's columns). Ids already in use are skipped. */
  addPlaceholders(placeholders: Placeholder[]): void;
  /** Selects a placeholder (opens its property bar), or clears the selection with `null`. */
  selectPlaceholder(id: string | null): void;
  /**
   * Moves a placeholder so its box's top-left corner sits at the given position, in percent of its
   * page's width and height. Stored as points, clamped so the box stays on the page.
   */
  updatePlaceholderCoords(id: string, xPercent: number, yPercent: number): void;
  /** Moves a placeholder by a distance in points (the property bar's D-pad and arrow keys). */
  nudgePlaceholder(id: string, dxPoints: Points, dyPoints: Points): void;
  /**
   * Sets a text placeholder's font size in points. When it goes below the shrink-to-fit minimum,
   * the minimum follows it down (the schema requires `minFontSize ≤ fontSize`).
   */
  setFontSize(id: string, fontSize: Points): void;
  /**
   * Applies a validated AI patch (`src/lib/ai/schema.ts`) to the rows and to text styling in one
   * update. Operations that do not match the real state are skipped and listed in the report.
   */
  applyAiPatch(patch: AuditPatch): ApplyReport;
  /** Puts back rows and template captured before `applyAiPatch` (undo). */
  restoreSnapshot(snapshot: {
    dataRows: DataRow[];
    activeTemplate: TemplateDefinition | null;
  }): void;
  /** Forgets the template, selection and rows. */
  reset(): void;
}

const INITIAL = {
  activeTemplate: null,
  selectedPlaceholderId: null,
  dataRows: [] as DataRow[],
} satisfies Partial<TemplateStoreState>;

type Change = (placeholder: Placeholder, template: TemplateDefinition) => Placeholder;

/**
 * Applies `change` to one placeholder. Returns `null` (no state change, no re-render) when the
 * template, the placeholder or its page is missing, or when nothing actually changed.
 */
function withPlaceholder(
  template: TemplateDefinition | null,
  id: string,
  change: Change,
): Pick<TemplateStoreState, 'activeTemplate'> | null {
  if (!template) return null;
  const index = template.placeholders.findIndex((placeholder) => placeholder.id === id);
  const current = template.placeholders[index];
  if (!current || !template.pages[current.pageIndex]) return null;
  const next = change(current, template);
  if (next === current) return null;
  const placeholders = template.placeholders.slice();
  placeholders[index] = next;
  return { activeTemplate: { ...template, placeholders } };
}

function moveTo(placeholder: Placeholder, position: { x: Points; y: Points }): Placeholder {
  const { box } = placeholder;
  if (box.x === position.x && box.y === position.y) return placeholder;
  return { ...placeholder, box: { ...box, x: position.x, y: position.y } };
}

export const useTemplateStore = create<TemplateStoreState>()((set, get) => ({
  ...INITIAL,

  loadTemplate(template, dataRows) {
    set({
      activeTemplate: template,
      selectedPlaceholderId: null,
      dataRows: dataRows ?? get().dataRows,
    });
  },

  setDataRows(dataRows) {
    set({ dataRows });
  },

  addPlaceholders(placeholders) {
    const template = get().activeTemplate;
    if (!template) return;
    const taken = new Set(template.placeholders.map((placeholder) => placeholder.id));
    const added = placeholders.filter(
      (placeholder) => !taken.has(placeholder.id) && template.pages[placeholder.pageIndex],
    );
    if (added.length === 0) return;
    set({ activeTemplate: { ...template, placeholders: [...template.placeholders, ...added] } });
  },

  selectPlaceholder(id) {
    if (id === get().selectedPlaceholderId) return;
    const exists = id === null || get().activeTemplate?.placeholders.some((p) => p.id === id);
    if (exists) set({ selectedPlaceholderId: id });
  },

  updatePlaceholderCoords(id, xPercent, yPercent) {
    const update = withPlaceholder(get().activeTemplate, id, (placeholder, template) =>
      moveTo(
        placeholder,
        percentToPoints(
          xPercent,
          yPercent,
          placeholder.box,
          template.pages[placeholder.pageIndex]!,
        ),
      ),
    );
    if (update) set(update);
  },

  nudgePlaceholder(id, dxPoints, dyPoints) {
    if (!Number.isFinite(dxPoints) || !Number.isFinite(dyPoints)) return;
    const update = withPlaceholder(get().activeTemplate, id, (placeholder, template) => {
      const { box } = placeholder;
      return moveTo(
        placeholder,
        clampBoxPosition(
          box.x + dxPoints,
          box.y + dyPoints,
          box,
          template.pages[placeholder.pageIndex]!,
        ),
      );
    });
    if (update) set(update);
  },

  setFontSize(id, fontSize) {
    if (!Number.isFinite(fontSize)) return;
    const size = roundPoints(
      Math.min(Math.max(fontSize, MIN_EDITOR_FONT_SIZE), TEMPLATE_LIMITS.maxFontSize),
    );
    const update = withPlaceholder(get().activeTemplate, id, (placeholder) => {
      if (placeholder.type !== 'text' || placeholder.style.fontSize === size) return placeholder;
      return {
        ...placeholder,
        style: { ...placeholder.style, fontSize: size },
        fit:
          placeholder.fit.minFontSize > size
            ? { ...placeholder.fit, minFontSize: size }
            : placeholder.fit,
      };
    });
    if (update) set(update);
  },

  applyAiPatch(patch) {
    const { dataRows, activeTemplate } = get();
    const result = applyAuditPatch({ dataRows, template: activeTemplate }, patch);
    if (result.dataRows !== dataRows || result.template !== activeTemplate) {
      set({ dataRows: result.dataRows, activeTemplate: result.template });
    }
    return result.report;
  },

  restoreSnapshot(snapshot) {
    set({ dataRows: snapshot.dataRows, activeTemplate: snapshot.activeTemplate });
  },

  reset() {
    set(INITIAL);
  },
}));

/** The selected placeholder, or `null`. Use as `useTemplateStore(selectSelectedPlaceholder)`. */
export function selectSelectedPlaceholder(state: TemplateStoreState): Placeholder | null {
  const id = state.selectedPlaceholderId;
  if (id === null) return null;
  return state.activeTemplate?.placeholders.find((placeholder) => placeholder.id === id) ?? null;
}
