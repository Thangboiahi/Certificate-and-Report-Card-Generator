/**
 * What a public verification page tells a visitor about a credential. Pure, so the rule is tested
 * on its own: revoked beats expired beats unclaimed beats valid. "Unclaimed" is a pre-minted id
 * (ADR-035): the issuer recorded the credential and its holder has not claimed it yet.
 */

export type VerificationState = 'valid' | 'unclaimed' | 'expired' | 'revoked';

export function verificationState(
  credential: { status: 'valid' | 'revoked'; expiresAt: number | null; claimed?: boolean },
  now: number,
): VerificationState {
  if (credential.status === 'revoked') return 'revoked';
  if (credential.expiresAt !== null && credential.expiresAt < now) return 'expired';
  if (credential.claimed === false) return 'unclaimed';
  return 'valid';
}
