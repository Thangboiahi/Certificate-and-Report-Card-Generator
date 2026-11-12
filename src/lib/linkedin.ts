/**
 * "Add to LinkedIn Profile": the standard LinkedIn URL that opens the "Add licence or certification"
 * form with the fields filled in. Nothing is sent to LinkedIn by us: the person's browser opens the
 * link and they confirm on LinkedIn.
 *
 * Parameters (LinkedIn's documented Add-to-Profile contract): `startTask=CERTIFICATION_NAME`, `name`,
 * `organizationName`, `issueYear`, `issueMonth` (1–12), `expirationYear`, `expirationMonth`,
 * `certUrl`. The recipient's name is not a parameter: LinkedIn adds the certificate to whoever is
 * signed in.
 */

const ENDPOINT = 'https://www.linkedin.com/profile/add';
/** LinkedIn truncates long names; keep ours inside what the form accepts (it allows 100). */
const MAX_NAME = 100;

export interface LinkedInCertification {
  /** The credential's name, e.g. "Class 10 certificate". */
  name: string;
  /** Who issued it. */
  organizationName: string;
  /** Epoch milliseconds. */
  issuedAt: number;
  /** Epoch milliseconds, or `null` if it does not expire. */
  expiresAt?: number | null;
  /** Absolute URL where anyone can verify the credential. */
  certUrl: string;
}

/** Year and month in India time, the zone issue dates are shown in. */
function yearMonth(millis: number): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).formatToParts(millis);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: pick('year'), month: pick('month') };
}

export function linkedInAddUrl(certification: LinkedInCertification): string {
  const issued = yearMonth(certification.issuedAt);
  const params = new URLSearchParams({
    startTask: 'CERTIFICATION_NAME',
    name: certification.name.slice(0, MAX_NAME),
    organizationName: certification.organizationName.slice(0, MAX_NAME),
    issueYear: String(issued.year),
    issueMonth: String(issued.month),
  });
  if (certification.expiresAt != null) {
    const expires = yearMonth(certification.expiresAt);
    params.set('expirationYear', String(expires.year));
    params.set('expirationMonth', String(expires.month));
  }
  params.set('certUrl', certification.certUrl);
  return `${ENDPOINT}?${params.toString()}`;
}
