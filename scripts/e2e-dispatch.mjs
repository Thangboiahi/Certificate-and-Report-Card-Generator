/**
 * End-to-end check of Phase 5 on the PRODUCTION build, with Firebase Auth + Firestore emulated and
 * the WhatsApp Cloud API and Resend replaced by a local recording server:
 *
 *   - /api/dispatch/whatsapp and /api/dispatch/email: auth, same-origin, validation, credits
 *     deducted before sending, refunds for failed recipients, idempotent replays, 402 when credits
 *     run out, membership and verification checks, 503 when not configured;
 *   - server-minted claim tokens, the audit ledger and "1-Click Re-Issue" (Phase 6) in Chromium;
 *   - the claim-token purge route;
 *   - the Kanban board in Chromium: mouse, keyboard and touch drags.
 *
 *     npm run build
 *     npx firebase emulators:exec --only auth,firestore --project demo-v6 'node scripts/e2e-dispatch.mjs'
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
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
const out = join(root, 'tests', 'output');
mkdirSync(out, { recursive: true });

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

const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

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

// ── Mock providers ───────────────────────────────────────────────────────────────────────────────

const provider = { whatsapp: [], email: [] };
const mockPort = await freePort();
const mock = createHttpServer((request, response) => {
  let raw = '';
  request.on('data', (chunk) => (raw += chunk));
  request.on('end', () => {
    const body = JSON.parse(raw || 'null');
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v23.0/1234567890/messages') {
      provider.whatsapp.push({ auth: request.headers.authorization, body });
      if (body.to.endsWith('99')) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: { code: 131026, message: 'undeliverable' } }));
        return;
      }
      response.end(JSON.stringify({ messages: [{ id: `wamid.${provider.whatsapp.length}` }] }));
      return;
    }
    if (request.url === '/emails/batch') {
      provider.email.push({
        auth: request.headers.authorization,
        key: request.headers['idempotency-key'],
        body,
      });
      response.end(JSON.stringify({ data: body.map((_, i) => ({ id: `em_${i}` })) }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
});
await new Promise((resolve) => mock.listen(mockPort, '127.0.0.1', resolve));
const mockOrigin = `http://127.0.0.1:${mockPort}`;

// ── App server ───────────────────────────────────────────────────────────────────────────────────

async function startServer(env) {
  const port = await freePort();
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
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => (log += chunk));
  child.stderr.on('data', (chunk) => (log += chunk));
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
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

const CRON_SECRET = 'cron-secret-for-e2e-0123456789abcdef';
const PROVIDERS = {
  CRON_SECRET,
  WHATSAPP_ACCESS_TOKEN: 'test-whatsapp-token',
  WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  WHATSAPP_CLAIM_TEMPLATE: 'credential_claim',
  WHATSAPP_API_BASE_URL: `${mockOrigin}/v23.0`,
  RESEND_API_KEY: 're_test_key',
  RESEND_FROM: 'Claims <claims@example.in>',
  RESEND_BASE_URL: mockOrigin,
};

// ── Data ─────────────────────────────────────────────────────────────────────────────────────────

const stamp = Date.now();
const people = {};
for (const [name, claims] of Object.entries({
  staff: { role: 'inst_staff', institutionId: 'school-a' },
  formerStaff: { role: 'inst_staff', institutionId: 'school-a' },
  unverifiedAdmin: { role: 'inst_admin', institutionId: 'school-b' },
  individual: {},
})) {
  const email = `${name.toLowerCase()}-${stamp}@example.in`;
  const { localId } = await identityToolkit('signUp', { email, password });
  if (Object.keys(claims).length) await auth.setCustomUserClaims(localId, claims);
  people[name] = { uid: localId, email };
}
await db.doc('institutions/school-a').set({
  name: 'Sunrise Public School',
  adminUid: null,
  staffUids: [people.staff.uid],
  creditBalance: 10,
  verified: true,
});
await db.doc('institutions/school-b').set({
  name: 'Unverified Academy',
  adminUid: people.unverifiedAdmin.uid,
  staffUids: [],
  creditBalance: 50,
  verified: false,
});
const balance = async () => (await db.doc('institutions/school-a').get()).get('creditBalance');

await db.doc('templates/tpl-cert').set({
  ownerUid: people.staff.uid,
  institutionId: 'school-a',
  name: 'Class 10 certificate',
});
const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();
const FUTURE_TEXT = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
}).format(new Date(FUTURE));
const CLAIM_LINK = (origin) => new RegExp(`^${origin}/claim/[A-Za-z0-9_-]{43}$`);
const waTarget = (i, phone = `98765432${String(i).padStart(2, '0')}`) => ({
  recipientName: `Student ${i}`,
  phone,
});

const server = await startServer(PROVIDERS);
try {
  for (const person of Object.values(people)) {
    const { idToken } = await identityToolkit('signInWithPassword', {
      email: person.email,
      password,
    });
    const response = await fetch(`${server.origin}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.origin },
      body: JSON.stringify({ idToken }),
    });
    person.cookie = /__session=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
  }

  const post = async (channel, body, { who = 'staff', origin = server.origin } = {}) => {
    const response = await fetch(`${server.origin}/api/dispatch/${channel}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        ...(who ? { cookie: `__session=${people[who].cookie}` } : {}),
      },
      body: JSON.stringify({ templateId: 'tpl-cert', tokenExpiry: FUTURE, ...body }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  console.log('\nAccess');
  const body = { idempotencyKey: 'e2e-wa-0001', targets: [waTarget(1)] };
  let r = await post('whatsapp', body, { who: null });
  check(r.status === 401, `signed out → 401 (${r.status})`);
  r = await post('whatsapp', body, { who: 'individual' });
  check(r.status === 403 && r.body?.error?.code === 'FORBIDDEN', `individual → 403 (${r.status})`);
  r = await post('whatsapp', body, { origin: 'https://evil.example' });
  check(r.status === 403 && r.body?.error?.code === 'CROSS_ORIGIN', 'cross-site POST → 403');
  r = await post('whatsapp', body, { who: 'formerStaff' });
  check(
    r.body?.error?.code === 'NOT_INSTITUTION_MEMBER',
    `claims without directory membership → 403 ${r.body?.error?.code}`,
  );
  r = await post('whatsapp', body, { who: 'unverifiedAdmin' });
  check(
    r.status === 403 && r.body?.error?.code === 'INSTITUTION_NOT_VERIFIED',
    'unverified institution → 403',
  );
  r = await post('whatsapp', { ...body, targets: [{ ...waTarget(1), phone: '12' }] });
  check(r.status === 400 && /phone/.test(r.body?.error?.message), `invalid phone → 400`);
  check(provider.whatsapp.length === 0 && (await balance()) === 10, 'nothing sent or charged yet');

  console.log('\nWhatsApp');
  r = await post('whatsapp', {
    idempotencyKey: 'e2e-wa-0002',
    targets: [waTarget(1), waTarget(2), waTarget(3, '9876543299')],
  });
  check(
    r.status === 200 &&
      r.body.sent === 2 &&
      r.body.failed === 1 &&
      r.body.creditsCharged === 3 &&
      r.body.creditsRefunded === 1 &&
      r.body.creditBalance === 8,
    `3 recipients, 1 undeliverable → charged 3, refunded 1, balance 8`,
    JSON.stringify(r.body),
  );
  check((await balance()) === 8, 'Firestore balance is 8');
  const waBatchId = r.body?.batchId;
  const message = provider.whatsapp[0];
  const params = message?.body.template.components[0].parameters.map((p) => p.text);
  check(
    message?.auth === 'Bearer test-whatsapp-token' &&
      message.body.to === '919876543201' &&
      message.body.template.name === 'credential_claim' &&
      params?.[0] === 'Student 1' &&
      params?.[1] === 'Sunrise Public School' &&
      CLAIM_LINK(server.origin).test(params?.[2] ?? '') &&
      params?.[3] === FUTURE_TEXT,
    'Utility template: name, issuer, claim link on our origin, expiry',
    JSON.stringify(message?.body),
  );
  r = await post('whatsapp', {
    idempotencyKey: 'e2e-wa-0002',
    targets: [waTarget(1), waTarget(2), waTarget(3, '9876543299')],
  });
  check(
    r.status === 200 && r.body.replayed === true && provider.whatsapp.length === 3,
    'same idempotency key → replayed, nothing re-sent',
  );
  check((await balance()) === 8, 'and nothing re-charged');

  console.log('\nEmail');
  r = await post('email', {
    idempotencyKey: 'e2e-em-0001',
    targets: [
      {
        recipientName: 'Asha <b>',
        email: 'Asha@Example.in',
      },
      {
        recipientName: 'Ravi',
        email: 'ravi@example.in',
      },
    ],
  });
  const batch = provider.email[0];
  check(
    r.status === 200 && r.body.sent === 2 && r.body.creditBalance === 6,
    `2 emails → balance 6 (${r.status})`,
    JSON.stringify(r.body),
  );
  check(
    batch?.auth === 'Bearer re_test_key' &&
      typeof batch.key === 'string' &&
      batch.body.length === 2 &&
      batch.body[0].from === 'Claims <claims@example.in>' &&
      batch.body[0].to[0] === 'asha@example.in' &&
      batch.body[0].html.includes('Asha &lt;b&gt;') &&
      new RegExp(`${server.origin}/claim/[A-Za-z0-9_-]{43}`).test(batch.body[0].html) &&
      batch.body[0].html.includes(`expires on ${FUTURE_TEXT}`),
    'one Resend batch with idempotency key, escaped name, claim link and expiry warning',
  );

  console.log('\nCredits');
  r = await post('whatsapp', {
    idempotencyKey: 'e2e-wa-0003',
    targets: Array.from({ length: 7 }, (_, i) => waTarget(10 + i)),
  });
  check(
    r.status === 402 &&
      r.body?.error?.code === 'INSUFFICIENT_CREDITS' &&
      r.body.error.details?.required === 7 &&
      r.body.error.details?.available === 6,
    '7 recipients with 6 credits → 402, nothing sent',
  );
  check(
    (await balance()) === 6 && provider.whatsapp.length === 3,
    'balance and provider untouched',
  );
  const ledger = await db.collection('dispatches').where('institutionId', '==', 'school-a').get();
  check(
    ledger.size === 2 && ledger.docs.every((d) => d.get('status') === 'completed'),
    'two completed dispatch records',
  );
  check(
    !JSON.stringify(ledger.docs.map((d) => d.data())).includes('98765'),
    'dispatch records hold no phone numbers or emails',
  );
  const tokens = await db.collection('claim_tokens').get();
  const sentLinks = [
    ...provider.whatsapp.map((m) => m.body.template.components[0].parameters[2].text),
    ...provider.email[0].body.map((e) => /\/claim\/([A-Za-z0-9_-]{43})/.exec(e.text)?.[1]),
  ];
  check(
    tokens.size === 5 &&
      tokens.docs.every((d) => /^[a-f0-9]{64}$/.test(d.id)) &&
      sentLinks.every((link) => link && !tokens.docs.some((d) => link.endsWith(d.id))),
    '5 claim tokens stored by SHA-256 only (no working link in the database)',
  );
  const batches = await db
    .collection('issued_batches')
    .where('institutionId', '==', 'school-a')
    .get();
  check(
    batches.size === 2 &&
      batches.docs.every(
        (d) =>
          d.get('templateName') === 'Class 10 certificate' &&
          d.get('issuerUid') === people.staff.uid &&
          d.get('tokenExpiry').toMillis() === Date.parse(FUTURE),
      ),
    'two issued batches in the audit ledger with issuer, template and link expiry',
  );
  r = await post('whatsapp', {
    idempotencyKey: 'e2e-wa-0004',
    targets: [waTarget(1)],
    tokenExpiry: new Date(Date.now() + 120 * 86_400_000).toISOString(),
  });
  check(
    r.status === 400 && /90 days/.test(r.body?.error?.message),
    'links longer than 90 days → 400',
  );

  console.log('\nPurge route');
  const purge = (secret) =>
    fetch(`${server.origin}/api/cron/purge-claim-tokens`, {
      method: 'POST',
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    });
  let purged = await purge(null);
  check(purged.status === 401, `no secret → 401 (${purged.status})`);
  purged = await purge('x'.repeat(40));
  check(purged.status === 401, 'wrong secret → 401');
  purged = await purge(CRON_SECRET);
  const purgedBody = await purged.json();
  check(
    purged.status === 200 && purgedBody.deleted === 0 && purgedBody.batchesPurged === 0,
    'right secret → 200, nothing expired yet so nothing purged',
  );

  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch();
  try {
    console.log('\nAudit ledger and 1-Click Re-Issue (Chromium)');
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addCookies([
        { name: '__session', value: people.staff.cookie, url: server.origin },
      ]);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${server.origin}/dashboard/institution`);
      await page.getByTestId('audit-ledger').waitFor();
      const rows = page.getByTestId('ledger-row');
      check((await rows.count()) === 2, `ledger lists the 2 batches (${await rows.count()})`);
      const waRow = page.locator(`[data-testid=ledger-row][data-batch-id="${waBatchId}"]`);
      check(
        /Class 10 certificate/.test(await waRow.innerText()) &&
          /3\s*\(2 sent, 1 failed\)/.test(await waRow.innerText()) &&
          /30 days left/.test(await waRow.innerText()),
        'row shows template, 3 recipients (2 sent, 1 failed) and "30 days left"',
        await waRow.innerText(),
      );
      const before = { messages: provider.whatsapp.length, balance: await balance() };
      const oldLinks = new Set(
        provider.whatsapp.map((m) => m.body.template.components[0].parameters[2].text),
      );
      await waRow.getByTestId('reissue').click();
      const status = waRow.getByTestId('reissue-status');
      await status.waitFor({ timeout: 15_000 });
      const reissued = provider.whatsapp.slice(before.messages);
      check(
        /Sent 2 of 3 new links · 1 failed · no credits used/.test(await status.innerText()),
        `re-issue reports the result (${await status.innerText()})`,
      );
      check(
        reissued.length === 3 &&
          reissued.every((m) => {
            const link = m.body.template.components[0].parameters[2].text;
            return CLAIM_LINK(server.origin).test(link) && !oldLinks.has(link);
          }),
        'all 3 unclaimed recipients got a NEW link through WhatsApp',
      );
      check((await balance()) === before.balance, `no credits used (balance ${await balance()})`);
      check(
        /Just re-issued/.test(await waRow.getByTestId('reissue').innerText()) &&
          (await waRow.getByTestId('reissue').isDisabled()) &&
          /1\/3 re-issues/.test(await waRow.innerText()),
        'button now shows the cooldown and 1/3 re-issues',
      );
      const again = await fetch(`${server.origin}/api/dispatch/reissue`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: server.origin,
          cookie: `__session=${people.staff.cookie}`,
        },
        body: JSON.stringify({ batchId: waBatchId }),
      });
      const againBody = await again.json();
      check(
        again.status === 409 && againBody.error.details?.reason === 'cooldown',
        'an immediate second re-issue → 409 cooldown',
      );
      const foreign = await fetch(`${server.origin}/api/dispatch/reissue`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: server.origin,
          cookie: `__session=${people.unverifiedAdmin.cookie}`,
        },
        body: JSON.stringify({ batchId: waBatchId }),
      });
      check(foreign.status === 404, `another institution's admin → 404 (${foreign.status})`);
      await page.screenshot({ path: join(out, 'e2e-audit-ledger.png'), fullPage: true });
      check(errors.length === 0, 'ledger: no script errors', errors.join(' | '));
      await context.close();
    }

    console.log('\nKanban board (Chromium)');
    // The board reads real documents: put the six demo cards in school-a's board before each run,
    // because a drag now persists.
    const seedBoard = async () => {
      const existing = await db
        .collection('credential_requests')
        .where('ownerKey', '==', 'inst:school-a')
        .get();
      await Promise.all(existing.docs.map((doc) => doc.ref.delete()));
      const now = Date.now();
      const cards = [
        ['rq-101', 'new', 0, 'Aarav Sharma', 'Class 10 certificate', { phone: '9876543210' }, 1],
        ['rq-102', 'new', 1, 'Fatima Sheikh', 'Bonafide letter', { email: 'fatima@example.in' }, 5],
        [
          'rq-103',
          'pending_data',
          0,
          'Rahul Verma',
          'Class 10 certificate',
          { note: 'Photo missing' },
          26,
        ],
        [
          'rq-104',
          'pending_data',
          1,
          'Meera Nair',
          'Sports participation',
          { note: 'Date of birth to confirm' },
          50,
        ],
        [
          'rq-105',
          'ready',
          0,
          'Priyanka Tripathi',
          'Class 10 certificate',
          { email: 'priyanka@example.in' },
          3,
        ],
        [
          'rq-106',
          'issued',
          0,
          'Venkata Subramanian',
          'Olympiad merit certificate',
          { phone: '9000000001' },
          80,
        ],
      ];
      for (const [id, stage, position, recipientName, credential, extra, age] of cards) {
        const at = Timestamp.fromMillis(now - age * 3_600_000);
        await db
          .collection('credential_requests')
          .doc(id)
          .set({
            ownerKey: 'inst:school-a',
            stage,
            order: position * 1024,
            recipientName,
            credential,
            ...extra,
            createdByUid: 'seed',
            createdAt: at,
            updatedAt: at,
          });
      }
    };
    for (const [label, options] of [
      ['desktop', { viewport: { width: 1280, height: 900 } }],
      ['phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
    ]) {
      await seedBoard();
      const context = await browser.newContext(options);
      await context.addCookies([
        { name: '__session', value: people.staff.cookie, url: server.origin },
      ]);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${server.origin}/dashboard/institution`);
      await page.getByTestId('kanban-board').waitFor();
      const count = async (stage) => Number(await page.getByTestId(`count-${stage}`).innerText());
      check(
        (await count('new')) === 2 &&
          (await count('pending_data')) === 2 &&
          (await count('ready')) === 1 &&
          (await count('issued')) === 1,
        `${label}: four columns with the sample requests`,
      );
      const cardIn = (stage, id) =>
        page.getByTestId(`column-${stage}`).locator(`[data-request-id="${id}"]`);

      if (label === 'desktop') {
        const card = await cardIn('new', 'rq-101').boundingBox();
        const target = await page.getByTestId('column-ready').boundingBox();
        await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
        await page.mouse.down();
        await page.mouse.move(card.x + card.width / 2 + 10, card.y + card.height / 2, { steps: 3 });
        await page.mouse.move(target.x + target.width / 2, target.y + target.height - 10, {
          steps: 20,
        });
        await page.mouse.up();
        await cardIn('ready', 'rq-101')
          .waitFor({ timeout: 3000 })
          .catch(() => undefined);
        check(
          (await cardIn('ready', 'rq-101').count()) === 1 && (await count('new')) === 1,
          'mouse: New Requests → Ready to Issue',
        );
        // The move is saved: it is in Firestore, and survives a reload.
        await page.waitForTimeout(500);
        check(
          (await db.collection('credential_requests').doc('rq-101').get()).get('stage') === 'ready',
          'mouse move persisted to Firestore',
        );
        await page.reload();
        await page.getByTestId('kanban-board').waitFor();
        check(
          (await cardIn('ready', 'rq-101').count()) === 1,
          'moved card is still there after a reload',
        );
        // Keyboard: Space lifts, → moves one column, Space drops.
        await cardIn('ready', 'rq-105').focus();
        await page.keyboard.press('Space');
        await page.waitForTimeout(200);
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(400);
        await page.keyboard.press('Space');
        await cardIn('issued', 'rq-105')
          .waitFor({ timeout: 3000 })
          .catch(() => undefined);
        check(
          (await cardIn('issued', 'rq-105').count()) === 1 && (await count('issued')) === 2,
          'keyboard: Ready to Issue → Issued',
        );
        await page.waitForTimeout(500);
        check(
          (await db.collection('credential_requests').doc('rq-105').get()).get('stage') ===
            'issued',
          'keyboard move persisted to Firestore',
        );
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(out, 'e2e-kanban-desktop.png') });
      } else {
        // Touch: press and hold, then drag down within the first column (reorder).
        const first = await cardIn('new', 'rq-101').boundingBox();
        const second = await cardIn('new', 'rq-102').boundingBox();
        const cdp = await context.newCDPSession(page);
        const start = { x: first.x + first.width / 2, y: first.y + first.height / 2 };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
        await page.waitForTimeout(400);
        const endY = second.y + second.height - 4;
        for (let i = 1; i <= 15; i++) {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: start.x, y: start.y + ((endY - start.y) * i) / 15 }],
          });
          await page.waitForTimeout(20);
        }
        await page.waitForTimeout(300);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(500);
        const order = await page
          .getByTestId('column-new')
          .locator('[data-testid=kanban-card]')
          .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-request-id')));
        check(order.join() === 'rq-102,rq-101', `touch: long-press drag reorders (${order})`);
        const strip = await page.getByTestId('column-new').evaluate((el) => {
          const scroller = el.closest('section').parentElement;
          return { scrollable: scroller.scrollWidth > scroller.clientWidth };
        });
        check(strip.scrollable, 'phone: columns scroll sideways');
        await page.screenshot({ path: join(out, 'e2e-kanban-phone.png') });
      }
      check(errors.length === 0, `${label}: no script errors`, errors.join(' | '));
      await context.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  await server.stop();
}

console.log('\nNot configured');
{
  const bare = await startServer({});
  try {
    const { idToken } = await identityToolkit('signInWithPassword', {
      email: people.staff.email,
      password,
    });
    const session = await fetch(`${bare.origin}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: bare.origin },
      body: JSON.stringify({ idToken }),
    });
    const cookie = /__session=([^;]+)/.exec(session.headers.get('set-cookie') ?? '')?.[1];
    const response = await fetch(`${bare.origin}/api/dispatch/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: bare.origin,
        cookie: `__session=${cookie}`,
      },
      body: JSON.stringify({ idempotencyKey: 'e2e-em-0009', targets: [] }),
    });
    const json = await response.json();
    check(
      response.status === 503 && json.error.code === 'DISPATCH_NOT_CONFIGURED',
      'no provider keys → 503 before anything is charged',
    );
    check((await balance()) === 6, 'balance unchanged');
    const cron = await fetch(`${bare.origin}/api/cron/purge-claim-tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    check(cron.status === 503, 'no CRON_SECRET → purge route answers 503');
  } finally {
    await bare.stop();
  }
}

mock.close();
console.log(
  failures === 0 ? '\nAll dispatch checks passed.' : `\n${failures} dispatch check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
