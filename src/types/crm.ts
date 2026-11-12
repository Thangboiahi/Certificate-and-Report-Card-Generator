/**
 * Credential requests: the issuer's CRM pipeline (Phase 5). A request moves through four stages
 * on the Kanban board until the credential is issued and its claim link dispatched.
 */

export const REQUEST_STAGES = ['new', 'pending_data', 'ready', 'issued'] as const;
export type RequestStage = (typeof REQUEST_STAGES)[number];

export const STAGE_LABELS: Record<RequestStage, string> = {
  new: 'New Requests',
  pending_data: 'Pending User Data',
  ready: 'Ready to Issue',
  issued: 'Issued',
};

export interface CredentialRequest {
  id: string;
  stage: RequestStage;
  recipientName: string;
  /** What is being requested, e.g. the template's name. */
  credential: string;
  email?: string;
  phone?: string;
  /** Short note, e.g. which data is missing. */
  note?: string;
  /** Milliseconds since the epoch of the last change. */
  updatedAt: number;
}

/** A card moved on the board: where it came from and where it landed (0-based position). */
export interface RequestMove {
  id: string;
  from: RequestStage;
  to: RequestStage;
  toIndex: number;
}
