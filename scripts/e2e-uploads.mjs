/**
 * End-to-end check of the upload gateway (/playground/uploads) in Chromium, on a phone-sized
 * screen and on a desktop one.
 *
 *     npm run build && node scripts/e2e-uploads.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
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

// A large, detailed photo (noise compresses badly, so it really exercises the 200 KB budget).
const photo = join(out, 'e2e-upload-photo.jpg');
spawnSync('python3', [
  '-c',
  `from PIL import Image; Image.effect_noise((3000, 4000), 60).convert('RGB').save(${JSON.stringify(photo)}, quality=92)`,
]);
const goodCsv = join(out, 'e2e-good.csv');
writeFileSync(
  goodCsv,
  `Name,Roll,Photo\n${Array.from({ length: 12 }, (_, i) => `Student ${i + 1},${100 + i},https://x/${i}.jpg`).join('\n')}\n`,
);
const badCsv = join(out, 'e2e-bad.csv');
writeFileSync(badCsv, 'name,Roll\nAsha,1\n');

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
  for (const [label, options] of [
    ['phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
    ['desktop', { viewport: { width: 1280, height: 900 } }],
  ]) {
    console.log(`\n${label}`);
    const page = await browser.newPage(options);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/playground/uploads`);

    // Image: picked → crop modal → confirm → ≤ 200 KB at 3:4.
    await page.getByTestId('upload-input').setInputFiles(photo);
    const modal = page.getByTestId('image-crop-modal');
    await modal.waitFor();
    const box = await modal.boundingBox();
    if (label === 'phone')
      check(
        box.width >= 389 && box.height >= 843,
        'crop modal fills the screen',
        JSON.stringify(box),
      );
    else check(box.width <= 520, 'crop modal is a centred dialog', JSON.stringify(box));
    await page.getByLabel('Zoom in').click();
    await page.screenshot({ path: join(out, `e2e-crop-${label}.png`) });
    await page.getByTestId('crop-confirm').click();
    const result = page.getByTestId('upload-result');
    await result.waitFor({ timeout: 30_000 });
    const bytes = Number(await result.getAttribute('data-bytes'));
    check(
      bytes > 0 && bytes <= 200 * 1024,
      `image compressed to ${Math.round(bytes / 1024)} KB (≤ 200 KB)`,
    );
    check((await result.getAttribute('data-type')) === 'image/jpeg', 'image saved as JPEG');
    const size = await page.getByTestId('upload-preview').evaluate(
      (img) =>
        new Promise((resolve) => {
          const done = () => resolve([img.naturalWidth, img.naturalHeight]);
          if (img.complete) done();
          else img.onload = done;
        }),
    );
    check(
      Math.abs(size[0] / size[1] - 3 / 4) < 0.01 && Math.max(...size) <= 1600,
      `cropped to 3:4 (${size.join('×')})`,
    );

    // CSV with a missing column: red warning, confirm disabled.
    await page.getByTestId('upload-input').setInputFiles(badCsv);
    await page.getByTestId('csv-preview-modal').waitFor();
    const warning = await page.getByTestId('missing-headers').innerText();
    check(
      /Name/.test(warning) && /Photo/.test(warning) && /found “name”/.test(warning),
      'missing columns flagged, with a near match',
    );
    check(await page.getByTestId('csv-confirm').isDisabled(), 'confirm is disabled');
    await page.screenshot({ path: join(out, `e2e-csv-bad-${label}.png`) });
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Valid CSV: 5 preview rows, confirm passes the data through.
    await page.getByTestId('upload-input').setInputFiles(goodCsv);
    await page.getByTestId('csv-preview-modal').waitFor();
    check(
      (await page.getByTestId('csv-preview-row').count()) === 5,
      'only the first 5 rows are previewed',
    );
    await page.getByTestId('csv-confirm').click();
    await page.locator('[data-testid=upload-result][data-kind=csv]').waitFor();
    check((await result.getAttribute('data-rows')) === '12', 'all 12 rows are handed on');

    // Wrong file type.
    await page
      .getByTestId('upload-input')
      .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
    check(
      /not accepted/.test(await page.getByRole('alert').first().innerText()),
      'other file types are refused',
    );

    check(errors.length === 0, 'no script errors', errors.join(' | '));
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(
  failures === 0 ? '\nAll upload checks passed.' : `\n${failures} upload check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
