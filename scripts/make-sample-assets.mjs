/**
 * Builds the sample template used by the developer playground:
 *
 *     node scripts/make-sample-assets.mjs
 *
 * Output: public/samples/template.pdf — page 1 is a landscape certificate, page 2 a portrait
 * progress report. It contains only the fixed artwork; everything personal is added by the
 * engine from the placeholders declared in src/app/playground/sample.ts. Coordinates in this
 * file use the same convention as the template schema (points from the TOP-left of the page) so
 * the two files can be compared side by side.
 *
 * The photos and logo in public/samples/photos come from scripts/make-sample-photos.py.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'samples');
mkdirSync(join(out, 'fonts'), { recursive: true });

const NAVY = rgb(0.1, 0.17, 0.43);
const GOLD = rgb(0.72, 0.56, 0.2);
const INK = rgb(0.15, 0.15, 0.18);
const MUTED = rgb(0.45, 0.45, 0.5);
const PAPER = rgb(0.995, 0.985, 0.955);
const RULE = rgb(0.78, 0.78, 0.8);

const document = await PDFDocument.create();
document.setTitle('Sample certificate and progress report');
const serifBold = await document.embedFont(StandardFonts.TimesRomanBold);
const serifItalic = await document.embedFont(StandardFonts.TimesRomanItalic);
const sans = await document.embedFont(StandardFonts.Helvetica);
const sansBold = await document.embedFont(StandardFonts.HelveticaBold);

/** Drawing helpers that take top-left coordinates, like the template schema. */
function canvas(page) {
  const height = page.getHeight();
  return {
    rect(x, y, width, h, options) {
      page.drawRectangle({ x, y: height - y - h, width, height: h, ...options });
    },
    line(x1, y1, x2, y2, options) {
      page.drawLine({
        start: { x: x1, y: height - y1 },
        end: { x: x2, y: height - y2 },
        ...options,
      });
    },
    /** `y` is the baseline. */
    text(value, x, y, font, size, color = INK) {
      page.drawText(value, { x, y: height - y, font, size, color });
    },
    centred(value, centreX, y, font, size, color = INK) {
      const width = font.widthOfTextAtSize(value, size);
      page.drawText(value, { x: centreX - width / 2, y: height - y, font, size, color });
    },
  };
}

// ── Page 1: certificate, A4 landscape ──────────────────────────────────────────────────────────
{
  const page = document.addPage([842, 595]);
  const c = canvas(page);
  c.rect(0, 0, 842, 595, { color: PAPER });
  c.rect(24, 24, 794, 547, { borderColor: NAVY, borderWidth: 3 });
  c.rect(34, 34, 774, 527, { borderColor: GOLD, borderWidth: 1 });

  c.centred('CERTIFICATE OF ACHIEVEMENT', 421, 118, serifBold, 34, NAVY);
  c.centred('Sunrise Public School, Pune', 421, 146, sans, 13, MUTED);
  c.centred('This is to certify that', 421, 190, serifItalic, 16);

  // The name sits on this rule; the photo frame is to its left.
  c.line(221, 262, 621, 262, { color: GOLD, thickness: 1 });
  c.rect(70, 180, 110, 140, { borderColor: RULE, borderWidth: 1 });

  c.centred(
    'has successfully completed the academic session 2025–26 with distinction.',
    421,
    360,
    serifItalic,
    15,
  );

  c.line(110, 500, 290, 500, { color: INK, thickness: 0.75 });
  c.centred('Class Teacher', 200, 516, sans, 11, MUTED);
  c.line(350, 500, 530, 500, { color: INK, thickness: 0.75 });
  c.centred('Principal', 440, 516, sans, 11, MUTED);
  c.centred('Scan to verify', 735, 536, sans, 9, MUTED);
}

// ── Page 2: progress report, A4 portrait ───────────────────────────────────────────────────────
{
  const page = document.addPage([595, 842]);
  const c = canvas(page);
  c.rect(0, 0, 595, 842, { color: rgb(1, 1, 1) });
  c.rect(0, 0, 595, 70, { color: NAVY });
  c.text('PROGRESS REPORT 2025–26', 70, 44, sansBold, 20, rgb(1, 1, 1));

  c.text('Student', 70, 112, sans, 10, MUTED);
  c.text('Class', 70, 152, sans, 10, MUTED);
  c.text('Roll No.', 250, 152, sans, 10, MUTED);
  c.rect(445, 95, 80, 100, { borderColor: RULE, borderWidth: 1 });

  // Marks table: a header row and one row per subject, then the total.
  const left = 70;
  const top = 230;
  const rowHeight = 34;
  const columns = [255, 100, 100];
  const subjects = ['English', 'Hindi', 'Mathematics', 'Science', 'Social Science'];
  const rows = subjects.length + 2;
  const width = columns.reduce((total, value) => total + value, 0);

  c.rect(left, top, width, rowHeight, { color: rgb(0.93, 0.94, 0.98) });
  c.rect(left, top + (rows - 1) * rowHeight, width, rowHeight, { color: rgb(0.97, 0.97, 0.97) });
  for (let row = 0; row <= rows; row++) {
    c.line(left, top + row * rowHeight, left + width, top + row * rowHeight, {
      color: RULE,
      thickness: 0.75,
    });
  }
  let x = left;
  for (const columnWidth of [0, ...columns]) {
    x += columnWidth;
    c.line(x, top, x, top + rows * rowHeight, { color: RULE, thickness: 0.75 });
  }

  // 20 pt below the top of a 34 pt row is where 11–12 pt text sits when centred vertically.
  const baseline = (row) => top + row * rowHeight + 20;
  c.text('Subject', left + 12, baseline(0), sansBold, 11, NAVY);
  c.centred('Maximum', left + columns[0] + columns[1] / 2, baseline(0), sansBold, 11, NAVY);
  c.centred(
    'Marks',
    left + columns[0] + columns[1] + columns[2] / 2,
    baseline(0),
    sansBold,
    11,
    NAVY,
  );
  subjects.forEach((subject, index) => {
    c.text(subject, left + 12, baseline(index + 1), sans, 11);
    c.centred('100', left + columns[0] + columns[1] / 2, baseline(index + 1), sans, 11, MUTED);
  });
  c.text('Total', left + 12, baseline(rows - 1), sansBold, 11);
  c.centred('500', left + columns[0] + columns[1] / 2, baseline(rows - 1), sansBold, 11, MUTED);

  c.text("Class teacher's remarks", 70, 492, sans, 10, MUTED);
  c.rect(70, 500, 455, 110, { borderColor: RULE, borderWidth: 0.75 });
}

writeFileSync(join(out, 'template.pdf'), await document.save());

// The playground's Hindi font. Noto Sans Devanagari is licensed under the SIL Open Font License.
const fontPackage = join(root, 'node_modules', '@expo-google-fonts', 'noto-sans-devanagari');
copyFileSync(
  join(fontPackage, '400Regular', 'NotoSansDevanagari_400Regular.ttf'),
  join(out, 'fonts', 'NotoSansDevanagari-Regular.ttf'),
);
copyFileSync(join(fontPackage, 'LICENSE_FONT'), join(out, 'fonts', 'OFL.txt'));

console.log('wrote public/samples/template.pdf and public/samples/fonts/');
