/**
 * End-to-end check of everything the unit tests cannot reach: the production build, the Web
 * Worker bundle, comlink, canvas image processing in a real browser, and the image proxy served
 * by the real Next.js server.
 *
 *     npm run build && node scripts/e2e-playground.mjs
 *
 * What it does:
 *   1. Starts the standalone production server (the same entry point the Docker image uses).
 *   2. Calls /api/proxy-image directly: bad requests, blocked destinations, a real image.
 *   3. Restarts the server the way Cloud Run runs it and checks that anonymous access is refused.
 *   4. Opens /playground in Chromium and runs the sample job in every mode, including a
 *      cancelled one, checking the results the page reports.
 *   5. Saves the generated PDFs (and PNG renderings, if poppler is installed) to tests/output/.
 *
 * Needs Playwright with Chromium (preinstalled in cloud sessions; elsewhere `npm i -D playwright
 * && npx playwright install chromium`). Steps that need the public internet are reported as
 * SKIPPED rather than failed when it is unreachable; pass --require-network to make them count.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const standalone = join(root, '.next', 'standalone');
const outputDirectory = join(root, 'tests', 'output');
const requireNetwork = process.argv.includes('--require-network');
const PUBLIC_IMAGE = 'https://www.gstatic.com/webp/gallery/1.jpg';

let failures = 0;
const check = (condition, label, detail = '') => {
  if (condition) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
  return Boolean(condition);
};
const skip = (label, reason) => console.log(`  skip  ${label} — ${reason}`);

// ── Server ─────────────────────────────────────────────────────────────────────────────────────

if (!existsSync(join(standalone, 'server.js'))) {
  console.error('No production build found. Run `npm run build` first.');
  process.exit(2);
}
// The standalone server does not include static files; the Dockerfile copies them the same way.
cpSync(join(root, 'public'), join(standalone, 'public'), { recursive: true });
cpSync(join(root, '.next', 'static'), join(standalone, '.next', 'static'), { recursive: true });

const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

async function startServer(extraEnvironment) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: standalone,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      ...extraEnvironment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => (log += chunk));
  child.stderr.on('data', (chunk) => (log += chunk));

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {
      // not listening yet
    }
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill();
      throw new Error(`The server did not start.\n${log}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return {
    origin,
    log: () => log,
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill();
      }),
  };
}

const proxy = (origin, target) =>
  fetch(`${origin}/api/proxy-image${target === null ? '' : `?url=${encodeURIComponent(target)}`}`);

// ── 1. The proxy route, over real HTTP ─────────────────────────────────────────────────────────

console.log('\nImage proxy (local development mode: anonymous access allowed)');
const server = await startServer({ IMAGE_PROXY_ALLOW_ANONYMOUS: 'true', K_SERVICE: '' });
let networkAvailable = false;
try {
  const missing = await proxy(server.origin, null);
  check(
    missing.status === 400 && (await missing.json()).error.code === 'MISSING_URL',
    'rejects a request without a url (400)',
  );

  for (const target of [
    'http://169.254.169.254/computeMetadata/v1/',
    'http://localhost:3000/',
    'http://10.0.0.1/a.png',
  ]) {
    const response = await proxy(server.origin, target);
    const body = await response.json();
    check(
      response.status === 403 && body.error.code === 'BLOCKED_DESTINATION',
      `refuses ${target} (403)`,
      `${response.status} ${body.error?.code}`,
    );
  }

  const invalid = await proxy(server.origin, 'ftp://example.com/a.png');
  check(invalid.status === 400, 'rejects a non-http link (400)');

  const image = await proxy(server.origin, PUBLIC_IMAGE);
  networkAvailable = image.status === 200;
  if (networkAvailable) {
    const bytes = new Uint8Array(await image.arrayBuffer());
    check(
      image.headers.get('content-type') === 'image/jpeg',
      'relays a public image with the sniffed content type',
    );
    check(
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.length > 10_000,
      `returns the image bytes (${bytes.length} bytes)`,
    );
    check(
      image.headers.get('cache-control') === 'private, max-age=600',
      'allows private browser caching only',
    );
    check(image.headers.get('x-content-type-options') === 'nosniff', 'sends nosniff');
    check(image.headers.get('access-control-allow-origin') === null, 'sends no CORS headers');
  } else if (requireNetwork) {
    check(false, 'relays a public image', `HTTP ${image.status}`);
  } else {
    skip(
      'relays a public image',
      `the public internet is not reachable from here (HTTP ${image.status})`,
    );
  }

  const html = await proxy(server.origin, 'https://www.google.com/');
  if (html.status === 415)
    check(
      (await html.json()).error.code === 'NOT_AN_IMAGE',
      'refuses a web page that is not an image (415)',
    );
  else if (requireNetwork)
    check(false, 'refuses a web page that is not an image', `HTTP ${html.status}`);
  else skip('refuses a web page that is not an image', `HTTP ${html.status}`);
} catch (error) {
  await server.stop();
  throw error;
}

// ── 2. The same route as Cloud Run would run it ────────────────────────────────────────────────

console.log('\nImage proxy (as deployed: K_SERVICE set, no Firebase token)');
{
  const deployed = await startServer({
    IMAGE_PROXY_ALLOW_ANONYMOUS: 'true',
    K_SERVICE: 'document-generator',
  });
  try {
    const anonymous = await proxy(deployed.origin, PUBLIC_IMAGE);
    check(
      anonymous.status === 401 && (await anonymous.json()).error.code === 'UNAUTHENTICATED',
      'refuses anonymous requests even with the development flag set (401)',
      `HTTP ${anonymous.status}`,
    );
    const forged = await fetch(
      `${deployed.origin}/api/proxy-image?url=${encodeURIComponent(PUBLIC_IMAGE)}`,
      {
        headers: { Authorization: 'Bearer not-a-real-token' },
      },
    );
    // Without FIREBASE_PROJECT_ID the server cannot verify anything, and must fail closed.
    check(
      forged.status === 500 || forged.status === 401,
      `does not accept a made-up token (HTTP ${forged.status})`,
    );
  } finally {
    await deployed.stop();
  }
}

// ── 3. The playground in a browser ─────────────────────────────────────────────────────────────

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error('\nPlaywright is not installed; cannot run the browser part.');
  await server.stop();
  process.exit(2);
}

mkdirSync(outputDirectory, { recursive: true });
const browser = await chromium.launch();
const pageErrors = [];

async function runJob(page, { mode, copies, cancelAfterRows }) {
  await page.getByTestId(`mode-${mode}`).click();
  await page.getByTestId(`copies-${copies}`).click();
  await page.getByTestId('generate').click();
  if (cancelAfterRows) {
    await page.waitForFunction(
      (rows) =>
        Number(
          /^(\d+) of/.exec(
            document.querySelector('[data-testid=status]')?.textContent ?? '',
          )?.[1] ?? 0,
        ) >= rows,
      cancelAfterRows,
      { timeout: 120_000 },
    );
    await page.getByTestId('cancel').click();
  }
  // "attached", not "visible": the status line is empty (so has no size) once a job is done.
  await page.waitForSelector(
    '[data-testid=status][data-status=done], [data-testid=status][data-status=error]',
    {
      state: 'attached',
      timeout: 180_000,
    },
  );
  const status = await page.getByTestId('status').getAttribute('data-status');
  if (status !== 'done') return { status, error: await page.getByTestId('error').textContent() };

  const summary = page.getByTestId('summary');
  const number = async (name) => Number(await summary.getAttribute(`data-${name}`));
  return {
    status,
    succeeded: await number('succeeded'),
    failed: await number('failed'),
    files: await number('files'),
    bytes: await number('bytes'),
    cancelled: (await summary.getAttribute('data-cancelled')) === 'true',
    summaryText: (await summary.innerText()).replace(/\s+/g, ' '),
    warnings: await page.locator('[data-testid=problem-row]').evaluateAll((rows) =>
      rows.map((row) => ({
        row: row.querySelector('span')?.textContent ?? '',
        codes: [...row.querySelectorAll('[data-code]')].map((element) =>
          element.getAttribute('data-code'),
        ),
        text: row.textContent ?? '',
      })),
    ),
    fileNames: await page
      .locator('[data-testid=file-link]')
      .evaluateAll((links) => links.map((link) => link.getAttribute('download'))),
  };
}

async function saveFirstFile(page, name) {
  const href = await page.getByTestId('file-link').first().getAttribute('href');
  const bytes = await page.evaluate(
    async (url) => [...new Uint8Array(await (await fetch(url)).arrayBuffer())],
    href,
  );
  const path = join(outputDirectory, `${name}.pdf`);
  writeFileSync(path, Buffer.from(bytes));
  if (spawnSync('pdftoppm', ['-v']).status === 0) {
    spawnSync('pdftoppm', ['-r', '80', '-l', '8', '-png', path, join(outputDirectory, name)]);
  }
  return Buffer.from(bytes);
}

try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    // Failed image requests are expected (the sample contains a dead link); real errors are not.
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text()))
      pageErrors.push(message.text());
  });
  await page.goto(`${server.origin}/playground`);

  console.log('\nPlayground: one PDF per student (6 rows)');
  const separate = await runJob(page, { mode: 'separate', copies: 1 });
  if (check(separate.status === 'done', 'the job completes', separate.error)) {
    console.log(`        ${separate.summaryText}`);
    check(separate.succeeded === 6 && separate.failed === 0, 'all six rows produce a document');
    check(separate.files === 6, 'six files are delivered');
    check(
      separate.fileNames[0] === '101 - Aarav Sharma.pdf',
      `files are named from the row (${separate.fileNames[0]})`,
    );

    const deadLink = separate.warnings.find((warning) => warning.row === 'Row 6');
    check(
      deadLink?.codes.includes('IMAGE_LOAD_FAILED'),
      'the dead photo link is reported on row 6',
      JSON.stringify(separate.warnings),
    );
    const external = separate.warnings.find((warning) => warning.row === 'Row 4');
    if (networkAvailable)
      check(!external, 'the photo behind the proxy loads (no warning on row 4)', external?.text);
    else
      skip('the photo behind the proxy loads', 'no internet; row 4 should carry a warning instead');
    const unexpected = separate.warnings.filter(
      (warning) => !['Row 4', 'Row 6'].includes(warning.row),
    );
    check(unexpected.length === 0, 'no other row has a warning', JSON.stringify(unexpected));

    const first = await saveFirstFile(page, 'e2e-separate');
    check(
      first.subarray(0, 5).toString() === '%PDF-',
      `the first file is a PDF (${first.length} bytes)`,
    );
    // student-1.jpg is 48 KB at 1200 × 1500; shrunk for a 110 × 140 pt box it is far smaller.
    check(
      first.length < 40_000,
      'the large photo was shrunk before embedding',
      `${first.length} bytes`,
    );
  }

  console.log('\nPlayground: one PDF to print (60 rows)');
  const merged = await runJob(page, { mode: 'merged', copies: 10 });
  if (check(merged.status === 'done', 'the job completes', merged.error)) {
    console.log(`        ${merged.summaryText}`);
    check(merged.succeeded === 60 && merged.files === 1, 'sixty rows go into a single file');
    const file = await saveFirstFile(page, 'e2e-merged');
    const pages = (file.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    check(
      pages === 120 || pages === 0,
      pages
        ? `the file has ${pages} pages`
        : 'page objects are compressed (count not checked here)',
    );
    check(
      merged.bytes < 60 * 25_000,
      `the merged file is compact (${Math.round(merged.bytes / 1024)} KB for 120 pages)`,
    );
  }

  console.log('\nPlayground: 300 rows, split into files of 100');
  const large = await runJob(page, { mode: 'merged', copies: 50 });
  if (check(large.status === 'done', 'the job completes', large.error)) {
    console.log(`        ${large.summaryText}`);
    check(large.succeeded === 300 && large.files === 3, 'three files of 100 rows each');
  }

  console.log('\nPlayground: cancelling a job');
  const cancelled = await runJob(page, { mode: 'separate', copies: 50, cancelAfterRows: 20 });
  if (check(cancelled.status === 'done', 'the job ends cleanly', cancelled.error)) {
    console.log(`        ${cancelled.summaryText}`);
    check(cancelled.cancelled, 'it reports that it was cancelled');
    check(
      cancelled.succeeded >= 20 && cancelled.succeeded < 300,
      `it stopped early (${cancelled.succeeded} of 300 rows)`,
    );
  }

  console.log('\nPlayground: the worker keeps working after a cancellation');
  const again = await runJob(page, { mode: 'separate', copies: 1 });
  check(again.status === 'done' && again.succeeded === 6, 'a new job runs to completion');

  await page.screenshot({ path: join(outputDirectory, 'e2e-playground.png'), fullPage: true });

  console.log('\nPlayground: phone-sized screen');
  const phone = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await phone.goto(`${server.origin}/playground`);
  const mobile = await runJob(phone, { mode: 'separate', copies: 1 });
  check(mobile.status === 'done' && mobile.succeeded === 6, 'the job completes');
  const overflow = await phone.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(overflow <= 0, 'the page does not scroll sideways', `${overflow}px wider than the screen`);
  await phone.screenshot({
    path: join(outputDirectory, 'e2e-playground-phone.png'),
    fullPage: true,
  });

  console.log('\nBrowser console');
  check(pageErrors.length === 0, 'no script errors', pageErrors.join(' | '));
} finally {
  await browser.close();
  await server.stop();
}

console.log(
  failures === 0 ? '\nAll end-to-end checks passed.' : `\n${failures} end-to-end check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
