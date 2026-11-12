/**
 * What a public verification page tells a visitor about a credential. Pure, so the rule is tested
 * on its own: revoked beats expired beats valid.
 */

export type VerificationState = 'valid' | 'expired' | 'revoked';

export function verificationState(
  credential: { status: 'valid' | 'revoked'; expiresAt: number | null },
  now: number,
): VerificationState {
  if (credential.status === 'revoked') return 'revoked';
  if (credential.expiresAt !== null && credential.expiresAt < now) return 'expired';
  return 'valid';
}
