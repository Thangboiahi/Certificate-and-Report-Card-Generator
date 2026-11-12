/**
 * V6 roles and the core records of the credential platform.
 *
 * Who someone is — their `UserRole` — is never stored in Firestore documents. It is derived on
 * every request from a verified Firebase token: anonymous or absent → `guest`, signed in →
 * `individual`, and the elevated roles come from Firebase custom claims, which only server code
 * holding the Admin SDK can set (`src/lib/auth/customClaims.ts`).
 *
 * The claim names below are part of a contract shared with `firebase/firestore.rules`.
 * Changing them requires changing the rules in the same commit.
 */

/** Everyone who can reach the app. A Micro-Issuer is an `individual` issuing under their own UID. */
export type UserRole = 'guest' | 'individual' | 'inst_staff' | 'inst_admin' | 'super_admin';

/** Roles that only the server can grant (carried as custom claims). */
export type ElevatedRole = Extract<UserRole, 'inst_staff' | 'inst_admin' | 'super_admin'>;

/** Roles that belong to one institution. */
export type InstitutionRole = Extract<UserRole, 'inst_staff' | 'inst_admin'>;

export const ELEVATED_ROLES = [
  'super_admin',
  'inst_admin',
  'inst_staff',
] as const satisfies readonly ElevatedRole[];

export const INSTITUTION_ROLES = [
  'inst_admin',
  'inst_staff',
] as const satisfies readonly InstitutionRole[];

/** Custom-claim key holding the elevated role. Mirrored in firestore.rules. */
export const CLAIM_ROLE = 'role';
/** Custom-claim key holding the institution of an `inst_*` role. Mirrored in firestore.rules. */
export const CLAIM_INSTITUTION = 'institutionId';

/**
 * The custom claims this app manages on a Firebase user. A user holds at most one elevated role,
 * and an institution role is always tied to exactly one institution.
 */
export type RoleClaims = { role: 'super_admin' } | { role: InstitutionRole; institutionId: string };

/** A role change: an elevated role, or `individual` to remove any elevated role. */
export type RoleAssignment = RoleClaims | { role: 'individual' };

/** The person behind a request, after their token has been verified on the server. */
export interface SessionUser {
  uid: string;
  email: string | null;
  role: UserRole;
  /** Set exactly when `role` is `inst_admin` or `inst_staff`. */
  institutionId: string | null;
  /** E.164 (`+919876543210`) when the account signed in with a phone number. */
  phoneNumber?: string | null;
  /** True when Firebase has verified `email` (always true after an email-link sign-in). */
  emailVerified?: boolean;
}

/**
 * A Firestore timestamp. Written structurally so that both the client SDK's and the Admin SDK's
 * `Timestamp` classes satisfy it.
 */
export interface TimestampLike {
  seconds: number;
  nanoseconds: number;
  toMillis(): number;
}

/** Firestore collection names. Mirrored in firestore.rules. */
export const COLLECTIONS = {
  institutions: 'institutions',
  templates: 'templates',
  vaultItems: 'vault_items',
  /** Dispatch records (credit ledger for WhatsApp / email sends). Server-only. */
  dispatches: 'dispatches',
  /** One per dispatched batch: the audit ledger (Phase 6). Server-only. */
  issuedBatches: 'issued_batches',
  /** One per claim link, keyed by the token's SHA-256. Holds the recipient until purged. Server-only. */
  claimTokens: 'claim_tokens',
  /** Razorpay orders for claim fees (Phase 7). Server-only. */
  claimOrders: 'claim_orders',
} as const;

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Institutions — `institutions/{id}`
// ───────────────────────────────────────────────────────────────────────────────────────────────

export interface InstitutionSchema {
  /** The document id. Not stored inside the document. */
  id: string;
  name: string;
  /** The institution's single admin; `null` until one is assigned. */
  adminUid: string | null;
  /** Staff members. The admin is not listed here. */
  staffUids: string[];
  /** Issuance credits left. Changed only by server code and super admins. */
  creditBalance: number;
  /** Set by a super admin after the institution's identity has been checked. */
  verified: boolean;
}

export type InstitutionDocument = Omit<InstitutionSchema, 'id'>;

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Vault items — `vault_items/{id}`: one issued credential, held in its owner's vault
// ───────────────────────────────────────────────────────────────────────────────────────────────

export type VaultItemStatus = 'valid' | 'revoked';

/**
 * Who issued a credential. Stored explicitly because `issuerId` alone cannot say whether it is an
 * institution id or a Micro-Issuer's UID.
 */
export type IssuerType = 'institution' | 'individual';

export interface VaultItemSchema {
  /** The document id. Not stored inside the document. */
  id: string;
  /** The recipient: the only person (besides the issuer) who can read it. */
  ownerUid: string;
  templateId: string;
  /** An institution id (`issuerType: 'institution'`) or a Micro-Issuer's UID (`'individual'`). */
  issuerId: string;
  issuerType: IssuerType;
  /** Set to the server's time on creation; cannot be backdated. */
  issuedAt: TimestampLike;
  /** `null` for credentials that never expire. */
  expiresAt: TimestampLike | null;
  /** Revocation is one-way: `valid` → `revoked`. */
  status: VaultItemStatus;
  /** `null` until revoked; then the server's time of revocation. */
  revokedAt: TimestampLike | null;

  // Set when the credential was claimed through a claim link (Phase 7, ADR-027). Optional: items
  // created directly by an issuer may lack them.
  /** What the credential is, e.g. the template's name. */
  credentialName?: string;
  /** The issuing institution's (or Micro-Issuer's) display name at claim time. */
  issuerName?: string;
  /** The recipient's name as the issuer wrote it. */
  recipientName?: string;
  /** The issued batch the claim link came from. */
  batchId?: string;
  /** Unguessable id of the public verification page (`/v/{shareId}`), or `null` when not shared. */
  shareId?: string | null;
}

export type VaultItemDocument = Omit<VaultItemSchema, 'id'>;
