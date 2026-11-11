/**
 * Read the EXIF orientation of a JPEG.
 *
 * Phone cameras usually store the sensor image unrotated and record how to turn it in an EXIF
 * tag. Browsers honour the tag; pdf-lib does not, so a portrait photo taken on a phone would land
 * sideways on an ID card. The engine reads the tag here and applies the rotation itself.
 *
 * No Node or browser APIs — safe to import anywhere.
 */

/**
 * EXIF orientation values. 1 is "as stored". 3 is upside down; 6 and 8 are the two quarter turns
 * that portrait phone photos use. 2, 4, 5 and 7 are the mirrored variants (rare — mostly from
 * front cameras and scanners).
 */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const MARKER_APP1 = 0xe1;
const MARKER_SOS = 0xda;
const MARKER_EOI = 0xd9;
const TAG_ORIENTATION = 0x0112;

/** True when the orientation swaps width and height (a quarter turn in either direction). */
export function orientationSwapsAxes(orientation: ExifOrientation): boolean {
  return orientation >= 5;
}

/**
 * Returns the EXIF orientation of a JPEG, or 1 when there is none or the data is malformed.
 * Never throws: a broken EXIF block must not stop a photo from being used.
 */
export function readJpegOrientation(bytes: Uint8Array): ExifOrientation {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;

  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return 1;
    const marker = view.getUint8(offset + 1);

    // Padding bytes before a marker are legal.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Image data starts: any EXIF block would have come before this.
    if (marker === MARKER_SOS || marker === MARKER_EOI) return 1;

    const segmentLength = view.getUint16(offset + 2);
    if (segmentLength < 2) return 1;
    const segmentStart = offset + 4;
    const segmentEnd = offset + 2 + segmentLength;
    if (segmentEnd > view.byteLength) return 1;

    if (marker === MARKER_APP1) {
      const orientation = readOrientationFromExifSegment(view, segmentStart, segmentEnd);
      if (orientation !== null) return orientation;
      // An APP1 segment can also hold XMP; keep looking.
    }
    offset = segmentEnd;
  }
  return 1;
}

function readOrientationFromExifSegment(
  view: DataView,
  start: number,
  end: number,
): ExifOrientation | null {
  // "Exif\0\0" followed by a TIFF header.
  if (end - start < 14) return null;
  const isExif = view.getUint32(start) === 0x45786966 && view.getUint16(start + 4) === 0x0000; // "Exif", NUL NUL
  if (!isExif) return null;

  const tiff = start + 6;
  const byteOrder = view.getUint16(tiff);
  let littleEndian: boolean;
  if (byteOrder === 0x4949) littleEndian = true;
  else if (byteOrder === 0x4d4d) littleEndian = false;
  else return null;
  if (view.getUint16(tiff + 2, littleEndian) !== 0x002a) return null;

  const ifd = tiff + view.getUint32(tiff + 4, littleEndian);
  if (ifd + 2 > end) return null;
  const entryCount = view.getUint16(ifd, littleEndian);

  for (let index = 0; index < entryCount; index++) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) return null;
    if (view.getUint16(entry, littleEndian) !== TAG_ORIENTATION) continue;

    const value = view.getUint16(entry + 8, littleEndian);
    return value >= 1 && value <= 8 ? (value as ExifOrientation) : null;
  }
  return null;
}
