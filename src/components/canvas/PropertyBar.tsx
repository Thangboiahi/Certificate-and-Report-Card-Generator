'use client';

/**
 * Bottom sheet for the selected placeholder (Framer Motion): a D-pad to nudge it and, for text, a
 * font-size control. It slides up when a field is selected and is dismissed with the close button,
 * Escape, or a downward swipe on its handle. It is not modal: the canvas stays usable behind it, so
 * another field can be tapped directly.
 *
 * Buttons repeat while held (after a short delay), so long moves do not need dozens of taps.
 */
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ImageIcon,
  Minus,
  Plus,
  QrCode,
  Type,
  X,
} from 'lucide-react';
import {
  AnimatePresence,
  MotionConfig,
  motion,
  useDragControls,
  type PanInfo,
} from 'framer-motion';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { formatMillimetres } from '@/lib/editor/coordinates';
import type { Placeholder, Points } from '@/lib/template';
import { cn } from '@/lib/utils/cn';
import {
  MIN_EDITOR_FONT_SIZE,
  selectSelectedPlaceholder,
  useTemplateStore,
} from '@/store/templateStore';

/** Nudge distances offered by the step switch, in points (1 pt ≈ 0.35 mm, 10 pt ≈ 3.5 mm). */
const STEPS: readonly Points[] = [1, 10];
const MAX_SLIDER_FONT_SIZE: Points = 144;
/** Swipe distance (px) or speed (px/s) on the handle that dismisses the sheet. */
const DISMISS_OFFSET = 80;
const DISMISS_VELOCITY = 500;

export function PropertyBar() {
  const placeholder = useTemplateStore(selectSelectedPlaceholder);
  const selectPlaceholder = useTemplateStore((state) => state.selectPlaceholder);
  const dragControls = useDragControls();

  useEffect(() => {
    if (!placeholder) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') selectPlaceholder(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [placeholder, selectPlaceholder]);

  function handleDragEnd(_event: unknown, info: PanInfo) {
    if (info.offset.y > DISMISS_OFFSET || info.velocity.y > DISMISS_VELOCITY) {
      selectPlaceholder(null);
    }
  }

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence>
        {placeholder && (
          <motion.section
            key="property-bar"
            role="region"
            aria-label={`${placeholder.label} properties`}
            data-testid="property-bar"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 34, stiffness: 380 }}
            drag="y"
            dragListener={false}
            dragControls={dragControls}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.7 }}
            onDragEnd={handleDragEnd}
            className="fixed inset-x-0 bottom-0 z-40 mx-auto w-full max-w-lg rounded-t-2xl border border-b-0 border-neutral-200 bg-white/95 pb-[max(1rem,env(safe-area-inset-bottom))] text-neutral-900 shadow-[0_-8px_30px_rgba(0,0,0,0.12)] backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/95 dark:text-neutral-100"
          >
            <div
              className="flex cursor-grab touch-none justify-center pt-2 pb-1 active:cursor-grabbing"
              onPointerDown={(event) => dragControls.start(event)}
              aria-hidden
            >
              <span className="h-1.5 w-10 rounded-full bg-neutral-300 dark:bg-neutral-700" />
            </div>
            <PropertyBarBody
              key={placeholder.id}
              placeholder={placeholder}
              onClose={() => selectPlaceholder(null)}
            />
          </motion.section>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}

function PropertyBarBody({
  placeholder,
  onClose,
}: {
  placeholder: Placeholder;
  onClose: () => void;
}) {
  const nudge = useTemplateStore((state) => state.nudgePlaceholder);
  const setFontSize = useTemplateStore((state) => state.setFontSize);
  const [stepIndex, setStepIndex] = useState(0);
  const step = STEPS[stepIndex]!;
  const { id, box } = placeholder;
  const TypeIcon =
    placeholder.type === 'text' ? Type : placeholder.type === 'qr' ? QrCode : ImageIcon;

  return (
    <div className="flex flex-col gap-4 px-4 pt-1">
      <header className="flex items-start gap-3">
        <span className="mt-0.5 rounded-lg bg-blue-50 p-2 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
          <TypeIcon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{placeholder.label}</h2>
          <p className="text-xs text-neutral-500 tabular-nums" data-testid="property-position">
            X {formatMillimetres(box.x)} · Y {formatMillimetres(box.y)}
            <span className="sr-only">
              {' '}
              ({box.x} by {box.y} points)
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close properties"
          className="-mt-1 -mr-2 rounded-full p-2.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-none dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          <X className="size-5" aria-hidden />
        </button>
      </header>

      <div className="flex items-center justify-between gap-4">
        <fieldset className="flex flex-col items-center gap-1">
          <legend className="sr-only">Nudge position by {step} pt</legend>
          <div className="grid grid-cols-3 grid-rows-3 gap-1" data-testid="dpad">
            <span />
            <RepeatButton label={`Move up ${step} pt`} onPress={() => nudge(id, 0, -step)}>
              <ArrowUp className="size-5" aria-hidden />
            </RepeatButton>
            <span />
            <RepeatButton label={`Move left ${step} pt`} onPress={() => nudge(id, -step, 0)}>
              <ArrowLeft className="size-5" aria-hidden />
            </RepeatButton>
            <button
              type="button"
              onClick={() => setStepIndex((index) => (index + 1) % STEPS.length)}
              aria-label={`Step size ${step} points. Change step size`}
              data-testid="nudge-step"
              className="flex size-12 flex-col items-center justify-center rounded-xl border border-neutral-200 text-xs leading-none font-semibold tabular-nums hover:border-neutral-400 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-none dark:border-neutral-700"
            >
              {step}
              <span className="text-[10px] font-normal text-neutral-500">pt</span>
            </button>
            <RepeatButton label={`Move right ${step} pt`} onPress={() => nudge(id, step, 0)}>
              <ArrowRight className="size-5" aria-hidden />
            </RepeatButton>
            <span />
            <RepeatButton label={`Move down ${step} pt`} onPress={() => nudge(id, 0, step)}>
              <ArrowDown className="size-5" aria-hidden />
            </RepeatButton>
            <span />
          </div>
        </fieldset>

        {placeholder.type === 'text' ? (
          <FontSizeControl
            fontSize={placeholder.style.fontSize}
            onChange={(size) => setFontSize(id, size)}
          />
        ) : (
          <p className="max-w-40 text-sm text-neutral-500">
            {placeholder.type === 'qr' ? 'QR code' : 'Image'} · {formatMillimetres(box.width)} ×{' '}
            {formatMillimetres(box.height)}
          </p>
        )}
      </div>

      <p className="text-xs text-neutral-500">
        Drag the field, use the arrows, or tap the page to move it there.
      </p>
    </div>
  );
}

function FontSizeControl({
  fontSize,
  onChange,
}: {
  fontSize: Points;
  onChange: (size: Points) => void;
}) {
  // The latest size, so a held button keeps counting from where it is now.
  const latest = useRef(fontSize);
  useEffect(() => {
    latest.current = fontSize;
  }, [fontSize]);

  return (
    <fieldset className="flex min-w-0 flex-1 flex-col gap-2">
      <legend className="mb-1 text-xs font-medium text-neutral-500">Font size</legend>
      <div className="flex items-center justify-between gap-2">
        <RepeatButton
          label="Decrease font size"
          onPress={() => onChange(Math.ceil(latest.current) - 1)}
          disabled={fontSize <= MIN_EDITOR_FONT_SIZE}
        >
          <Minus className="size-5" aria-hidden />
        </RepeatButton>
        <output
          className="min-w-14 text-center text-lg font-semibold tabular-nums"
          data-testid="font-size-value"
          aria-live="polite"
        >
          {fontSize}
          <span className="ml-0.5 text-xs font-normal text-neutral-500">pt</span>
        </output>
        <RepeatButton
          label="Increase font size"
          onPress={() => onChange(Math.floor(latest.current) + 1)}
        >
          <Plus className="size-5" aria-hidden />
        </RepeatButton>
      </div>
      <input
        type="range"
        min={MIN_EDITOR_FONT_SIZE}
        max={Math.max(MAX_SLIDER_FONT_SIZE, Math.ceil(fontSize))}
        step={1}
        value={fontSize}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label="Font size in points"
        className="w-full accent-blue-600"
      />
    </fieldset>
  );
}

/**
 * A button that acts once when pressed and then repeats while held. Keyboard activation (Enter /
 * Space, which arrive as clicks with `detail === 0`) acts once per key press.
 */
function RepeatButton({
  label,
  onPress,
  children,
  disabled,
  className,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const press = useRef(onPress);
  useEffect(() => {
    press.current = onPress;
  }, [onPress]);

  const stop = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);
  useEffect(() => {
    if (disabled) stop();
  }, [disabled]);

  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        stop();
        press.current();
        const repeat = (delay: number) => {
          timer.current = setTimeout(() => {
            press.current();
            repeat(60);
          }, delay);
        };
        repeat(400);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onClick={(event) => {
        if (event.detail === 0) press.current();
      }}
      onContextMenu={(event) => event.preventDefault()}
      className={cn(
        'flex size-12 touch-manipulation items-center justify-center rounded-xl bg-neutral-100 text-neutral-800 select-none hover:bg-neutral-200 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-none active:bg-neutral-300 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700 dark:active:bg-neutral-600',
        className,
      )}
    >
      {children}
    </button>
  );
}
