/**
 * End-to-end check of `generatePdfBatch` (ZIP output) at the product's largest batch size,
 * 2,500 rows, in Chromium against the production build. Samples the worker's JS heap while it
 * runs, then opens the ZIP and checks every entry.
 *
 *     npm run build && node scripts/e2e-batch.mjs
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';

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
const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const port = await new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port: free } = probe.address();
    probe.close(() => resolve(free));
  });
});
const server = spawn(process.execPath, ['server.js'], {
  cwd: standalone,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    IMAGE_PROXY_ALLOW_ANONYMOUS: 'true',
    K_SERVICE: '',
  },
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
  const page = await browser.newPage({ viewport: { width: 1100, height: 1300 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/playground`);

  async function run(copies, { cancelAt } = {}) {
    await page.getByTestId('mode-zip').click();
    await page.getByTestId(`copies-${copies}`).click();
    await page.getByTestId('generate').click();

    // performance.memory does not exist in workers; read the worker's V8 heap over the
    // DevTools protocol instead.
    const heap = [];
    let stop = false;
    const cdp = await browser.newBrowserCDPSession();
    let workerTarget;
    for (let i = 0; i < 100 && !workerTarget; i++) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      workerTarget = targetInfos.find((target) => target.type === 'worker');
      if (!workerTarget) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: workerTarget.targetId,
      flatten: false,
    });
    let messageId = 0;
    const pending = new Map();
    cdp.on('Target.receivedMessageFromTarget', (event) => {
      const message = JSON.parse(event.message);
      pending.get(message.id)?.(message.result);
    });
    const heapUsage = () =>
      new Promise((resolve) => {
        const id = ++messageId;
        pending.set(id, resolve);
        void cdp.send('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({ id, method: 'Runtime.getHeapUsage', params: {} }),
        });
        setTimeout(() => resolve(null), 2000);
      });
    const sampler = (async () => {
      while (!stop) {
        const usage = await heapUsage();
        if (usage?.usedSize) heap.push(usage.usedSize);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })();

    if (cancelAt) {
      await page.waitForFunction(
        (rows) =>
          Number(
            /^([\d,]+) of/
              .exec(document.querySelector('[data-testid=status]')?.textContent ?? '')?.[1]
              ?.replace(/,/g, '') ?? 0,
          ) >= rows,
        cancelAt,
        { timeout: 120_000 },
      );
      await page.getByTestId('cancel').click();
    }
    await page.waitForSelector(
      '[data-testid=status][data-status=done], [data-testid=status][data-status=error]',
      {
        state: 'attached',
        timeout: 600_000,
      },
    );
    stop = true;
    await sampler;
    await cdp.detach();
    const summary = page.getByTestId('summary');
    return {
      status: await page.getByTestId('status').getAttribute('data-status'),
      succeeded: Number(await summary.getAttribute('data-succeeded')),
      files: Number(await summary.getAttribute('data-files')),
      bytes: Number(await summary.getAttribute('data-bytes')),
      cancelled: (await summary.getAttribute('data-cancelled')) === 'true',
      text: (await summary.innerText()).replace(/\s+/g, ' '),
      peakHeap: heap.length ? Math.max(...heap) : 0,
      samples: heap.length,
    };
  }

  console.log('\n2,500 rows → one ZIP');
  const big = await run(417);
  check(big.status === 'done', 'the batch completes', big.status);
  console.log(`        ${big.text}`);
  check(big.succeeded === 2500 && big.files === 2500, `2,500 PDFs in the ZIP (${big.files})`);
  check(
    big.samples > 0,
    `worker heap sampled ${big.samples} times; peak ${mb(big.peakHeap)} for a ${mb(big.bytes)} ZIP`,
  );
  check(big.peakHeap < big.bytes, 'the worker heap never held the whole batch');

  const href = await page.getByTestId('zip-link').getAttribute('href');
  const zipBytes = Buffer.from(
    await page.evaluate(async (url) => {
      const buffer = await (await fetch(url)).arrayBuffer();
      // Return as base64 in slices to avoid one giant string.
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    }, href),
    'base64',
  );
  writeFileSync(join(out, 'e2e-batch.zip'), zipBytes);
  const zip = await JSZip.loadAsync(zipBytes);
  const names = Object.keys(zip.files);
  check(
    names.length === 2500 && new Set(names).size === 2500,
    `the ZIP opens and holds 2,500 uniquely named PDFs`,
  );
  check(names.includes('101 - Aarav Sharma.pdf'), 'entries are named from the rows');
  let pages = 0;
  for (const name of [names[0], names[1234], names[2499]]) {
    const pdf = await PDFDocument.load(await zip.file(name).async('uint8array'));
    pages += pdf.getPageCount();
  }
  check(pages === 6, 'sampled PDFs open with two pages each');

  console.log('\nCancelling a 2,500-row batch');
  const cancelled = await run(417, { cancelAt: 200 });
  console.log(`        ${cancelled.text}`);
  check(
    cancelled.cancelled && cancelled.succeeded < 2500,
    `stopped early (${cancelled.succeeded} rows)`,
  );
  check(
    (await page.getByTestId('zip-link').count()) === 0,
    'no ZIP is offered for a cancelled batch',
  );

  console.log('\nThe worker is still usable');
  const again = await run(1);
  check(again.status === 'done' && again.files === 6, 'a new 6-row ZIP batch completes');

  check(errors.length === 0, 'no script errors', errors.join(' | '));
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? '\nAll batch checks passed.' : `\n${failures} batch check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
