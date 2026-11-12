/**
 * End-to-end check of authentication and route protection on the PRODUCTION build: the real
 * proxy, session route and guarded pages, served by the standalone server, with Firebase Auth and
 * Firestore emulated.
 *
 *     npm run build
 *     npx firebase emulators:exec --only auth,firestore --project demo-v6 'node scripts/e2e-auth.mjs'
 *
 * Besides the normal flows it sends raw, unnormalised request paths (encoded letters, case,
 * dot-segments, duplicate slashes) to make sure none of them reaches a protected page.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

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

// ── Firebase (emulated) ──────────────────────────────────────────────────────────────────────────

const app = initializeApp({ projectId: PROJECT_ID });
const auth = getAuth(app);
const db = getFirestore(app);
const authHost = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`;

async function identityToolkit(method, body) {
  const response = await fetch(
    `${authHost}/identitytoolkit.googleapis.com/v1/accounts:${method}?key=fake`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, returnSecureToken: true }),
    },
  );
  if (!response.ok) throw new Error(`${method}: ${await response.text()}`);
  return response.json();
}

const password = 'correct horse battery staple';
async function createUser(email) {
  return (await identityToolkit('signUp', { email, password })).localId;
}
async function idTokenFor(email) {
  return (await identityToolkit('signInWithPassword', { email, password })).idToken;
}

/** The custom claims the app's role functions would set (see src/lib/auth/customClaims.ts). */
const claims = {
  individual: {},
  staff: { role: 'inst_staff', institutionId: 'school-a' },
  admin: { role: 'inst_admin', institutionId: 'school-a' },
  root: { role: 'super_admin' },
};

// ── Server ───────────────────────────────────────────────────────────────────────────────────────

const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

async function startServer(extraEnvironment = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: standalone,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      FIREBASE_PROJECT_ID: PROJECT_ID,
      ALLOW_FIREBASE_EMULATOR: 'true',
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
      // not yet listening
    }
    if (child.exitCode !== null || Date.now() > deadline)
      throw new Error(`server did not start\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return {
    origin,
    port,
    log: () => log,
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill();
      }),
  };
}

/** A GET with the path sent exactly as written (no client-side normalisation). */
function rawGet(port, path, cookie, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { ...(cookie ? { cookie: `__session=${cookie}` } : {}), ...headers },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, headers: response.headers, body }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

async function createSession(origin, idToken, requestOrigin = origin) {
  const response = await fetch(`${origin}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: requestOrigin },
    body: JSON.stringify({ idToken }),
  });
  const setCookie = response.headers.get('set-cookie') ?? '';
  return {
    status: response.status,
    setCookie,
    cookie: /__session=([^;]+)/.exec(setCookie)?.[1] ?? null,
  };
}

const guardedRole = (body) => /data-testid="guarded" data-role="([a-z_]+)"/.exec(body)?.[1] ?? null;

// ── Run ──────────────────────────────────────────────────────────────────────────────────────────

const stamp = Date.now();
await db.collection('institutions').doc('school-a').set({
  name: 'Sunrise Public School',
  adminUid: null,
  staffUids: [],
  creditBalance: 100,
  verified: true,
});
const people = {};
for (const [name, value] of Object.entries(claims)) {
  const email = `${name}-${stamp}@example.in`;
  const uid = await createUser(email);
  if (Object.keys(value).length > 0) await auth.setCustomUserClaims(uid, value);
  people[name] = { uid, email };
}

const server = await startServer();
try {
  console.log('\nSessions');
  for (const name of Object.keys(people)) {
    const result = await createSession(server.origin, await idTokenFor(people[name].email));
    people[name].cookie = result.cookie;
    check(
      result.status === 204 && result.cookie,
      `${name}: POST /api/auth/session sets a cookie`,
      `HTTP ${result.status}`,
    );
    if (name === 'individual') {
      check(
        /HttpOnly/i.test(result.setCookie) &&
          /SameSite=lax/i.test(result.setCookie) &&
          /Secure/i.test(result.setCookie),
        'the cookie is HttpOnly, Secure, SameSite=Lax',
      );
    }
  }
  const crossSite = await createSession(
    server.origin,
    await idTokenFor(people.individual.email),
    'https://evil.example',
  );
  check(
    crossSite.status === 403 && !crossSite.cookie,
    'a cross-site sign-in attempt is refused (403)',
  );

  console.log('\nRoute table');
  const expectations = [
    // who,        path,                       expected status, role shown by the guarded page
    [null, '/admin', 307],
    [null, '/dashboard/vault', 307],
    [null, '/dashboard/institution', 307],
    [null, '/dashboard/issue', 307],
    [null, '/editor', 200], // public: the Tap-to-Place editor
    ['individual', '/admin', 403],
    ['individual', '/dashboard/institution', 403],
    ['individual', '/dashboard/vault', 200, 'individual'],
    ['individual', '/dashboard/issue', 200, 'individual'],
    ['staff', '/dashboard/institution', 200, 'inst_staff'],
    ['staff', '/admin', 403],
    ['admin', '/dashboard/institution', 200, 'inst_admin'],
    ['admin', '/admin', 403],
    ['root', '/admin', 200, 'super_admin'],
    ['root', '/dashboard/institution', 403],
    ['root', '/dashboard/vault', 200, 'super_admin'],
  ];
  for (const [who, path, status, role] of expectations) {
    const response = await rawGet(server.port, path, who ? people[who].cookie : undefined);
    const shown = guardedRole(response.body);
    const ok = response.status === status && (role ? shown === role : shown === null);
    check(
      ok,
      `${who ?? 'signed out'} → ${path} → ${status}${role ? ` (${role})` : ''}`,
      `got ${response.status}, guarded role ${shown}`,
    );
    if (status === 307) {
      const location = response.headers.location ?? '';
      check(
        location.includes(`/login?next=${encodeURIComponent(path)}`),
        `   redirects to /login?next=${path}`,
        location,
      );
    }
  }

  console.log('\nDisguised paths (signed in as an individual; none may show admin content)');
  const disguises = [
    '/%61dmin',
    '/ADMIN',
    '/Admin',
    '//admin',
    '/admin/',
    '/admin//',
    '/./admin',
    '/api/../admin',
    '/_next/static/../../admin',
    '/editor/../admin',
    '/dashboard/%69nstitution',
    '/dashboard//institution',
    '/dashboard/vault/../institution',
  ];
  for (const path of disguises) {
    const response = await rawGet(server.port, path, people.individual.cookie);
    const shown = guardedRole(response.body);
    check(
      shown === null || shown === 'individual',
      `${path} → ${response.status}, no privileged content`,
      `guarded role ${shown}`,
    );
  }
  for (const path of ['/%61dmin', '/api/../admin', '/_next/static/../../admin']) {
    const response = await rawGet(server.port, path);
    const shown = guardedRole(response.body);
    check(
      shown === null,
      `${path} signed out → ${response.status}, no content`,
      `guarded role ${shown}`,
    );
  }

  console.log('\nWorkspace toggle (Chromium, signed in as an individual)');
  {
    const { chromium } = createRequire(import.meta.url)('playwright');
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      await context.addCookies([
        { name: '__session', value: people.individual.cookie, url: server.origin },
      ]);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${server.origin}/dashboard/vault`);
      const vaultTab = page.getByTestId('workspace-vault');
      const issueTab = page.getByTestId('workspace-issue');
      check(
        (await vaultTab.getAttribute('aria-selected')) === 'true' &&
          (await page.getByRole('heading', { level: 1 }).innerText()) === 'My Digital Vault',
        'the vault opens with "My Digital Vault" selected',
      );
      await issueTab.tap();
      await page.waitForURL('**/dashboard/issue');
      await page.getByRole('heading', { name: 'Issue Credentials' }).waitFor();
      check(
        (await issueTab.getAttribute('aria-selected')) === 'true' &&
          (await page.getByTestId('guarded').getAttribute('data-role')) === 'individual',
        'tapping "Issue Credentials" navigates to the guarded issuer workspace',
      );
      await page.waitForTimeout(600); // let the highlight settle
      await page.screenshot({ path: join(root, 'tests', 'output', 'e2e-workspace-issue.png') });
      await page.goBack();
      await page.waitForURL('**/dashboard/vault');
      await page.getByRole('heading', { name: 'My Digital Vault' }).waitFor();
      check(
        (await vaultTab.getAttribute('aria-selected')) === 'true',
        'Back returns to the vault and the toggle follows the address',
      );
      await page.getByTestId('workspace-issue').focus();
      await page.keyboard.press('Enter');
      await page.waitForURL('**/dashboard/issue');
      check(true, 'the toggle works from the keyboard');
      check(errors.length === 0, 'no script errors', errors.join(' | '));
      await context.close();
    } finally {
      await browser.close();
    }
  }

  console.log('\nRSC (client navigation) requests');
  const rsc = await rawGet(server.port, '/admin', people.individual.cookie, { RSC: '1' });
  check(
    rsc.status === 403 && guardedRole(rsc.body) === null,
    `individual → /admin as an RSC request → ${rsc.status}`,
  );

  console.log('\nRevocation');
  await new Promise((resolve) => setTimeout(resolve, 1100)); // revocation has one-second precision
  await auth.setCustomUserClaims(people.root.uid, {});
  await auth.revokeRefreshTokens(people.root.uid);
  const revoked = await rawGet(server.port, '/admin', people.root.cookie);
  check(
    revoked.status === 307,
    `a demoted super admin's old session is refused at /admin (${revoked.status})`,
  );
  check(
    /__session=;/.test(String(revoked.headers['set-cookie'] ?? '')),
    '   and the dead cookie is cleared',
  );

  console.log('\nSign out');
  const signOut = await fetch(`${server.origin}/api/auth/session`, {
    method: 'DELETE',
    headers: { origin: server.origin },
  });
  check(
    signOut.status === 204 && /__session=;/.test(signOut.headers.get('set-cookie') ?? ''),
    'DELETE /api/auth/session clears the cookie',
  );
} finally {
  await server.stop();
}

console.log('\nEmulator variables on Cloud Run (K_SERVICE set) must disable auth entirely');
{
  const cloudRun = await startServer({
    K_SERVICE: 'document-generator',
    ALLOW_FIREBASE_EMULATOR: 'true',
  });
  try {
    const session = await createSession(cloudRun.origin, await idTokenFor(people.individual.email));
    check(
      session.status === 500 && !session.cookie,
      `session creation refuses to run (${session.status})`,
    );
    const page = await rawGet(cloudRun.port, '/dashboard/vault', people.individual.cookie);
    check(
      page.status === 503 && guardedRole(page.body) === null,
      `protected pages fail closed (${page.status})`,
    );
  } finally {
    await cloudRun.stop();
  }
}

console.log(
  failures === 0
    ? '\nAll auth end-to-end checks passed.'
    : `\n${failures} auth end-to-end check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
