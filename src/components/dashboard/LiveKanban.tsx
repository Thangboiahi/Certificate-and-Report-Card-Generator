'use client';

/**
 * The Kanban board wired to the database (Phase 12, ADR-033). The server hands over the first
 * snapshot; from then on this component
 *
 *   - saves every drag through `PATCH /api/requests` (the board rolls the card back if that fails),
 *   - adds requests through `POST /api/requests`,
 *   - re-reads the board every few seconds and when the tab regains focus, so colleagues' changes
 *     appear without a reload. It never replaces the board while a card is being dragged or saved.
 *
 * The browser holds no Firebase session (ADR-027), so there is no direct Firestore listener: the
 * server is the only reader and writer.
 */
import { ClipboardList, LoaderCircle, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { KanbanBoard } from '@/components/dashboard/KanbanBoard';
import { errorMessage, notifyError, notifySuccess, readApiError } from '@/lib/ui/notify';
import type { CredentialRequest, RequestMove } from '@/types/crm';

const POLL_MS = 15_000;

export interface LiveKanbanProps {
  initialRequests: readonly CredentialRequest[];
  renderedAt: number;
}

/** Same cards in the same places? (Cheap and exact: the board is a few hundred small objects.) */
function sameBoard(a: readonly CredentialRequest[], b: readonly CredentialRequest[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function LiveKanban({ initialRequests, renderedAt }: LiveKanbanProps) {
  const [requests, setRequests] = useState<readonly CredentialRequest[]>(initialRequests);
  // Bumped when the cards change from outside the board, to rebuild it from `requests`.
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const [stale, setStale] = useState(false);
  const busy = useRef(false);
  const current = useRef(requests);
  useEffect(() => {
    current.current = requests;
  }, [requests]);

  const refresh = useCallback(async () => {
    if (busy.current || document.visibilityState === 'hidden') return;
    try {
      const response = await fetch('/api/requests', { cache: 'no-store' });
      if (!response.ok) throw await readApiError(response);
      const { requests: fresh } = (await response.json()) as { requests: CredentialRequest[] };
      setStale(false);
      // The board may have been lifted again while this was in flight.
      if (busy.current || sameBoard(current.current, fresh)) return;
      setRequests(fresh);
      setVersion((v) => v + 1);
    } catch {
      setStale(true);
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const onVisible = () => void refresh();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refresh]);

  async function saveMove(move: RequestMove) {
    const response = await fetch('/api/requests', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: move.id, to: move.to, toIndex: move.toIndex }),
    });
    if (!response.ok) {
      const cause = await readApiError(response);
      notifyError(cause, 'That move could not be saved.');
      throw cause;
    }
  }

  function added(request: CredentialRequest) {
    setRequests((cards) => [request, ...cards]);
    setVersion((v) => v + 1);
    setAdding(false);
    notifySuccess(`Added ${request.recipientName}.`);
  }

  return (
    <div className="flex flex-col gap-3" data-testid="live-kanban">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setAdding((open) => !open)}
          aria-expanded={adding}
          data-testid="add-request"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-neutral-300 px-4 text-sm font-medium hover:border-neutral-500 dark:border-neutral-700"
        >
          <Plus className="size-4" aria-hidden /> Add request
        </button>
        {stale && (
          <span role="status" className="text-xs text-amber-700 dark:text-amber-400">
            Live updates paused. Retrying…
          </span>
        )}
      </div>
      {adding && <NewRequestForm onAdded={added} onCancel={() => setAdding(false)} />}
      {requests.length === 0 ? (
        <div
          data-testid="kanban-empty"
          className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-neutral-300 px-6 py-12 text-center dark:border-neutral-700"
        >
          <ClipboardList className="size-8 text-neutral-300 dark:text-neutral-600" aria-hidden />
          <p className="font-medium">No active requests</p>
          <p className="max-w-xs text-sm text-neutral-500">
            New credential requests will appear here. Add one to start your pipeline.
          </p>
        </div>
      ) : (
        <KanbanBoard
          key={version}
          initialRequests={requests}
          renderedAt={renderedAt}
          onMove={saveMove}
          onBusyChange={(value) => {
            busy.current = value;
          }}
        />
      )}
    </div>
  );
}

function NewRequestForm({
  onAdded,
  onCancel,
}: {
  onAdded(request: CredentialRequest): void;
  onCancel(): void;
}) {
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string) => String(form.get(name) ?? '').trim();
    setSaving(true);
    setProblem(null);
    try {
      const response = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          recipientName: field('recipientName'),
          credential: field('credential'),
          email: field('email'),
          phone: field('phone'),
          note: field('note'),
        }),
      });
      if (!response.ok) throw await readApiError(response);
      onAdded(((await response.json()) as { request: CredentialRequest }).request);
    } catch (cause) {
      setProblem(errorMessage(cause, 'The request could not be added.'));
    } finally {
      setSaving(false);
    }
  }

  const input =
    'min-h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-900';
  return (
    <form
      onSubmit={submit}
      data-testid="new-request-form"
      className="grid gap-3 rounded-2xl border border-neutral-200 p-4 sm:grid-cols-2 dark:border-neutral-800"
    >
      <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
        Recipient name
        <input name="recipientName" required maxLength={120} className={input} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
        Credential
        <input
          name="credential"
          required
          maxLength={120}
          placeholder="e.g. Class 10 certificate"
          className={input}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
        Phone (WhatsApp)
        <input name="phone" type="tel" maxLength={20} className={input} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
        Email
        <input name="email" type="email" maxLength={254} className={input} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-neutral-600 sm:col-span-2 dark:text-neutral-400">
        Note (optional)
        <input name="note" maxLength={200} className={input} />
      </label>
      {problem && (
        <p role="alert" className="text-sm text-red-700 sm:col-span-2 dark:text-red-400">
          {problem}
        </p>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <button
          type="submit"
          disabled={saving}
          data-testid="new-request-submit"
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {saving && <LoaderCircle className="size-4 animate-spin" aria-hidden />} Add to New
          Requests
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="min-h-11 rounded-xl px-4 text-sm text-neutral-600 hover:underline dark:text-neutral-400"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
