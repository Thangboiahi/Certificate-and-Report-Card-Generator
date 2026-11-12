'use client';

/**
 * Last line of defence: a promise that rejects or an event handler that throws somewhere nobody
 * caught shows a toast instead of failing silently. Renders nothing. Components that know what
 * went wrong should still catch and call `notifyError` with a specific message.
 */
import { useEffect } from 'react';

import { notifyError } from '@/lib/ui/notify';

export function GlobalErrorToasts() {
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      console.error('Unhandled rejection', event.reason);
      notifyError(event.reason);
    };
    const onError = (event: ErrorEvent) => {
      // Resource-load failures and cross-origin "Script error." carry nothing to act on.
      if (!event.error) return;
      console.error('Uncaught error', event.error);
      notifyError(event.error);
    };
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('error', onError);
    };
  }, []);
  return null;
}
