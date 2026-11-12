'use client';

/**
 * The recipient's vault: a grid of the credentials they own, each with a "Generate Public Link"
 * button that turns on its public verification page (`/verify/{shareId}`) and a way to turn it off again
 * (old links then stop working). Ownership is enforced by the server (`POST /api/vault/share`,
 * ADR-027); this component only displays what the server listed and asks for changes.
 */
import {
  Award,
  BadgeCheck,
  Check,
  Copy,
  Link2,
  LinkIcon,
  LoaderCircle,
  ShieldAlert,
} from 'lucide-react';
import { useState } from 'react';

import type { VaultItemRow } from '@/lib/vault/vault';

const DATE = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
});

function shareUrl(shareId: string): string {
  return new URL(`/verify/${shareId}`, window.location.origin).toString();
}

async function requestShare(itemId: string, enabled: boolean): Promise<string | null> {
  const response = await fetch('/api/vault/share', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ itemId, enabled }),
  });
  const json = (await response.json().catch(() => null)) as {
    shareId?: string | null;
    error?: { message?: string };
  } | null;
  if (!response.ok || !json) {
    throw new Error(json?.error?.message ?? 'Something went wrong. Please try again.');
  }
  return json.shareId ?? null;
}

function VaultCard({ item }: { item: VaultItemRow }) {
  const [shareId, setShareId] = useState<string | null>(item.shareId);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [now] = useState(() => Date.now());
  const expired = item.expiresAt !== null && item.expiresAt < now;
  const revoked = item.status === 'revoked';

  async function toggle(enabled: boolean) {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setShareId(await requestShare(item.id, enabled));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function copy(id: string) {
    try {
      await navigator.clipboard.writeText(shareUrl(id));
      setCopied(true);
    } catch {
      setError('Could not copy. Select the link and copy it by hand.');
    }
  }

  return (
    <li
      className="flex flex-col gap-3 rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950"
      data-testid="vault-item"
      data-item-id={item.id}
    >
      <div className="flex items-start gap-3">
        <span className="rounded-xl bg-blue-50 p-2 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
          <Award className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-medium">{item.credentialName}</h2>
          <p className="truncate text-sm text-neutral-600 dark:text-neutral-400">
            {item.issuerName}
          </p>
        </div>
        {revoked ? (
          <span className="flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-800 dark:bg-red-950 dark:text-red-300">
            <ShieldAlert className="size-3" aria-hidden /> Revoked
          </span>
        ) : expired ? (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            Expired
          </span>
        ) : (
          <span className="flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-800 dark:bg-green-950 dark:text-green-300">
            <BadgeCheck className="size-3" aria-hidden /> Valid
          </span>
        )}
      </div>

      <p className="text-xs text-neutral-500">
        Issued {DATE.format(item.issuedAt)}
        {item.expiresAt &&
          ` · ${expired ? 'expired' : 'valid until'} ${DATE.format(item.expiresAt)}`}
      </p>

      {shareId ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={shareUrl(shareId)}
              aria-label="Public link"
              data-testid="vault-share-url"
              onFocus={(event) => event.currentTarget.select()}
              className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-neutral-50 px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-900"
            />
            <button
              type="button"
              onClick={() => void copy(shareId)}
              className="flex min-h-9 items-center gap-1 rounded-lg border border-neutral-300 px-3 text-xs font-medium dark:border-neutral-700"
            >
              {copied ? (
                <Check className="size-4" aria-hidden />
              ) : (
                <Copy className="size-4" aria-hidden />
              )}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void toggle(false)}
            className="flex min-h-9 items-center justify-center gap-1 self-start text-xs text-neutral-600 underline underline-offset-2 disabled:opacity-50 dark:text-neutral-400"
          >
            <Link2 className="size-3.5" aria-hidden /> Stop sharing (the link will stop working)
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void toggle(true)}
          data-testid="vault-share"
          className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
          ) : (
            <LinkIcon className="size-4" aria-hidden />
          )}
          Generate Public Link
        </button>
      )}

      {error && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </li>
  );
}

export function VaultDashboard({ items }: { items: VaultItemRow[] }) {
  if (items.length === 0) {
    return (
      <div
        className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-neutral-300 px-6 py-12 text-center dark:border-neutral-700"
        data-testid="vault-empty"
      >
        <Award className="size-8 text-neutral-300 dark:text-neutral-600" aria-hidden />
        <p className="font-medium">Your vault is empty</p>
        <p className="max-w-xs text-sm text-neutral-500">
          Certificates issued to you will appear here, ready to share with a public link.
        </p>
      </div>
    );
  }
  return (
    <ul className="grid gap-4 sm:grid-cols-2" data-testid="vault-grid">
      {items.map((item) => (
        <VaultCard key={item.id} item={item} />
      ))}
    </ul>
  );
}
