/**
 * Audit ledger of issued batches and the time-locked claim tokens behind their links (Phase 6,
 * ADR-026). Both collections are written and read only by server code.
 *
 *   issued_batches/{batchId}   one per dispatch: who, which template, how many, when, link expiry
 *   claim_tokens/{sha256}      one per recipient link: recipient, expiry, purge date, claimed?
 *
 * Raw tokens are never stored — only their SHA-256 — so a database leak exposes no working link.
 */
import type { DispatchChannel } from '@/lib/dispatch/request';

import type { TimestampLike } from './roles';

/** Most free re-issues of one batch. Re-issues cost no credits, so they must be bounded. */
export const MAX_REISSUES = 3;
/** Minimum time between two re-issues of the same batch (also absorbs double clicks). */
export const REISSUE_COOLDOWN_MS = 10 * 60_000;
/** Longest a claim link may stay valid. */
export const MAX_CLAIM_TTL_DAYS = 90;
/** Expired, unclaimed tokens (and the recipient data in them) are purged this long after expiry. */
export const CLAIM_RETENTION_DAYS = 30;

export type IssuedBatchStatus = 'sending' | 'completed' | 'reissuing' | 'failed';

/** `issued_batches/{id}` — the id equals the dispatch's id (`dispatches/{id}`). */
export interface IssuedBatchSchema {
  id: string;
  /** Who dispatched it. */
  issuerUid: string;
  templateId: string;
  recipientCount: number;
  /** Server time of the first dispatch. */
  dispatchedAt: TimestampLike;
  /** When the current claim links stop working (moves forward on re-issue). */
  tokenExpiry: TimestampLike;

  /** The owning institution, or `null` for a Micro-Issuer's personal batch. */
  institutionId: string | null;
  /** Template name at dispatch time, for the ledger. */
  templateName: string;
  channel: DispatchChannel;
  status: IssuedBatchStatus;
  /** Recipients whose latest message was accepted by the provider. */
  sentCount: number;
  failedCount: number;
  reissueCount: number;
  lastReissuedAt: TimestampLike | null;
  /** Outcome of the latest re-issue. */
  lastReissue: ReissueSummary<TimestampLike> | null;
  /** Set once the recipients' tokens were purged; re-issue is impossible after that. */
  purgedAt: TimestampLike | null;
}

export interface ReissueSummary<Time = number> {
  at: Time;
  byUid: string;
  /** Unclaimed recipients sent a fresh link. */
  recipients: number;
  sent: number;
  failed: number;
}

export type IssuedBatchDocument = Omit<IssuedBatchSchema, 'id'>;

/** `claim_tokens/{sha256(token)}`. */
export interface ClaimTokenDocument {
  batchId: string;
  institutionId: string | null;
  issuerUid: string;
  channel: DispatchChannel;
  recipientName: string;
  /** E.164 digits (WhatsApp) or a lower-case email address. */
  contact: string;
  expiresAt: TimestampLike;
  /** `expiresAt` + retention; the sweep deletes the token from then on. */
  purgeAfter: TimestampLike;
  /** Set when the recipient claims the credential (claim flow: later phase). */
  claimedAt: TimestampLike | null;
}

/** A batch as sent to the browser (times as epoch milliseconds). */
export interface IssuedBatchRow {
  id: string;
  issuerUid: string;
  templateId: string;
  templateName: string;
  channel: DispatchChannel;
  status: IssuedBatchStatus;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  reissueCount: number;
  dispatchedAt: number;
  tokenExpiry: number;
  lastReissuedAt: number | null;
  lastReissue: ReissueSummary | null;
  purgedAt: number | null;
}

/** Converts a stored batch for the browser. */
export function toBatchRow(batch: IssuedBatchSchema): IssuedBatchRow {
  return {
    id: batch.id,
    issuerUid: batch.issuerUid,
    templateId: batch.templateId,
    templateName: batch.templateName,
    channel: batch.channel,
    status: batch.status,
    recipientCount: batch.recipientCount,
    sentCount: batch.sentCount,
    failedCount: batch.failedCount,
    reissueCount: batch.reissueCount,
    dispatchedAt: batch.dispatchedAt.toMillis(),
    tokenExpiry: batch.tokenExpiry.toMillis(),
    lastReissuedAt: batch.lastReissuedAt?.toMillis() ?? null,
    lastReissue: batch.lastReissue
      ? { ...batch.lastReissue, at: batch.lastReissue.at.toMillis() }
      : null,
    purgedAt: batch.purgedAt?.toMillis() ?? null,
  };
}

export type ReissueBlock = 'purged' | 'limit' | 'cooldown' | 'busy' | 'failed' | null;

/**
 * Why a batch cannot be re-issued right now, or `null` when it can. Shared by the ledger (to
 * disable the button) and the server (which decides).
 */
export function reissueBlock(
  batch: Pick<IssuedBatchRow, 'status' | 'purgedAt' | 'reissueCount' | 'lastReissuedAt'>,
  now: number,
): ReissueBlock {
  if (batch.purgedAt !== null) return 'purged';
  if (batch.status === 'failed') return 'failed';
  if (batch.reissueCount >= MAX_REISSUES) return 'limit';
  if (batch.status !== 'completed') return 'busy';
  if (batch.lastReissuedAt !== null && now - batch.lastReissuedAt < REISSUE_COOLDOWN_MS) {
    return 'cooldown';
  }
  return null;
}
