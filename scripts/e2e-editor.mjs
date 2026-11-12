/**
 * End-to-end check of the Tap-to-Place editor (/editor) in Chromium, on a touch phone and on a
 * desktop: the pdf.js background, overlay alignment, the property sheet (D-pad, step size, font
 * size, hold-to-repeat, swipe to dismiss), dragging, tap-to-place, and finally the PDF the Web
 * Worker generates from the edited template — read back with poppler to prove that what was placed
 * on screen is where it is printed.
 *
 *     npm run build && node scripts/e2e-editor.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const standalone = join(root, '.next', 'standalone');
const out = join(root, 'tests', 'output');
mkdirSync(out, { recursive: true });
cpSync(join(root, 'public'), join(standalone, 'public'), { recursive: true });
cpSync(join(root, '.next', 'static'), join(standalone, '.next', 'static'), { recursive: true });

let failures = 0;
const check = (condition, label, detail = '') => {
  if (condition) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

/** The sample certificate page and its "Name" field (src/app/playground/sample.ts). */
const PAGE = { width: 842, height: 595 };
const NAME_BOX = { x: 221, y: 204, width: 400, height: 54 };

const port = await new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port: free } = probe.address();
    probe.close(() => resolve(free));
  });
});
const server = spawn(process.execPath, ['server.js'], {
  cwd: standalone,
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOSTNAME: '127.0.0.1' },
  stdio: 'ignore',
});
const origin = `http://127.0.0.1:${port}`;
for (let i = 0; i < 200; i++) {
  try {
    if ((await fetch(origin)).ok) break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Reads a placeholder's stored box (points) from the canvas. */
async function boxOf(page, id) {
  const value = await page.locator(`[data-placeholder-id="${id}"]`).getAttribute('data-box');
  const [x, y, width, height] = value.split(',').map(Number);
  return { x, y, width, height };
}

/** Swipes with real touch events (Playwright has no touch-move helper). */
async function touchDrag(page, from, to, steps = 12) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  for (let i = 1; i <= steps; i++) {
    const point = {
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
    };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
try {
  for (const [label, options] of [
    ['phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
    ['desktop', { viewport: { width: 1280, height: 900 } }],
  ]) {
    console.log(`\n${label}`);
    const touch = label === 'phone';
    const context = await browser.newContext({ ...options, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/editor`);

    // ── Upload gateway: nothing is preloaded; the sample is an explicit choice ───────────────
    await page.getByTestId('editor-gateway').waitFor();
    check(
      (await page.getByTestId('page-surface').count()) === 0,
      'editor starts at the upload gateway, with no template loaded',
    );
    await page.getByTestId('use-sample').click();
    check(
      (await page.getByTestId('editor-title').textContent()) === 'Sample certificate',
      'title shows the template name',
    );

    // ── Background and overlay ──────────────────────────────────────────────────────────────
    await page.locator('[data-testid=page-surface][data-rendered=true]').nth(1).waitFor({
      timeout: 30_000,
    });
    check(true, 'both template pages rendered by pdf.js');
    const surface = page.getByTestId('page-surface').first();
    const inked = await surface.locator('canvas').evaluate((canvas) => {
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let dark = 0;
      let samples = 0;
      for (let i = 0; i < data.length; i += 4 * 7) {
        samples++;
        if (data[i] < 200) dark++;
      }
      return { share: dark / samples, width: canvas.width };
    });
    check(
      inked.share > 0.02,
      `background artwork is drawn (canvas ${inked.width}px wide, ${(inked.share * 100).toFixed(1)}% ink)`,
    );

    const surfaceBox = await surface.boundingBox();
    const nameField = page.locator('[data-placeholder-id="name"]');
    const fieldBox = await nameField.boundingBox();
    const scale = surfaceBox.width / PAGE.width;
    check(
      near(fieldBox.x - surfaceBox.x, NAME_BOX.x * scale, 0.75) &&
        near(fieldBox.y - surfaceBox.y, NAME_BOX.y * scale, 0.75) &&
        near(fieldBox.width, NAME_BOX.width * scale, 0.75),
      `"Name" overlay sits at its points × ${scale.toFixed(3)} px/pt`,
      JSON.stringify({ fieldBox, surfaceBox }),
    );
    check((await nameField.innerText()).includes('Aarav Sharma'), 'preview shows the first row');

    // ── Property sheet ──────────────────────────────────────────────────────────────────────
    if (touch) await nameField.tap();
    else await nameField.click();
    const sheet = page.getByTestId('property-bar');
    await sheet.waitFor();
    await page.waitForTimeout(500); // spring settles
    const sheetBox = await sheet.boundingBox();
    check(
      sheetBox.y + sheetBox.height <= options.viewport.height + 1 &&
        sheetBox.y > options.viewport.height / 2,
      'tapping a field opens the bottom sheet',
      JSON.stringify(sheetBox),
    );
    check((await nameField.getAttribute('aria-pressed')) === 'true', 'the field is selected');
    await page.screenshot({ path: join(out, `e2e-editor-${label}.png`) });

    const press = async (name, times = 1) => {
      for (let i = 0; i < times; i++) {
        const button = sheet.getByRole('button', { name });
        if (touch) await button.tap();
        else await button.click();
      }
    };
    await press('Move right 1 pt', 3);
    await press('Move up 1 pt', 2);
    let box = await boxOf(page, 'name');
    check(box.x === 224 && box.y === 202, `D-pad moves 1 pt per tap (x ${box.x}, y ${box.y})`);
    await press(/Change step size/);
    await press('Move down 10 pt');
    box = await boxOf(page, 'name');
    check(box.y === 212, `step switch gives 10 pt moves (y ${box.y})`);
    await press(/Change step size/);

    await press('Increase font size', 2);
    await press('Decrease font size');
    check(
      (await nameField.getAttribute('data-font-size')) === '35' &&
        (await page.getByTestId('font-size-value').innerText()).startsWith('35'),
      'font size − / + (34 → 35)',
    );

    if (!touch) {
      // Hold-to-repeat.
      const right = sheet.getByRole('button', { name: 'Move right 1 pt' });
      const before = (await boxOf(page, 'name')).x;
      await right.hover();
      await page.mouse.down();
      await page.waitForTimeout(1000);
      await page.mouse.up();
      const moved = (await boxOf(page, 'name')).x - before;
      check(moved >= 5, `holding an arrow repeats (${moved} pt in 1 s)`);
      // Keyboard nudge.
      const keyBefore = await boxOf(page, 'name');
      await nameField.focus();
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Shift+ArrowDown');
      const keyAfter = await boxOf(page, 'name');
      check(
        keyAfter.x === keyBefore.x - 1 && keyAfter.y === keyBefore.y + 10,
        'arrow keys nudge (Shift = 10 pt)',
      );
    }

    // ── Drag ────────────────────────────────────────────────────────────────────────────────
    const beforeDrag = await boxOf(page, 'name');
    const handle = await nameField.boundingBox();
    const start = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
    const delta = { x: -40, y: 30 };
    if (touch) {
      await touchDrag(page, start, { x: start.x + delta.x, y: start.y + delta.y });
    } else {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + delta.x, start.y + delta.y, { steps: 10 });
      await page.mouse.up();
    }
    const afterDrag = await boxOf(page, 'name');
    const liveScale = (await surface.boundingBox()).width / PAGE.width;
    check(
      near(afterDrag.x - beforeDrag.x, delta.x / liveScale, 0.05) &&
        near(afterDrag.y - beforeDrag.y, delta.y / liveScale, 0.05),
      `dragging moves by pixels ÷ scale (${(afterDrag.x - beforeDrag.x).toFixed(2)}, ${(afterDrag.y - beforeDrag.y).toFixed(2)} pt)`,
    );

    if (touch) {
      // Swiping across an UNSELECTED field must scroll the page, not move the field.
      const date = page.locator('[data-placeholder-id="date"]');
      const dateBefore = await boxOf(page, 'date');
      const dateRect = await date.boundingBox();
      const from = { x: dateRect.x + 20, y: dateRect.y + dateRect.height / 2 };
      await touchDrag(page, from, { x: from.x + 60, y: from.y - 120 });
      const dateAfter = await boxOf(page, 'date');
      check(
        dateAfter.x === dateBefore.x && dateAfter.y === dateBefore.y,
        'swiping over an unselected field does not move it',
      );
      check(
        (await nameField.getAttribute('aria-pressed')) === 'true',
        'and leaves the selection alone',
      );
      // Let the fling end: a tap during a fling only stops the scroll (as on a real phone).
      await page.waitForTimeout(1000);
    }

    // ── Tap-to-Place ────────────────────────────────────────────────────────────────────────
    const nowSurface = await surface.boundingBox();
    // An empty spot of the certificate: left of the photo column, low on the page.
    const tapPoints = { x: 160, y: 470 };
    const tapAt = {
      x: nowSurface.x + tapPoints.x * (nowSurface.width / PAGE.width),
      y: nowSurface.y + tapPoints.y * (nowSurface.height / PAGE.height),
    };
    if (touch) await page.touchscreen.tap(tapAt.x, tapAt.y);
    else await page.mouse.click(tapAt.x, tapAt.y);
    const placed = await boxOf(page, 'name');
    // The box is clamped to the page: x ≥ 0. Input events land on whole CSS pixels, so allow one.
    const expectedX = Math.max(0, tapPoints.x - placed.width / 2);
    const pixel = PAGE.width / nowSurface.width;
    check(
      near(placed.x, expectedX, pixel) && near(placed.y + placed.height / 2, tapPoints.y, pixel),
      `tapping the page centres the field there (${placed.x}, ${placed.y})`,
    );

    // ── Test PDF from the Web Worker ────────────────────────────────────────────────────────
    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
    const exportButton = page.getByTestId('export-test-pdf');
    if (touch) await exportButton.tap();
    else await exportButton.click();
    const download = await downloadPromise;
    const pdfPath = join(out, `e2e-editor-${label}.pdf`);
    await download.saveAs(pdfPath);
    const xhtml = execFileSync('pdftotext', ['-bbox', '-f', '1', '-l', '1', pdfPath, '-'], {
      encoding: 'utf8',
    });
    const words = [
      ...xhtml.matchAll(
        /<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([^<]*)<\/word>/g,
      ),
    ]
      .map((m) => ({ text: m[5], xMin: +m[1], yMin: +m[2], xMax: +m[3], yMax: +m[4] }))
      .filter((word) => word.text === 'Aarav' || word.text === 'Sharma');
    const printed = {
      xMin: Math.min(...words.map((w) => w.xMin)),
      xMax: Math.max(...words.map((w) => w.xMax)),
      yMin: Math.min(...words.map((w) => w.yMin)),
      yMax: Math.max(...words.map((w) => w.yMax)),
    };
    const centre = placed.x + placed.width / 2;
    check(
      words.length === 2 &&
        near((printed.xMin + printed.xMax) / 2, centre, 1.5) &&
        printed.xMin >= placed.x - 0.5 &&
        printed.xMax <= placed.x + placed.width + 0.5 &&
        printed.yMin >= placed.y - 0.5 &&
        printed.yMax <= placed.y + placed.height + 0.5,
      `worker PDF prints the name inside the edited box (text ${printed.xMin.toFixed(1)}–${printed.xMax.toFixed(1)} × ${printed.yMin.toFixed(1)}–${printed.yMax.toFixed(1)} pt, box x ${placed.x} y ${placed.y})`,
      JSON.stringify(words),
    );
    check(readFileSync(pdfPath).subarray(0, 5).toString() === '%PDF-', 'download is a PDF');

    // ── Dismiss ─────────────────────────────────────────────────────────────────────────────
    const grip = await sheet.locator('div[aria-hidden]').first().boundingBox();
    const gripCentre = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
    if (touch) {
      await touchDrag(page, gripCentre, { x: gripCentre.x, y: gripCentre.y + 220 }, 8);
    } else {
      await page.mouse.move(gripCentre.x, gripCentre.y);
      await page.mouse.down();
      await page.mouse.move(gripCentre.x, gripCentre.y + 220, { steps: 8 });
      await page.mouse.up();
    }
    await sheet.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
    check((await sheet.count()) === 0, 'swiping the handle down closes the sheet');
    check((await nameField.getAttribute('aria-pressed')) === 'false', 'and clears the selection');

    check(errors.length === 0, 'no script errors', errors.join(' | '));
    await context.close();
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(
  failures === 0 ? '\nAll editor checks passed.' : `\n${failures} editor check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
