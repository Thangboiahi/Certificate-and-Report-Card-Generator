'use client';

/**
 * Preview ➔ Crop ➔ Confirm for one image. Full-screen on phones (pinch or slider to zoom, drag to
 * position), a centred dialog from `sm` up. On Confirm the crop is cut out with a canvas and
 * compressed to the 200 KB budget, and the resulting `File` is handed to `onConfirm`.
 */
import { Loader2, Minus, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import Cropper, { type Area, type Point } from 'react-easy-crop';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  dialogButton,
} from '@/components/ui/dialog';
import { cropAndCompress, MAX_IMAGE_BYTES } from '@/lib/utils/imageEditor';

export interface ImageCropModalProps {
  /** The image to edit. The modal is open while this is set. */
  imageFile: File | null;
  /** Width ÷ height of the box the image will fill, e.g. 3/4 for a passport photo. */
  targetAspectRatio: number;
  /** Receives the cropped, compressed image. */
  onConfirm: (file: File) => void;
  onCancel: () => void;
  /** Upper size limit for the result. Defaults to 200 KB. */
  maxBytes?: number;
  /** Show a circular crop guide (the saved image is still rectangular). */
  round?: boolean;
  title?: string;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

/** A stable React key per File object, so every new file starts with a fresh editor. */
const fileKeys = new WeakMap<File, number>();
let nextFileKey = 0;
function keyOf(file: File): number {
  let key = fileKeys.get(file);
  if (key === undefined) {
    key = nextFileKey++;
    fileKeys.set(file, key);
  }
  return key;
}

export function ImageCropModal({
  imageFile,
  title = 'Crop image',
  ...editor
}: ImageCropModalProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={imageFile !== null} onOpenChange={(open) => !open && !busy && editor.onCancel()}>
      <DialogContent data-testid="image-crop-modal" className="sm:h-[min(42rem,90dvh)]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Drag to position, pinch or use the slider to zoom. Saved at up to{' '}
            {Math.round((editor.maxBytes ?? MAX_IMAGE_BYTES) / 1024)} KB.
          </DialogDescription>
        </DialogHeader>
        {imageFile && (
          <CropEditor
            key={keyOf(imageFile)}
            imageFile={imageFile}
            onBusyChange={setBusy}
            {...editor}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CropEditor({
  imageFile,
  targetAspectRatio,
  onConfirm,
  onCancel,
  maxBytes = MAX_IMAGE_BYTES,
  round = false,
  onBusyChange,
}: Omit<ImageCropModalProps, 'imageFile' | 'title'> & {
  imageFile: File;
  onBusyChange: (busy: boolean) => void;
}) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [pixels, setPixels] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The object URL is an external resource: created here, released when the editor goes away.
  useEffect(() => {
    const url = URL.createObjectURL(imageFile);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing with an external resource
    setImageSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  async function confirm() {
    if (!imageSrc || !pixels) return;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      onConfirm(await cropAndCompress(imageFile, imageSrc, pixels, maxBytes));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The image could not be processed.');
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  const stepZoom = (delta: number) =>
    setZoom((value) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value + delta)));

  return (
    <>
      <div className="relative min-h-64 flex-1 bg-neutral-900">
        {imageSrc && (
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            aspect={targetAspectRatio}
            cropShape={round ? 'round' : 'rect'}
            showGrid={false}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={(_area, areaPixels) => setPixels(areaPixels)}
          />
        )}
      </div>

      <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
        <button
          type="button"
          onClick={() => stepZoom(-0.25)}
          className="rounded-full p-2.5 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          aria-label="Zoom out"
        >
          <Minus className="size-5" aria-hidden />
        </button>
        <input
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}
          aria-label="Zoom"
          className="h-11 flex-1 accent-blue-600"
        />
        <button
          type="button"
          onClick={() => stepZoom(0.25)}
          className="rounded-full p-2.5 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          aria-label="Zoom in"
        >
          <Plus className="size-5" aria-hidden />
        </button>
      </div>

      {error && (
        <p
          role="alert"
          className="mx-4 mb-2 rounded-lg bg-red-50 p-3 text-sm text-red-800 sm:mx-6 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </p>
      )}

      <DialogFooter>
        <button type="button" onClick={onCancel} disabled={busy} className={dialogButton.secondary}>
          Cancel
        </button>
        <button
          type="button"
          data-testid="crop-confirm"
          onClick={confirm}
          disabled={busy || !pixels}
          className={dialogButton.primary}
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-label="Processing" /> : 'Confirm'}
        </button>
      </DialogFooter>
    </>
  );
}
