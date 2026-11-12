/**
 * End-to-end check of the Phase 9 AI tools in Chromium on the production build (/editor):
 * AI Magic (adds a column), the Smart Audit carousel (swipe, keyboard, flags), a chat command that
 * applies a patch and can be undone, and the failure paths (server error, malformed patch).
 *
 * `/api/ai/*` is answered by a stub in the browser (no Gemini key, no sign-in needed), so this proves
 * the UI and the client contract; the Gemini call itself is covered by unit tests with a mocked
 * fetch. It also checks the REAL routes refuse an unauthenticated caller.
 *
 *     npm run build && node scripts/e2e-ai.mjs
 */
import { spawn } from 'node:child_process';
import { cpSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const standalone = join(root, '.next', 'standalone');
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

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
try {
  // The real routes: never answer an anonymous caller.
  for (const path of ['enrich', 'audit']) {
    const response = await fetch(`${origin}/api/ai/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: '{}',
    });
    check(
      [401, 403, 503].includes(response.status),
      `/api/ai/${path} refuses an anonymous caller`,
      String(response.status),
    );
    const noOrigin = await fetch(`${origin}/api/ai/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: '{}',
    });
    check(
      noOrigin.status === 403,
      `/api/ai/${path} refuses a cross-origin caller`,
      String(noOrigin.status),
    );
  }

  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    hasTouch: true,
  });
  const page = await context.newPage();
  const calls = { enrich: [], audit: [] };
  let auditMode = 'upper';
  await page.route('**/api/ai/enrich', async (route) => {
    const body = route.request().postDataJSON();
    calls.enrich.push(body);
    await route.fulfill({
      json: { results: body.rows.map((r) => ({ i: r.i, value: `नमस्ते ${r.values.Name}` })) },
    });
  });
  await page.route('**/api/ai/audit', async (route) => {
    const body = route.request().postDataJSON();
    calls.audit.push(body);
    if (auditMode === 'garbage') return route.fulfill({ json: { patch: { summary: 5 } } });
    if (auditMode === 'down') {
      return route.fulfill({
        status: 502,
        json: {
          error: {
            code: 'AI_UNAVAILABLE',
            message: 'The AI service is busy. Try again in a minute.',
          },
        },
      });
    }
    await route.fulfill({
      json: {
        patch: {
          summary: 'Made names upper case',
          dataRows: {
            transforms: [
              { column: 'Name', transform: 'uppercase' },
              { column: 'Ghost', transform: 'trim' },
            ],
            cells: [],
          },
          placeholders: [{ id: 'name', align: 'left', color: '#112233' }],
        },
      },
    });
  });
  const errors = [];
  /** True once the carousel shows row n (polls briefly: state and animation are asynchronous). */
  const rowIs = (n) =>
    page
      .waitForFunction(
        (want) =>
          document
            .querySelector('[data-testid=smart-audit-counter]')
            ?.textContent.includes(`Row ${want} of`),
        n,
        { timeout: 2000 },
      )
      .then(
        () => true,
        () => false,
      );
  /** Waits for the exit animation of the previous card to finish. */
  const settled = () =>
    page.waitForFunction(
      () => document.querySelectorAll('[data-testid=smart-audit-card]').length === 1,
    );
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.goto(`${origin}/editor`);
  await page.getByTestId('use-sample').click();
  await page.getByTestId('review-data').waitFor();

  // ── AI Magic
  await page.getByTestId('ai-magic-button').click();
  const dialog = page.getByTestId('ai-magic-dialog');
  await dialog.waitFor();
  const defaultTarget = await dialog.getByLabel('New column name').inputValue();
  check(defaultTarget === 'Name (Hindi)', 'translate preset proposes a column name', defaultTarget);
  check(
    await dialog.getByTestId('ai-magic-run').isDisabled(),
    'cannot overwrite an existing column (Name (Hindi) exists)',
  );
  await dialog.getByLabel('New column name').fill('Greeting');
  await dialog.getByTestId('ai-magic-run').click();
  await dialog.getByTestId('ai-magic-message').waitFor();
  const done = await dialog.getByTestId('ai-magic-message').innerText();
  check(/Added "Greeting"/.test(done), 'AI Magic reports the new column', done);
  check(
    calls.enrich.length === 1 && Object.keys(calls.enrich[0].rows[0].values).join() === 'Name',
    'only the chosen column was sent',
    JSON.stringify(calls.enrich[0]?.rows[0]),
  );
  await page.keyboard.press('Escape');

  // ── Carousel
  await page.getByTestId('review-data').click();
  const card = page.getByTestId('smart-audit-card');
  await card.waitFor();
  const counter = page.getByTestId('smart-audit-counter');
  check(/Row 1 of/.test(await counter.innerText()), 'carousel starts on row 1');
  check((await card.innerText()).includes('नमस्ते Aarav Sharma'), 'the new column is on the card');
  const review = page.getByRole('region', { name: 'Review your data' });
  await review.getByRole('button', { name: 'Next row' }).click();
  check(/Row 2 of/.test(await counter.innerText()), 'next button moves to row 2');
  await review.focus();
  await page.keyboard.press('ArrowLeft');
  check(/Row 1 of/.test(await counter.innerText()), 'arrow key moves back');
  await settled();
  // Scroll the card under the sticky header, then drag on its body.
  await page.getByTestId('smart-audit-card').evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  const box = await page.getByTestId('smart-audit-card').boundingBox();
  const y = box.y + Math.min(box.height / 2, 120);
  await page.mouse.move(box.x + box.width - 20, y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(box.x + box.width - 20 - i * 14, y);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await settled();
  check(await rowIs(2), 'swiping left moves to the next row');
  // The editor's own row switcher and the carousel stay in step.
  check(
    (await page.getByTestId('preview-row').innerText()).startsWith('2/'),
    'the canvas preview follows the carousel',
  );
  await page.getByRole('banner').getByRole('button', { name: 'Previous row' }).click();
  check(await rowIs(1), 'the editor row switcher moves the carousel');
  await review.getByRole('button', { name: 'Next row' }).click();
  check(
    (await page.evaluate(() => document.documentElement.scrollWidth)) <= 412,
    'no horizontal page scroll on a phone',
  );

  // ── Chat command + undo
  await settled();
  await page.getByTestId('smart-audit-input').fill('Make all text uppercase');
  await page.getByTestId('smart-audit-send').click();
  await page.getByTestId('smart-audit-log').waitFor();
  const log = await page.getByTestId('smart-audit-log').innerText();
  check(
    /Made names upper case/.test(log) && /skipped/.test(log),
    'patch applied, impossible op skipped',
    log,
  );
  check(
    (await page.getByTestId('smart-audit-card').innerText()).includes('ARJUN') ||
      /[A-Z]{4,}/.test(await page.getByTestId('smart-audit-card').innerText()),
    'the card shows the change',
  );
  check(
    /ALL CAPS/.test(await page.getByTestId('smart-audit-card').innerText()),
    'the audit flags the shouting cell',
  );
  check(
    calls.audit[0].context.sample.length <= 25 &&
      calls.audit[0].context.placeholders.some((p) => p.id === 'name'),
    'only a bounded context was sent',
  );
  await page.getByRole('button', { name: 'Undo' }).click();
  check(
    !/ALL CAPS/.test(await page.getByTestId('smart-audit-card').innerText()),
    'undo restores the data',
  );

  // ── Failure paths never break the page
  auditMode = 'down';
  await page.getByTestId('smart-audit-input').fill('anything');
  await page.getByTestId('smart-audit-send').click();
  await page.getByText('The AI service is busy').waitFor();
  check(true, 'a server error is shown in the chat');
  auditMode = 'garbage';
  await page.getByTestId('smart-audit-input').fill('anything else');
  await page.getByTestId('smart-audit-send').click();
  await page.getByText('could not be used').waitFor();
  check(true, 'a malformed patch is rejected, not applied');
  check(await page.getByTestId('smart-audit-card').isVisible(), 'the carousel is still usable');
  check(errors.length === 0, 'no uncaught page errors', errors.join(' | '));
  await page.screenshot({ path: join(root, 'tests', 'output', 'ai-audit.png') });
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
