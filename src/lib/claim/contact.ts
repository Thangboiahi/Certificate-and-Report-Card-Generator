/**
 * Recipient contacts: normalising phone numbers, masking contacts for display, and checking that
 * the signed-in person is the one a claim link was sent to (ADR-027). Pure; shared by server and
 * browser.
 */
import type { SessionUser } from '@/types/roles';

export type ContactChannel = 'whatsapp' | 'email';

/**
 * Normalises an Indian or international mobile number to the digits WhatsApp expects (country
 * code, no `+`). A 10-digit Indian mobile number (starting 6–9) gets `91`. Returns `null` when the
 * value cannot be a mobile number.
 */
export function normalizePhone(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  let digits = trimmed.replace(/\D/g, '');
  if (!trimmed.startsWith('+')) {
    if (/^0[6-9]\d{9}$/.test(digits)) digits = digits.slice(1);
    if (/^[6-9]\d{9}$/.test(digits)) digits = `91${digits}`;
  }
  if (digits.startsWith('91') && !/^91[6-9]\d{9}$/.test(digits)) return null;
  // Country code + subscriber number: 11–15 digits (a bare 10-digit number must be Indian).
  return /^[1-9]\d{10,14}$/.test(digits) ? digits : null;
}

/** E.164 with a plus sign, e.g. `+919876543210`, or `null`. */
export function toE164(value: string): string | null {
  const digits = normalizePhone(value);
  return digits ? `+${digits}` : null;
}

/**
 * Shows enough of a contact for the recipient to recognise it, and no more:
 * `+91 ••••••3210`, `a•••@example.in`.
 */
export function maskContact(channel: ContactChannel, contact: string): string {
  if (channel === 'whatsapp') {
    const country = contact.startsWith('91') ? '91' : contact.slice(0, contact.length - 10);
    return `+${country} ••••••${contact.slice(-4)}`;
  }
  const [local = '', domain = ''] = contact.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
}

/**
 * True when the signed-in account proves possession of the contact the link was sent to: the
 * same phone number (verified by OTP), or the same email address verified by Firebase (an
 * email-link sign-in verifies it).
 */
export function contactMatches(
  channel: ContactChannel,
  contact: string,
  user: Pick<SessionUser, 'email' | 'phoneNumber' | 'emailVerified'>,
): boolean {
  if (channel === 'whatsapp') return user.phoneNumber === `+${contact}`;
  return user.emailVerified === true && user.email?.trim().toLowerCase() === contact;
}
