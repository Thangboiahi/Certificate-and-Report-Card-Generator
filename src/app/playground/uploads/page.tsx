'use client';

/** Developer harness for the upload gateway. Driven by `scripts/e2e-uploads.mjs`. */
import { useState } from 'react';

import { UniversalUploadZone, type ConfirmedUpload } from '@/components/ui/UniversalUploadZone';

export default function UploadsPlayground() {
  const [result, setResult] = useState<ConfirmedUpload | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  function confirm(upload: ConfirmedUpload) {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(upload.kind === 'image' ? URL.createObjectURL(upload.file) : null);
    setResult(upload);
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Upload gateway</h1>
      <UniversalUploadZone
        targetAspectRatio={3 / 4}
        requiredHeaders={['Name', 'Roll', 'Photo']}
        onConfirm={confirm}
      />
      {result && (
        <section
          data-testid="upload-result"
          data-kind={result.kind}
          data-bytes={result.file.size}
          data-type={result.file.type}
          data-name={result.file.name}
          data-rows={result.kind === 'csv' ? result.data.rows.length : undefined}
          className="flex flex-col gap-2 rounded-2xl border border-neutral-200 p-4 text-sm dark:border-neutral-800"
        >
          <p>
            {result.kind !== 'csv'
              ? `${result.file.name} · ${Math.round(result.file.size / 1024)} KB · ${result.file.type}`
              : `${result.file.name} · ${result.data.rows.length} rows`}
          </p>
          {preview && (
            // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
            <img
              data-testid="upload-preview"
              src={preview}
              alt="Cropped result"
              className="w-40 rounded-lg"
            />
          )}
        </section>
      )}
    </main>
  );
}
