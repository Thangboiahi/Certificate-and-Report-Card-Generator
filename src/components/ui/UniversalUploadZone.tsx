'use client';

/**
 * The one way files enter the app. Drop or tap to pick a file; images go through
 * `ImageCropModal`, CSVs through `CsvPreviewModal`, and only a confirmed result reaches
 * `onConfirm`. Nothing is uploaded or stored here.
 *
 * `'template'` is a third kind for a document background: a PDF, PNG or JPG that is handed over
 * exactly as chosen (no cropping, which would change the page the fields are placed on).
 */
import { Upload } from 'lucide-react';
import { useState } from 'react';
import { useDropzone, type Accept, type FileRejection } from 'react-dropzone';

import { CsvPreviewModal } from '@/components/ui/CsvPreviewModal';
import { ImageCropModal } from '@/components/ui/ImageCropModal';
import { cn } from '@/lib/utils/cn';
import { MAX_CSV_BYTES, parseCsvFile, type ParsedCsv } from '@/lib/utils/csv';

export type UploadKind = 'image' | 'csv' | 'template';

export type ConfirmedUpload =
  | { kind: 'image'; file: File }
  | { kind: 'template'; file: File }
  | { kind: 'csv'; file: File; data: ParsedCsv };

export interface UniversalUploadZoneProps {
  /** Which kinds of file to accept. Defaults to both. */
  accept?: readonly UploadKind[];
  /** Width ÷ height for the crop box. Defaults to 1 (square). */
  targetAspectRatio?: number;
  /** Columns a CSV must have. */
  requiredHeaders?: string[];
  onConfirm: (upload: ConfirmedUpload) => void;
  /** Largest image accepted before editing. Defaults to 20 MB (phone photos). */
  maxImageInputBytes?: number;
  label?: string;
  disabled?: boolean;
  className?: string;
}

const IMAGE_ACCEPT: Accept = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
};
const CSV_ACCEPT: Accept = { 'text/csv': ['.csv'], 'application/vnd.ms-excel': ['.csv'] };
const TEMPLATE_ACCEPT: Accept = {
  'application/pdf': ['.pdf'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
};

function kindOf(file: File): UploadKind | null {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'template';
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'text/csv' || /\.csv$/i.test(file.name)) return 'csv';
  return null;
}

function describeRejection(rejection: FileRejection, maxImageBytes: number): string {
  const code = rejection.errors[0]?.code;
  if (code === 'file-invalid-type')
    return `${rejection.file.name}: this type of file is not accepted.`;
  if (code === 'file-too-large') {
    const limit = kindOf(rejection.file) === 'csv' ? MAX_CSV_BYTES : maxImageBytes;
    return `${rejection.file.name}: larger than ${Math.round(limit / (1024 * 1024))} MB.`;
  }
  if (code === 'too-many-files') return 'Choose one file at a time.';
  return `${rejection.file.name}: ${rejection.errors[0]?.message ?? 'not accepted.'}`;
}

export function UniversalUploadZone({
  accept = ['image', 'csv'],
  targetAspectRatio = 1,
  requiredHeaders = [],
  onConfirm,
  maxImageInputBytes = 20 * 1024 * 1024,
  label,
  disabled = false,
  className,
}: UniversalUploadZoneProps) {
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [csv, setCsv] = useState<{ file: File; data: ParsedCsv } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);

  const acceptMap: Accept = {
    ...(accept.includes('image') ? IMAGE_ACCEPT : {}),
    ...(accept.includes('template') ? TEMPLATE_ACCEPT : {}),
    ...(accept.includes('csv') ? CSV_ACCEPT : {}),
  };

  async function route(file: File) {
    setError(null);
    const kind = kindOf(file);
    if (kind === 'template' && accept.includes('template')) {
      onConfirm({ kind: 'template', file });
    } else if (kind === 'image' && accept.includes('image')) {
      setImageFile(file);
    } else if (kind === 'image' && accept.includes('template')) {
      onConfirm({ kind: 'template', file });
    } else if (kind === 'csv' && accept.includes('csv')) {
      if (file.size > MAX_CSV_BYTES) {
        setError(`${file.name}: larger than ${MAX_CSV_BYTES / (1024 * 1024)} MB.`);
        return;
      }
      setParsing(true);
      try {
        setCsv({ file, data: await parseCsvFile(file) });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'The CSV could not be read.');
      } finally {
        setParsing(false);
      }
    } else {
      setError(`${file.name}: this type of file is not accepted.`);
    }
  }

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: acceptMap,
    multiple: false,
    disabled: disabled || parsing,
    // Each kind has its own limit; checked here so one dropzone can hold both.
    validator: (file) =>
      file instanceof File &&
      (kindOf(file) === 'image' || kindOf(file) === 'template') &&
      file.size > maxImageInputBytes
        ? { code: 'file-too-large', message: 'too large' }
        : null,
    onDropAccepted: ([file]) => file && void route(file),
    onDropRejected: ([rejection]) =>
      rejection && setError(describeRejection(rejection, maxImageInputBytes)),
  });

  const kinds = accept
    .map((kind) =>
      kind === 'image' ? 'JPG, PNG or WebP image' : kind === 'csv' ? 'CSV file' : 'PDF, PNG or JPG',
    )
    .join(' or ');

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div
        {...getRootProps({
          'data-testid': 'upload-zone',
          className: cn(
            'flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-6 text-center transition-colors',
            isDragActive
              ? 'border-blue-600 bg-blue-50 dark:bg-blue-950'
              : 'border-neutral-300 hover:border-neutral-500 dark:border-neutral-700',
            (disabled || parsing) && 'cursor-not-allowed opacity-50',
          ),
        } as Parameters<typeof getRootProps>[0])}
      >
        <input {...getInputProps()} data-testid="upload-input" />
        <Upload className="size-6 text-neutral-500" aria-hidden />
        <p className="text-sm font-medium">
          {parsing ? 'Reading file…' : (label ?? 'Tap to choose a file, or drop it here')}
        </p>
        <p className="text-xs text-neutral-500">{kinds}</p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      <ImageCropModal
        imageFile={imageFile}
        targetAspectRatio={targetAspectRatio}
        onCancel={() => setImageFile(null)}
        onConfirm={(file) => {
          setImageFile(null);
          onConfirm({ kind: 'image', file });
        }}
      />
      <CsvPreviewModal
        data={csv?.data ?? null}
        fileName={csv?.file.name}
        requiredHeaders={requiredHeaders}
        onCancel={() => setCsv(null)}
        onConfirm={(data) => {
          const file = csv?.file;
          setCsv(null);
          if (file) onConfirm({ kind: 'csv', file, data });
        }}
      />
    </div>
  );
}
