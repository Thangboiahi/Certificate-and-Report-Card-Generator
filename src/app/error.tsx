'use client';

import { useEffect } from 'react';

import { notifyError } from '@/lib/ui/notify';

/**
 * Shown when a page crashes while rendering. The failure is also toasted so it is not missed on a
 * small screen, and "Try again" re-renders the segment.
 */
export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
    notifyError(error, 'This page ran into a problem.');
  }, [error]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        This page could not be shown. Your data has not been changed.
      </p>
      <button
        type="button"
        onClick={() => retry()}
        className="min-h-11 rounded-xl bg-blue-600 px-5 text-sm font-medium text-white hover:bg-blue-700"
      >
        Try again
      </button>
    </main>
  );
}
