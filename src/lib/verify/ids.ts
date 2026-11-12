/**
 * Verification ids (ADR-035): the unguessable id in `/verify/{id}`, printed in a document's QR code
 * before the document reaches its recipient. Shared by the server (which mints them) and the browser
 * (which puts them on the rows it generates). No I/O, no secrets.
 */

/** The id is 256 random bits, base64url: the same format as claim tokens and share ids. */
export const VERIFICATION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Row columns that carry the verification id and its full address into the PDF. A QR placeholder
 * whose binding is the template `{{verification_url}}` prints the address; `{{verification_id}}`
 * is there for a text placeholder that shows the id as well.
 */
export const VERIFY_URL_COLUMN = 'verification_url';
export const VERIFY_ID_COLUMN = 'verification_id';

/** The QR placeholder binding that prints the verification address. */
export const VERIFY_QR_TEMPLATE = `{{${VERIFY_URL_COLUMN}}}`;

export function verifyUrl(origin: string, id: string): string {
  return new URL(`/verify/${id}`, origin).toString();
}
