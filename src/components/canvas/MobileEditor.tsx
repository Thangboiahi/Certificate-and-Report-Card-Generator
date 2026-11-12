'use client';

/**
 * The Tap-to-Place canvas. Each template page is rendered by pdf.js into a canvas; placeholders
 * are absolutely positioned `<button>`s on top of it, placed with percentages of the page so the
 * layout holds at any screen width.
 *
 * - Tap a field to select it (opens `PropertyBar`).
 * - Drag a field to move it (on touch screens, only the selected field — so swipes still scroll).
 * - With a field selected, tap anywhere on its page to move the field's centre there.
 * - Keyboard: arrow keys nudge the focused field by 1 pt (Shift: 10 pt); Escape deselects.
 *
 * All edits go through `useTemplateStore`, which stores PDF points — what the PDF Web Worker uses.
 */
import { ImageIcon, QrCode, TriangleAlert } from 'lucide-react';
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';

import { boxToPercent, centredAtPercent, clientToPercent } from '@/lib/editor/coordinates';
import {
  openPreviewDocument,
  pageSize,
  renderPageToCanvas,
  type PDFDocumentProxy,
} from '@/lib/editor/pdf-preview';
import { cssFontFor, fontFaceName, previewText } from '@/lib/editor/preview-style';
import type { DataRow, Placeholder, TemplateFont, TemplatePage } from '@/lib/template';
import { cn } from '@/lib/utils/cn';
import { useTemplateStore } from '@/store/templateStore';

export interface MobileEditorProps {
  /** The template's background PDF: a same-origin URL, or the file's bytes. */
  pdf: string | ArrayBuffer;
  /**
   * Font files for `library` / `uploaded` template fonts, keyed by `TemplateFont.id`, so the
   * preview uses the real typeface. Standard PDF fonts need nothing.
   */
  fontUrls?: Record<string, string>;
  /** Which of the store's `dataRows` fills the preview. Defaults to the first. */
  previewRowIndex?: number;
  className?: string;
}

/** Pointer travel (CSS px) before a press becomes a drag rather than a tap. */
const DRAG_THRESHOLD = 4;
const NUDGE_KEYS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export function MobileEditor({ pdf, fontUrls, previewRowIndex = 0, className }: MobileEditorProps) {
  const template = useTemplateStore((state) => state.activeTemplate);
  const previewRow = useTemplateStore((state) => state.dataRows[previewRowIndex]);
  const [loaded, setLoaded] = useState<{
    source: string | ArrayBuffer;
    document: PDFDocumentProxy | null;
    error: string | null;
  } | null>(null);
  // Only trust a result that belongs to the current source.
  const current = loaded?.source === pdf ? loaded : null;

  useEffect(() => {
    let cancelled = false;
    const handle = openPreviewDocument(pdf);
    handle.promise.then(
      (document) => {
        if (!cancelled) setLoaded({ source: pdf, document, error: null });
      },
      (error: unknown) => {
        if (cancelled) return;
        console.error('Template preview failed', error);
        setLoaded({ source: pdf, document: null, error: 'The template file could not be opened.' });
      },
    );
    return () => {
      cancelled = true;
      handle.destroy();
    };
  }, [pdf]);

  useTemplateFonts(template?.fonts, fontUrls);

  if (!template) {
    return <p className="p-4 text-sm text-neutral-500">No template loaded.</p>;
  }

  return (
    <div
      className={cn('mx-auto flex w-full max-w-3xl flex-col gap-6', className)}
      data-testid="mobile-editor"
      data-ready={current?.document ? 'true' : 'false'}
    >
      {current?.error && (
        <p
          role="alert"
          className="rounded-xl bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
        >
          {current.error}
        </p>
      )}
      {template.pages.map((page, pageIndex) => (
        <EditorPage
          // The page index is the page's identity in the template.
          key={pageIndex}
          pageIndex={pageIndex}
          pageCount={template.pages.length}
          page={page}
          fonts={template.fonts}
          document={current?.document ?? null}
          previewRow={previewRow}
        />
      ))}
    </div>
  );
}

/** Registers the template's font files with the browser for the lifetime of the editor. */
function useTemplateFonts(
  fonts: readonly TemplateFont[] | undefined,
  fontUrls: Record<string, string> | undefined,
): void {
  const key = JSON.stringify(
    (fonts ?? [])
      .filter((font) => fontUrls?.[font.id])
      .map((font) => [font.id, fontUrls![font.id]]),
  );
  useEffect(() => {
    const entries = JSON.parse(key) as [string, string][];
    const faces = entries.map(
      ([id, url]) => new FontFace(fontFaceName(id), `url(${JSON.stringify(url)})`),
    );
    for (const face of faces) {
      document.fonts.add(face);
      face.load().catch((error: unknown) => console.warn('Preview font failed to load', error));
    }
    return () => {
      for (const face of faces) document.fonts.delete(face);
    };
  }, [key]);
}

interface EditorPageProps {
  pageIndex: number;
  pageCount: number;
  page: TemplatePage;
  fonts: readonly TemplateFont[];
  document: PDFDocumentProxy | null;
  previewRow: DataRow | undefined;
}

function EditorPage({ pageIndex, pageCount, page, fonts, document, previewRow }: EditorPageProps) {
  const allPlaceholders = useTemplateStore((state) => state.activeTemplate?.placeholders);
  const selectedId = useTemplateStore((state) => state.selectedPlaceholderId);
  const placeholders = useMemo(
    () => (allPlaceholders ?? []).filter((placeholder) => placeholder.pageIndex === pageIndex),
    [allPlaceholders, pageIndex],
  );
  const fontsById = useMemo(() => new Map(fonts.map((font) => [font.id, font])), [fonts]);

  const surface = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [cssWidth, setCssWidth] = useState(0);
  const [rendered, setRendered] = useState<{ width: number; document: PDFDocumentProxy } | null>(
    null,
  );
  const [mismatch, setMismatch] = useState<TemplatePage | null>(null);

  // Track the page's on-screen width so the canvas is re-rendered sharply after a resize.
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      cancelAnimationFrame(frame);
      const width = Math.round(entry?.contentRect.width ?? 0);
      frame = requestAnimationFrame(() => setCssWidth(width));
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const target = canvas.current;
    if (!document || !target || cssWidth === 0) return;
    const controller = new AbortController();
    (async () => {
      const pdfPage = await document.getPage(pageIndex + 1);
      const actual = pageSize(pdfPage);
      const off =
        Math.abs(actual.width - page.width) > 0.5 || Math.abs(actual.height - page.height) > 0.5;
      setMismatch(off ? actual : null);
      await renderPageToCanvas(pdfPage, target, cssWidth, controller.signal);
      if (!controller.signal.aborted) setRendered({ width: cssWidth, document });
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof Error && error.name === 'RenderingCancelledException') return;
      console.error(`Page ${pageIndex + 1} could not be rendered`, error);
    });
    return () => controller.abort();
  }, [document, pageIndex, cssWidth, page.width, page.height]);

  const missingPage = document !== null && pageIndex >= document.numPages;

  function handleSurfaceClick(event: MouseEvent<HTMLDivElement>) {
    const store = useTemplateStore.getState();
    const selected = store.activeTemplate?.placeholders.find(
      (placeholder) => placeholder.id === store.selectedPlaceholderId,
    );
    if (!selected) return;
    if (selected.pageIndex !== pageIndex) {
      store.selectPlaceholder(null);
      return;
    }
    // Tap-to-Place: centre the selected field on the tapped point.
    const tap = clientToPercent(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
    );
    const target = centredAtPercent(tap.xPercent, tap.yPercent, selected.box, page);
    store.updatePlaceholderCoords(selected.id, target.xPercent, target.yPercent);
  }

  return (
    <section aria-label={`Page ${pageIndex + 1} of ${pageCount}`} className="flex flex-col gap-2">
      {pageCount > 1 && (
        <h2 className="px-1 text-xs font-medium tracking-wide text-neutral-500 uppercase">
          Page {pageIndex + 1} of {pageCount}
        </h2>
      )}
      {(mismatch || missingPage) && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {missingPage
            ? 'This page is missing from the background file.'
            : `The background page is ${mismatch!.width.toFixed(1)} × ${mismatch!.height.toFixed(1)} pt, but the template expects ${page.width} × ${page.height} pt. Fields may land in the wrong place.`}
        </p>
      )}
      {/* The surface is a size container: placeholder font sizes use `cqw`, i.e. its width. */}
      <div
        ref={surface}
        data-page-surface
        data-testid="page-surface"
        data-page-index={pageIndex}
        data-rendered={rendered?.document === document && rendered !== null ? 'true' : 'false'}
        onClick={handleSurfaceClick}
        className="relative w-full touch-manipulation overflow-hidden rounded-md bg-neutral-100 shadow-sm ring-1 ring-black/10 select-none [-webkit-touch-callout:none] dark:bg-neutral-800 dark:ring-white/10"
        style={{
          aspectRatio: `${page.width} / ${page.height}`,
          containerType: 'inline-size',
          WebkitTextSizeAdjust: '100%',
          textSizeAdjust: '100%',
        }}
      >
        <canvas
          ref={canvas}
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 size-full bg-white transition-opacity duration-300',
            rendered ? 'opacity-100' : 'opacity-0',
          )}
        />
        {placeholders.map((placeholder) => (
          <PlaceholderView
            key={placeholder.id}
            placeholder={placeholder}
            page={page}
            font={placeholder.type === 'text' ? fontsById.get(placeholder.style.fontId) : undefined}
            text={previewText(placeholder, previewRow)}
            selected={placeholder.id === selectedId}
          />
        ))}
      </div>
    </section>
  );
}

interface PlaceholderViewProps {
  placeholder: Placeholder;
  page: TemplatePage;
  font: TemplateFont | undefined;
  text: string;
  selected: boolean;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  left: number;
  top: number;
  rect: DOMRect;
  dragging: boolean;
}

const PlaceholderView = memo(function PlaceholderView({
  placeholder,
  page,
  font,
  text,
  selected,
}: PlaceholderViewProps) {
  const drag = useRef<DragState | null>(null);
  const { id, box } = placeholder;
  const percent = boxToPercent(box, page);

  function handlePointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    // On touch screens only the selected field is draggable: a swipe that starts on any other
    // field must scroll the page (its `touch-action` lets the browser pan), not move the field.
    if (event.pointerType === 'touch' && !selected) return;
    const surface = event.currentTarget.closest<HTMLElement>('[data-page-surface]');
    if (!surface) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: percent.left,
      top: percent.top,
      rect: surface.getBoundingClientRect(),
      dragging: false,
    };
  }

  function handlePointerMove(event: PointerEvent<HTMLButtonElement>) {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (!state.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      state.dragging = true;
      useTemplateStore.getState().selectPlaceholder(id);
    }
    useTemplateStore
      .getState()
      .updatePlaceholderCoords(
        id,
        state.left + (dx / state.rect.width) * 100,
        state.top + (dy / state.rect.height) * 100,
      );
  }

  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    // Never let a tap on a field reach the page (which would move the selected field here).
    event.stopPropagation();
    useTemplateStore.getState().selectPlaceholder(id);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const store = useTemplateStore.getState();
    if (event.key === 'Escape') {
      store.selectPlaceholder(null);
      return;
    }
    const direction = NUDGE_KEYS[event.key];
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    store.selectPlaceholder(id);
    store.nudgePlaceholder(id, direction[0] * step, direction[1] * step);
  }

  const style: CSSProperties = {
    left: `${percent.left}%`,
    top: `${percent.top}%`,
    width: `${percent.width}%`,
    height: `${percent.height}%`,
    // Clockwise about the box centre — the same convention the engine draws with.
    transform: placeholder.rotation ? `rotate(${placeholder.rotation}deg)` : undefined,
  };

  return (
    <button
      type="button"
      data-testid="placeholder"
      data-placeholder-id={id}
      data-box={`${box.x},${box.y},${box.width},${box.height}`}
      data-font-size={placeholder.type === 'text' ? placeholder.style.fontSize : undefined}
      aria-label={`${placeholder.label} (${placeholder.type} field)`}
      aria-pressed={selected}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'absolute flex cursor-grab overflow-hidden rounded-[2px] p-0 text-left outline-offset-0 transition-[background-color,box-shadow] active:cursor-grabbing',
        'focus-visible:outline-2 focus-visible:outline-blue-600',
        selected
          ? 'z-10 touch-none bg-blue-500/15 ring-2 ring-blue-600'
          : 'touch-manipulation bg-blue-500/5 outline-1 outline-blue-500/60 outline-dashed hover:bg-blue-500/10',
      )}
      style={style}
    >
      <PlaceholderContent placeholder={placeholder} page={page} font={font} text={text} />
    </button>
  );
});

function PlaceholderContent({
  placeholder,
  page,
  font,
  text,
}: Omit<PlaceholderViewProps, 'selected'>) {
  if (placeholder.type === 'text') {
    const { style, fit } = placeholder;
    const css = cssFontFor(font);
    return (
      <span
        className={cn(
          'flex size-full min-w-0',
          style.verticalAlign === 'top' && 'items-start',
          style.verticalAlign === 'middle' && 'items-center',
          style.verticalAlign === 'bottom' && 'items-end',
        )}
      >
        <span
          className={cn(
            'block w-full min-w-0',
            fit.wrap ? 'break-words whitespace-pre-wrap' : 'truncate whitespace-pre',
          )}
          style={{
            ...css,
            // Points → share of the page width → `cqw` of the page surface: true scale at any width.
            fontSize: `${(style.fontSize / page.width) * 100}cqw`,
            lineHeight: style.lineHeight,
            color: style.color,
            textAlign: style.align,
            textTransform:
              style.textTransform && style.textTransform !== 'none'
                ? style.textTransform
                : undefined,
          }}
        >
          {text}
        </span>
      </span>
    );
  }

  const Icon = placeholder.type === 'qr' ? QrCode : ImageIcon;
  const radius =
    placeholder.type === 'image' && placeholder.shape?.kind === 'ellipse'
      ? '50%'
      : placeholder.type === 'image' && placeholder.shape?.kind === 'rounded'
        ? `${(placeholder.shape.radius / page.width) * 100}cqw`
        : undefined;
  return (
    <span
      className="flex size-full flex-col items-center justify-center gap-0.5 border border-dashed border-blue-600/60 bg-white/50 p-0.5 text-center text-blue-900 dark:text-blue-950"
      style={{ borderRadius: radius }}
    >
      <Icon className="size-[min(40%,1.25rem)] shrink-0" aria-hidden />
      <span className="line-clamp-2 text-[clamp(7px,1.6cqw,11px)] leading-tight font-medium">
        {placeholder.label}
      </span>
    </span>
  );
}
