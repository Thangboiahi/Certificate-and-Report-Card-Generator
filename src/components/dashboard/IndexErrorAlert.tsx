import { DatabaseZap, ExternalLink } from 'lucide-react';

import type { IndexError } from '@/lib/firestore-errors';

/**
 * Shown when a Firestore query needs a composite index that has not been built yet. Gives the
 * exact link Firebase produced, so an administrator builds the index with one click.
 */
export function IndexErrorAlert({ error, what }: { error: IndexError; what: string }) {
  return (
    <div
      role="alert"
      data-testid="index-error"
      className="flex flex-col gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
    >
      <p className="flex items-center gap-2 font-medium">
        <DatabaseZap className="size-4 shrink-0" aria-hidden /> {what} needs a one-time database
        setup
      </p>
      {error.link ? (
        <>
          <p>
            Firestore needs an index before it can load this page. An administrator can build it
            with one click; it is ready in a few minutes, then reload this page.
          </p>
          <a
            href={error.link}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="index-error-link"
            className="inline-flex min-h-11 items-center gap-2 self-start rounded-xl bg-amber-900 px-4 font-medium text-white hover:bg-amber-800"
          >
            Build the index in Firebase Console <ExternalLink className="size-4" aria-hidden />
          </a>
          <p className="text-xs break-all opacity-80">{error.link}</p>
        </>
      ) : (
        <p>
          Firestore needs an index before it can load this page. The error did not include a link:
          deploy <code>firebase/firestore.indexes.json</code> with{' '}
          <code>npx firebase deploy --only firestore:indexes</code>, then reload.
        </p>
      )}
    </div>
  );
}
