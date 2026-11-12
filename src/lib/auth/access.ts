/**
 * Pure RBAC logic: turning verified token claims into a role, and deciding what a role may reach.
 *
 * No Firebase, Node or browser APIs — the proxy, server components, route handlers and tests all
 * share these exact decisions. Verification of the token itself happens elsewhere
 * (`customClaims.ts`); everything here assumes its input was verified.
 */
import {
  CLAIM_INSTITUTION,
  CLAIM_ROLE,
  type ElevatedRole,
  type RoleClaims,
  type SessionUser,
} from '@/types/roles';

/** Institution ids are kept to a conservative alphabet: they appear in claims, paths and rules. */
const INSTITUTION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidInstitutionId(value: unknown): value is string {
  return typeof value === 'string' && INSTITUTION_ID.test(value);
}

/**
 * Reads this app's role claims out of a user's custom claims. Anything malformed — an unknown
 * role, an institution role without a valid institution — counts as no elevated role.
 */
export function parseRoleClaims(
  claims: Readonly<Record<string, unknown>> | null | undefined,
): RoleClaims | null {
  const role = claims?.[CLAIM_ROLE];
  if (role === 'super_admin') return { role };
  if (role === 'inst_admin' || role === 'inst_staff') {
    const institutionId = claims?.[CLAIM_INSTITUTION];
    return isValidInstitutionId(institutionId) ? { role, institutionId } : null;
  }
  return null;
}

export function sameRoleClaims(a: RoleClaims | null, b: RoleClaims | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.role !== b.role) return false;
  return a.role === 'super_admin' || a.institutionId === (b as typeof a).institutionId;
}

/**
 * True when moving from `previous` to `next` takes any access away. The only change that does
 * not is promotion from staff to admin within the same institution.
 */
export function privilegesReduced(previous: RoleClaims | null, next: RoleClaims | null): boolean {
  if (previous === null || sameRoleClaims(previous, next)) return false;
  const promotedInPlace =
    previous.role === 'inst_staff' &&
    next?.role === 'inst_admin' &&
    next.institutionId === previous.institutionId;
  return !promotedInPlace;
}

/**
 * The full custom-claims object to store: this app's keys replaced by `next`, every other claim
 * on the user kept as it was (`setCustomUserClaims` overwrites the whole object).
 */
export function mergeRoleClaims(
  existing: Readonly<Record<string, unknown>> | null | undefined,
  next: RoleClaims | null,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  delete merged[CLAIM_ROLE];
  delete merged[CLAIM_INSTITUTION];
  if (next) {
    merged[CLAIM_ROLE] = next.role;
    if (next.role !== 'super_admin') merged[CLAIM_INSTITUTION] = next.institutionId;
  }
  return merged;
}

/**
 * The subset of a verified Firebase ID token or session cookie this module reads. Custom claims
 * appear as top-level fields.
 */
export interface VerifiedClaims {
  uid: string;
  email?: string;
  firebase?: { sign_in_provider?: string };
  [claim: string]: unknown;
}

/** Derives who the request comes from. Anonymous Firebase users are guests. */
export function toSessionUser(claims: VerifiedClaims): SessionUser {
  const email = typeof claims.email === 'string' ? claims.email : null;
  if (claims.firebase?.sign_in_provider === 'anonymous') {
    return { uid: claims.uid, email, role: 'guest', institutionId: null };
  }
  const roleClaims = parseRoleClaims(claims);
  if (!roleClaims) return { uid: claims.uid, email, role: 'individual', institutionId: null };
  return {
    uid: claims.uid,
    email,
    role: roleClaims.role,
    institutionId: roleClaims.role === 'super_admin' ? null : roleClaims.institutionId,
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Route access
// ───────────────────────────────────────────────────────────────────────────────────────────────

export type RouteAccess =
  | { kind: 'public' }
  /** Any non-anonymous signed-in user. */
  | { kind: 'signed-in' }
  /** Only these elevated roles. */
  | { kind: 'roles'; roles: readonly ElevatedRole[] };

export interface RouteRule {
  /** Matches this path and everything below it (segment-aware: `/admin` does not match `/administer`). */
  prefix: string;
  access: RouteAccess;
}

/**
 * The route map. Most specific prefixes first; the first match wins. Paths not listed are not
 * gated here (they are public pages or API routes with their own checks). Anything under
 * `/dashboard` not listed more specifically requires sign-in, so new dashboard pages are never
 * accidentally public.
 */
export const ROUTE_RULES: readonly RouteRule[] = [
  { prefix: '/admin', access: { kind: 'roles', roles: ['super_admin'] } },
  {
    prefix: '/dashboard/institution',
    access: { kind: 'roles', roles: ['inst_admin', 'inst_staff'] },
  },
  { prefix: '/dashboard/vault', access: { kind: 'signed-in' } },
  // Micro-Issuer tools: any signed-in person may issue under their own name.
  { prefix: '/dashboard/issue', access: { kind: 'signed-in' } },
  { prefix: '/dashboard', access: { kind: 'signed-in' } },
  { prefix: '/editor', access: { kind: 'public' } },
];

/**
 * Canonical form of a request path for matching: percent-decoded (so `/%61dmin` is `/admin`),
 * lower-cased, duplicate slashes collapsed, trailing slash removed. Matching on this form can
 * only make more paths match a rule, never fewer, whatever normalisation the router applies.
 * Returns `null` for paths that cannot be decoded.
 */
export function canonicalPath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const collapsed = decoded.toLowerCase().replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
}

/** A rule that denies everything, for paths that cannot even be decoded. */
const MALFORMED_PATH_RULE: RouteRule = { prefix: '/', access: { kind: 'roles', roles: [] } };

/** The access rule for a path, or `null` when no rule applies. */
export function ruleForPath(
  pathname: string,
  rules: readonly RouteRule[] = ROUTE_RULES,
): RouteRule | null {
  const path = canonicalPath(pathname);
  if (path === null) return MALFORMED_PATH_RULE;
  return rules.find((rule) => path === rule.prefix || path.startsWith(`${rule.prefix}/`)) ?? null;
}

export type AccessDecision = 'allow' | 'unauthenticated' | 'forbidden';

export function evaluateAccess(access: RouteAccess, user: SessionUser | null): AccessDecision {
  if (access.kind === 'public') return 'allow';
  if (!user || user.role === 'guest') return 'unauthenticated';
  if (access.kind === 'signed-in') return 'allow';
  return (access.roles as readonly string[]).includes(user.role) ? 'allow' : 'forbidden';
}

/**
 * Whether verification must also check that the session was not revoked. Revocation checks cost
 * a call to Firebase Auth, so they are reserved for privileged areas; a demoted admin loses
 * access there immediately, not when their session cookie expires.
 */
export function requiresRevocationCheck(access: RouteAccess): boolean {
  return access.kind === 'roles';
}

/**
 * Validates a post-login return path from a query string, so `?next=` cannot be used to send
 * people to another site. Returns `fallback` for anything that is not a same-origin path.
 */
export function safeReturnPath(
  next: string | null | undefined,
  fallback = '/dashboard/vault',
): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\'))
    return fallback;
  if (/[\u0000-\u001F\u007F]/.test(next)) return fallback;
  return next;
}
