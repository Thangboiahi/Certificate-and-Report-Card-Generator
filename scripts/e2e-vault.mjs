/**
 * End-to-end check of the vault (Phase 7) on the PRODUCTION build, Auth + Firestore emulated:
 *
 *   - /dashboard/vault in Chromium (phone): lists only the signed-in user's items (not another
 *     user's), "Generate Public Link" creates a link, the public page /verify/{id} opens without a
 *     session, "Stop sharing" makes the link stop working;
 *   - POST /api/vault/share refuses someone else's item and signed-out callers.
 *
 *     npm run build
 *     npx firebase emulators:exec --only auth,firestore --project demo-v6 'node scripts/e2e-vault.mjs'
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const PROJECT_ID = 'demo-v6';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const standalone = join(root, '.next', 'standalone');
if (!process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Run inside `firebase emulators:exec --only auth,firestore` (see the header).');
  process.exit(2);
}
if (!existsSync(join(standalone, 'server.js'))) {
  console.error('No production build found. Run `npm run build` first.');
  process.exit(2);
}
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

const app = initializeApp({ projectId: PROJECT_ID });
const auth = getAuth(app);
const db = getFirestore(app);
const authHost = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`;
const password = 'correct horse battery staple';

const port = await new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port: p } = probe.address();
    probe.close(() => resolve(p));
  });
});
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.js'], {
  cwd: standalone,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    FIREBASE_PROJECT_ID: PROJECT_ID,
    ALLOW_FIREBASE_EMULATOR: 'true',
    APP_ORIGIN: origin,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (chunk) => (serverLog += chunk));
child.stderr.on('data', (chunk) => (serverLog += chunk));
for (let i = 0; i < 200; i++) {
  try {
    if ((await fetch(origin)).ok) break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

const stamp = Date.now();
const people = {};
for (const name of ['asha', 'ravi']) {
  const email = `${name}-${stamp}@example.in`;
  const user = await auth.createUser({ email, password, emailVerified: true });
  const response = await fetch(
    `${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const { idToken } = await response.json();
  const session = await fetch(`${origin}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ idToken }),
  });
  people[name] = {
    uid: user.uid,
    cookie: /__session=([^;]+)/.exec(session.headers.get('set-cookie') ?? '')?.[1],
  };
}

const item = (ownerUid, credentialName) => ({
  ownerUid,
  templateId: 'tpl',
  issuerId: 'school-a',
  issuerType: 'institution',
  issuerName: 'Sunrise Public School',
  credentialName,
  recipientName: 'Asha Verma',
  issuedAt: Timestamp.now(),
  expiresAt: null,
  status: 'valid',
  revokedAt: null,
  shareId: null,
});
await db.doc('institutions/school-a').set({ name: 'Sunrise Public School', verified: true });
await db.doc('vault_items/asha-1').set(item(people.asha.uid, 'Class 10 Certificate'));
await db.doc('vault_items/asha-2').set(item(people.asha.uid, 'Science Fair Winner'));
await db.doc('vault_items/ravi-1').set(item(people.ravi.uid, 'Ravi Private Credential'));

const share = (who, itemId, enabled) =>
  fetch(`${origin}/api/vault/share`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      ...(who ? { cookie: `__session=${people[who].cookie}` } : {}),
    },
    body: JSON.stringify({ itemId, enabled }),
  });

try {
  console.log('API');
  check((await share(null, 'asha-1', true)).status === 401, 'signed-out share is refused (401)');
  check((await share('ravi', 'asha-1', true)).status === 404, "another user's item is 404");
  check(
    (await db.doc('vault_items/asha-1').get()).get('shareId') === null,
    'refused calls changed nothing',
  );

  console.log('Browser (phone)');
  const { chromium, devices } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ ...devices['Pixel 7'] });
    await context.addCookies([{ name: '__session', value: people.asha.cookie, url: origin }]);
    const page = await context.newPage();
    await page.goto(`${origin}/dashboard/vault`);
    await page.waitForSelector('[data-testid="vault-grid"]');
    const text = await page.textContent('[data-testid="vault-grid"]');
    check((await page.locator('[data-testid="vault-item"]').count()) === 2, 'two own items shown');
    check(!text.includes('Ravi Private'), "another user's item is not shown");

    const card = page.locator('[data-item-id="asha-1"]');
    await card.getByRole('button', { name: 'Generate Public Link' }).click();
    const url = await card.locator('[data-testid="vault-share-url"]').inputValue();
    check(/\/verify\/[A-Za-z0-9_-]{43}$/.test(url), 'a public link appears', url);
    await page.screenshot({ path: join(root, 'tests', 'output', 'vault.png') }).catch(() => {});

    const anon = await browser.newContext();
    const publicPage = await anon.newPage();
    await publicPage.goto(url);
    const shown = await publicPage.textContent('body');
    check(shown.includes('Class 10 Certificate'), 'public page shows the credential, no session');
    check(shown.includes('Verified') && !shown.includes('REVOKED'), 'public page says verified');
    check(shown.includes('Verified institution'), 'verified institution is noted');
    check(
      (await publicPage.locator('[data-testid="add-to-linkedin"]').count()) === 1,
      'a valid credential offers Add to LinkedIn',
    );
    // Links shared before Phase 13 used /v/{id}: they still arrive.
    await publicPage.goto(url.replace('/verify/', '/v/'));
    check(publicPage.url() === url, 'the old /v/ link redirects to /verify/', publicPage.url());

    await card.getByRole('button', { name: /Stop sharing/ }).click();
    await card.getByRole('button', { name: 'Generate Public Link' }).waitFor();
    await publicPage.goto(url);
    check(
      (await publicPage.locator('[data-testid="share-missing"]').count()) === 1,
      'link stops working after "Stop sharing"',
    );
  } finally {
    await browser.close();
  }
} catch (error) {
  failures++;
  console.log('  FAIL  unexpected error', error);
} finally {
  child.kill();
}
if (failures) console.log(serverLog.split('\n').slice(-15).join('\n'));
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
