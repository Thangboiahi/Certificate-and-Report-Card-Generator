import { BadgeCheck, Clock, FileCheck2, ShieldAlert } from 'lucide-react';

import { AddToLinkedIn } from '@/components/verify/AddToLinkedIn';
import type { VerificationState } from '@/lib/vault/verification';
import type { SharedCredential } from '@/lib/vault/vault';
import { cn } from '@/lib/utils/cn';

const DATE = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
});

/**
 * What a visitor sees after scanning a credential's QR code or opening its link: a clear verdict,
 * the facts the issuer recorded, a preview of the certificate, and, only for a valid credential,
 * the "Add to LinkedIn" button. Presentational: the page decides the state.
 */
export function VerificationResult({
  credential,
  state,
}: {
  credential: SharedCredential;
  state: VerificationState;
}) {
  const valid = state === 'valid';
  return (
    <div className="flex flex-col gap-5" data-testid="verification" data-state={state}>
      {state === 'valid' && (
        <div
          role="status"
          data-testid="verdict"
          className="flex items-center gap-3 rounded-2xl bg-green-50 p-4 text-green-900 dark:bg-green-950 dark:text-green-100"
        >
          <BadgeCheck className="size-8 shrink-0 text-green-600" aria-hidden />
          <div>
            <p className="text-lg font-bold">Verified</p>
            <p className="text-sm">The issuer’s record matches this credential.</p>
          </div>
        </div>
      )}
      {state === 'unclaimed' && (
        <div
          role="status"
          data-testid="verdict"
          className="flex items-start gap-3 rounded-2xl bg-sky-50 p-4 text-sky-950 dark:bg-sky-950 dark:text-sky-100"
        >
          <FileCheck2 className="mt-0.5 size-8 shrink-0 text-sky-600" aria-hidden />
          <div>
            <p className="text-lg font-bold">Issued, not yet claimed</p>
            <p className="text-sm">
              {credential.issuerName} recorded issuing this credential. Its holder has not added it
              to their vault yet, so there is nothing more to check.
            </p>
          </div>
        </div>
      )}
      {state === 'revoked' && (
        <div
          role="alert"
          data-testid="verdict"
          className="flex items-start gap-3 rounded-2xl border-2 border-red-600 bg-red-50 p-4 text-red-900 dark:bg-red-950 dark:text-red-100"
        >
          <ShieldAlert className="mt-0.5 size-8 shrink-0 text-red-600" aria-hidden />
          <div>
            <p className="text-lg font-extrabold tracking-wide">INVALID / REVOKED</p>
            <p className="text-sm">
              {credential.issuerName} has revoked this credential
              {credential.revokedAt ? ` on ${DATE.format(credential.revokedAt)}` : ''}. Do not rely
              on it. Contact {credential.issuerName} to confirm its status.
            </p>
          </div>
        </div>
      )}
      {state === 'expired' && (
        <div
          role="alert"
          data-testid="verdict"
          className="flex items-start gap-3 rounded-2xl border-2 border-amber-500 bg-amber-50 p-4 text-amber-950 dark:bg-amber-950 dark:text-amber-100"
        >
          <Clock className="mt-0.5 size-8 shrink-0 text-amber-600" aria-hidden />
          <div>
            <p className="text-lg font-bold">EXPIRED</p>
            <p className="text-sm">
              This credential was genuine but ran out on {DATE.format(credential.expiresAt!)}.
              Contact {credential.issuerName} for a current one.
            </p>
          </div>
        </div>
      )}

      <CertificatePreview credential={credential} state={state} />

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm" data-testid="metadata">
        <dt className="text-neutral-500">Issuer</dt>
        <dd className="font-medium">
          {credential.issuerName}
          {credential.issuerVerified && (
            <span className="ml-2 rounded-full bg-green-100 px-2 py-0.5 text-xs font-normal text-green-800 dark:bg-green-900 dark:text-green-200">
              Verified institution
            </span>
          )}
        </dd>
        <dt className="text-neutral-500">Recipient</dt>
        <dd className="font-medium">{credential.recipientName ?? 'Not shown by the issuer'}</dd>
        <dt className="text-neutral-500">{state === 'unclaimed' ? 'Recorded' : 'Issued'}</dt>
        <dd className="font-medium">{DATE.format(credential.issuedAt)}</dd>
        {credential.expiresAt && (
          <>
            <dt className="text-neutral-500">{state === 'expired' ? 'Expired' : 'Valid until'}</dt>
            <dd className="font-medium">{DATE.format(credential.expiresAt)}</dd>
          </>
        )}
      </dl>

      {valid && (
        <AddToLinkedIn
          name={credential.credentialName}
          organizationName={credential.issuerName}
          issuedAt={credential.issuedAt}
          expiresAt={credential.expiresAt}
        />
      )}
    </div>
  );
}

/**
 * A certificate-style summary of the facts above. It is drawn from the issuer's record, not a copy
 * of the issued PDF (the platform does not keep the PDFs), and a revoked credential is stamped.
 */
function CertificatePreview({
  credential,
  state,
}: {
  credential: SharedCredential;
  state: VerificationState;
}) {
  return (
    <figure
      data-testid="certificate-preview"
      aria-label={`Preview of ${credential.credentialName}`}
      className={cn(
        'relative overflow-hidden rounded-2xl border-4 border-double p-6 text-center',
        state === 'valid' || state === 'unclaimed'
          ? 'border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-950'
          : 'border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900',
      )}
    >
      <p className="text-[11px] tracking-[0.25em] text-neutral-500 uppercase">
        Certificate issued by
      </p>
      <p className="mt-1 text-base font-semibold">{credential.issuerName}</p>
      <div className="mx-auto my-4 h-px w-16 bg-neutral-300 dark:bg-neutral-700" />
      <figcaption className="text-2xl leading-snug font-semibold tracking-tight">
        {credential.credentialName}
      </figcaption>
      {credential.recipientName && (
        <>
          <p className="mt-4 text-xs text-neutral-500">awarded to</p>
          <p className="text-xl font-medium">{credential.recipientName}</p>
        </>
      )}
      <p className="mt-4 text-xs text-neutral-500">{DATE.format(credential.issuedAt)}</p>
      {(state === 'revoked' || state === 'expired') && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 flex items-center justify-center text-5xl font-black tracking-widest uppercase opacity-25 -rotate-12 select-none',
            state === 'revoked' ? 'text-red-600' : 'text-amber-600',
          )}
        >
          {state === 'revoked' ? 'Revoked' : 'Expired'}
        </span>
      )}
    </figure>
  );
}
