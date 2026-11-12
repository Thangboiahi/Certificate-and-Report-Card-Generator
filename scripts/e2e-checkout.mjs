/**
 * End-to-end check of Phase 8 (escrow payment engine) on the PRODUCTION build, with Firebase Auth
 * + Firestore emulated and Razorpay's API replaced by a local recording server:
 *
 *   - POST /api/checkout: auth, same-origin, contact match, pricing on the server, the Route
 *     transfer to the institution's Linked Account (on hold), refusals;
 *   - POST /api/webhooks/razorpay: unsigned, wrongly signed and tampered deliveries refused with
 *     nothing minted; a signed `payment.captured` mints the vault item and consumes the token;
 *     replays change nothing; a second paid order for the same credential is refunded with
 *     `reverse_all`;
 *   - GET /api/checkout: owner-only status, pull reconciliation when no webhook arrives;
 *   - the free claim path and the reconciliation cron route;
 *   - the claim page in Chromium (phone): cart with the AI add-on, Razorpay Checkout (stubbed),
 *     confirmation once the signed webhook has been processed.
 *
 *     npm run build
 *     npx firebase emulators:exec --only auth,firestore --project demo-v6 'node scripts/e2e-checkout.mjs'
 */
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
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
const DAY = 86_400_000;

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

// ── Mock Razorpay API ────────────────────────────────────────────────────────────────────────────

const KEY_ID = 'rzp_test_e2e00000001';
const KEY_SECRET = 'e2e-key-secret';
const WEBHOOK_SECRET = 'e2e-webhook-secret-0123456789';
const ACCOUNT = 'acc_E2ESchoolA00001';

const razorpay = { orders: [], payments: new Map(), refunds: [], calls: [] };
const rzpId = (prefix, n) => `${prefix}_E2E${String(n).padStart(11, '0')}`;

function capture(orderId, amount) {
  const order = razorpay.orders.find((o) => o.id === orderId);
  const payment = {
    id: rzpId('pay', razorpay.payments.size + 1),
    entity: 'payment',
    order_id: orderId,
    amount: amount ?? order.body.amount,
    currency: 'INR',
    status: 'captured',
    amount_refunded: 0,
    method: 'upi',
    email: 'customer@example.in',
  };
  razorpay.payments.set(payment.id, payment);
  return { ...payment };
}

const mockPort = await freePort();
const mock = createHttpServer((request, response) => {
  let raw = '';
  request.on('data', (chunk) => (raw += chunk));
  request.on('end', () => {
    const body = JSON.parse(raw || 'null');
    razorpay.calls.push({ method: request.method, url: request.url });
    response.setHeader('content-type', 'application/json');
    const reply = (status, json) => {
      response.statusCode = status;
      response.end(JSON.stringify(json));
    };
    const authorised =
      request.headers.authorization ===
      `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`;
    if (!authorised)
      return reply(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'auth' } });

    if (request.method === 'POST' && request.url === '/v1/orders') {
      const id = rzpId('order', razorpay.orders.length + 1);
      razorpay.orders.push({ id, body });
      return reply(200, {
        id,
        entity: 'order',
        amount: body.amount,
        currency: 'INR',
        status: 'created',
      });
    }
    let match = /^\/v1\/orders\/(order_\w+)\/payments$/.exec(request.url);
    if (request.method === 'GET' && match) {
      const items = [...razorpay.payments.values()].filter((p) => p.order_id === match[1]);
      return reply(200, { entity: 'collection', count: items.length, items });
    }
    match = /^\/v1\/payments\/(pay_\w+)$/.exec(request.url);
    if (request.method === 'GET' && match && razorpay.payments.has(match[1])) {
      return reply(200, razorpay.payments.get(match[1]));
    }
    match = /^\/v1\/payments\/(pay_\w+)\/refund$/.exec(request.url);
    if (request.method === 'POST' && match && razorpay.payments.has(match[1])) {
      const payment = razorpay.payments.get(match[1]);
      if (payment.amount_refunded + body.amount > payment.amount) {
        return reply(400, {
          error: { code: 'BAD_REQUEST_ERROR', description: 'greater than the available amount' },
        });
      }
      payment.amount_refunded += body.amount;
      const refund = {
        id: rzpId('rfnd', razorpay.refunds.length + 1),
        payment_id: match[1],
        ...body,
      };
      razorpay.refunds.push(refund);
      return reply(200, { ...refund, entity: 'refund', status: 'processed' });
    }
    return reply(404, { error: { code: 'BAD_REQUEST_ERROR', description: 'not found' } });
  });
});
await new Promise((resolve) => mock.listen(mockPort, '127.0.0.1', resolve));
const mockOrigin = `http://127.0.0.1:${mockPort}`;

// ── App server ───────────────────────────────────────────────────────────────────────────────────

const CRON_SECRET = 'cron-secret-for-e2e-0123456789abcdef';
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
    CRON_SECRET,
    RAZORPAY_KEY_ID: KEY_ID,
    RAZORPAY_KEY_SECRET: KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    RAZORPAY_API_BASE_URL: `${mockOrigin}/v1`,
    AI_ENRICHMENT_FEE_PAISE: '4900',
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

// ── Data ─────────────────────────────────────────────────────────────────────────────────────────

const stamp = Date.now();
const people = {};
for (const name of ['asha', 'ravi']) {
  const email = `${name}-${stamp}@example.in`;
  const user = await auth.createUser({ email, password, emailVerified: true });
  people[name] = { uid: user.uid, email };
  const { idToken } = await identityToolkit('signInWithPassword', { email, password });
  const session = await fetch(`${origin}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ idToken }),
  });
  people[name].cookie = /__session=([^;]+)/.exec(session.headers.get('set-cookie') ?? '')?.[1];
}

const school = (name, extra = {}) => ({
  name,
  adminUid: null,
  staffUids: ['staff-1'],
  creditBalance: 10,
  verified: true,
  ...extra,
});
await db
  .doc('institutions/school-a')
  .set(school('Sunrise Public School', { razorpayAccountId: ACCOUNT }));
await db.doc('institutions/school-b').set(school('No Payouts Academy'));
await db.doc('issued_batches/batch-e2e').set({
  issuerUid: 'staff-1',
  institutionId: 'school-a',
  templateId: 'tpl-cert',
  templateName: 'Class 10 certificate',
  claimedCount: 0,
});
const claimedCount = async () =>
  (await db.doc('issued_batches/batch-e2e').get()).get('claimedCount');

/** Writes a claim token as dispatch would (hash only) and returns the raw token and its id. */
async function claimToken({ feePaise = 10_000, institutionId = 'school-a', to = 'asha' } = {}) {
  const raw = randomBytes(32).toString('base64url');
  const id = createHash('sha256').update(raw).digest('hex');
  const expiresAt = Date.now() + 7 * DAY;
  await db.doc(`claim_tokens/${id}`).set({
    batchId: 'batch-e2e',
    institutionId,
    issuerUid: 'staff-1',
    channel: 'email',
    recipientName: 'Asha Verma',
    contact: people[to].email,
    expiresAt: Timestamp.fromMillis(expiresAt),
    purgeAfter: Timestamp.fromMillis(expiresAt + 30 * DAY),
    claimedAt: null,
    feePaise,
  });
  return { raw, id };
}

const call = async (method, path, { who = 'asha', body, from = origin } = {}) => {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      origin: from,
      ...(who ? { cookie: `__session=${people[who].cookie}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const sign = (raw, secret = WEBHOOK_SECRET) =>
  createHmac('sha256', secret).update(raw).digest('hex');
let eventCounter = 0;
async function webhook(payment, { event = 'payment.captured', signature, raw } = {}) {
  const body =
    raw ??
    JSON.stringify({
      entity: 'event',
      account_id: 'acc_PlatformMain001',
      event,
      contains: ['payment'],
      payload: { payment: { entity: payment } },
      created_at: Math.floor(Date.now() / 1000),
    });
  const response = await fetch(`${origin}/api/webhooks/razorpay`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-event-id': `evt_E2E${++eventCounter}`,
      ...(signature === null ? {} : { 'x-razorpay-signature': signature ?? sign(body) }),
    },
    body,
  });
  return { status: response.status, body: await response.json().catch(() => null), raw: body };
}

const vaultItem = async (id) => (await db.doc(`vault_items/${id}`).get()).data();
const order = async (id) => (await db.doc(`claim_orders/${id}`).get()).data();

try {
  const paid = await claimToken();
  const free = await claimToken({ feePaise: 0 });
  const noPayout = await claimToken({ institutionId: 'school-b' });

  console.log('\nCheckout: access and refusals');
  let r = await call('POST', '/api/checkout', { who: null, body: { token: paid.raw } });
  check(r.status === 401, `signed out → 401 (${r.status})`);
  r = await call('POST', '/api/checkout', {
    body: { token: paid.raw },
    from: 'https://evil.example',
  });
  check(
    r.status === 403 && r.body?.error?.code === 'CROSS_ORIGIN',
    `cross-site → 403 (${r.status})`,
  );
  r = await call('POST', '/api/checkout', { who: 'ravi', body: { token: paid.raw } });
  check(
    r.status === 403 && r.body?.error?.code === 'CONTACT_MISMATCH',
    `someone else's link → 403 CONTACT_MISMATCH (${r.body?.error?.code})`,
  );
  r = await call('POST', '/api/checkout', { body: { token: free.raw } });
  check(
    r.status === 409 && r.body?.error?.code === 'NOT_PAYABLE',
    `free credential → 409 (${r.status})`,
  );
  r = await call('POST', '/api/checkout', { body: { token: noPayout.raw } });
  check(
    r.status === 409 && r.body?.error?.code === 'ISSUER_NOT_PAYABLE',
    `institution without a Linked Account → 409 ISSUER_NOT_PAYABLE (${r.body?.error?.code})`,
  );
  r = await call('POST', '/api/checkout', { body: { token: paid.raw, addOns: ['free_money'] } });
  check(r.status === 400, `unknown add-on → 400 (${r.status})`);
  r = await call('POST', '/api/checkout', { body: { token: paid.raw, amount: 1 } });
  check(
    r.status === 200 && r.body.amount === 10_000,
    'a client-sent amount is ignored (₹100 charged)',
  );
  check(
    razorpay.orders.length === 1,
    `only that one order reached Razorpay (${razorpay.orders.length})`,
  );
  r = await call('POST', '/api/claim', { body: { token: paid.raw } });
  check(
    r.status === 402 && r.body?.error?.code === 'PAYMENT_REQUIRED',
    `free-claim route refuses a paid credential → 402 (${r.status})`,
  );

  console.log('\nCheckout: cart, split and escrow');
  r = await call('POST', '/api/checkout', { body: { token: paid.raw, addOns: ['ai_enrichment'] } });
  const checkout = r.body;
  check(
    r.status === 200 &&
      checkout.amount === 14_900 &&
      checkout.keyId === KEY_ID &&
      checkout.cart.map((l) => `${l.kind}:${l.amountPaise}`).join() ===
        'base:10000,ai_enrichment:4900',
    `cart = Base ₹100 + AI ₹49 = ₹149 (${r.status} ${checkout?.amount})`,
  );
  const sent = razorpay.orders.at(-1);
  const transfer = sent.body.transfers?.[0];
  check(
    sent.id === checkout.orderId && sent.body.amount === 14_900 && sent.body.currency === 'INR',
    'Razorpay order amount = cart total, INR',
  );
  check(
    sent.body.transfers.length === 1 &&
      transfer.account === ACCOUNT &&
      transfer.amount === 9_000 &&
      transfer.currency === 'INR',
    `Route transfer: ₹90 (Base − 10 % platform fee) to the institution's Linked Account (${JSON.stringify(transfer)})`,
  );
  const holdDays = (transfer.on_hold_until * 1000 - Date.now()) / DAY;
  check(
    transfer.on_hold === true && holdDays > 6.99 && holdDays <= 7,
    `transfer held in escrow for 7 days (${holdDays.toFixed(3)})`,
  );
  check(
    !/asha|Asha|example\.in/.test(JSON.stringify(sent.body)),
    'no personal data in the Razorpay order',
  );
  const stored = await order(checkout.orderId);
  check(
    stored?.status === 'created' &&
      stored.uid === people.asha.uid &&
      stored.split.platformPaise === 5_900 &&
      stored.split.issuerPaise === 9_000,
    'claim_orders records payer, split (platform ₹59 / issuer ₹90) and status created',
  );

  console.log('\nWebhook: signature');
  const payment = capture(checkout.orderId);
  r = await webhook(payment, { signature: null });
  check(r.status === 401, `unsigned → 401 (${r.status})`);
  r = await webhook(payment, { signature: sign('x'.repeat(10)) });
  check(r.status === 401, `wrong signature → 401 (${r.status})`);
  const genuine = await webhook(payment, { signature: 'f'.repeat(64), raw: undefined });
  check(genuine.status === 401, 'garbage signature → 401');
  const forgedRaw = genuine.raw.replace('"amount":14900', '"amount":100');
  r = await webhook(payment, { raw: forgedRaw, signature: sign(genuine.raw) });
  check(r.status === 401, `body tampered after signing → 401 (${r.status})`);
  r = await webhook(payment, {
    signature: createHmac('sha256', 'guess').update(genuine.raw).digest('hex'),
    raw: genuine.raw,
  });
  check(r.status === 401, `signed with another secret → 401 (${r.status})`);
  check(!(await vaultItem(paid.id)), 'nothing minted by any rejected delivery');
  r = await webhook(payment, { event: 'payment.authorized' });
  check(
    r.status === 200 && r.body.ignored === 'payment.authorized',
    'payment.authorized → 200, ignored',
  );
  check(!(await vaultItem(paid.id)), 'authorization alone mints nothing');

  console.log('\nWebhook: payment.captured');
  r = await webhook(payment);
  check(
    r.status === 200 && r.body.outcome === 'minted',
    `captured → 200 minted (${JSON.stringify(r.body)})`,
  );
  const item = await vaultItem(paid.id);
  check(
    item?.ownerUid === people.asha.uid &&
      item.paymentId === payment.id &&
      item.orderId === checkout.orderId &&
      item.addOns?.join() === 'ai_enrichment' &&
      item.issuerName === 'Sunrise Public School',
    'vault item minted for the payer, with payment, order and add-on',
  );
  const token = (await db.doc(`claim_tokens/${paid.id}`).get()).data();
  check(
    token.claimedAt instanceof Timestamp && token.claimedByUid === people.asha.uid,
    'claim token consumed',
  );
  check((await order(checkout.orderId)).status === 'paid', 'order paid (settled by webhook)');
  r = await webhook(payment);
  check(
    r.status === 200 && r.body.outcome === 'already_settled',
    'replayed delivery → already_settled',
  );
  check((await claimedCount()) === 1, 'claim counted once');

  console.log('\nStatus');
  r = await call('GET', `/api/checkout?orderId=${checkout.orderId}`);
  check(
    r.status === 200 && r.body.status === 'paid' && r.body.vaultItemId === paid.id,
    `payer sees paid + vault item (${JSON.stringify(r.body)})`,
  );
  r = await call('GET', `/api/checkout?orderId=${checkout.orderId}`, { who: 'ravi' });
  check(r.status === 404, `someone else → 404 (${r.status})`);
  r = await call('GET', `/api/checkout?orderId=${checkout.orderId}`, { who: null });
  check(r.status === 401, `signed out → 401 (${r.status})`);
  r = await call('GET', '/api/checkout?orderId=../../etc');
  check(r.status === 400, `malformed id → 400 (${r.status})`);

  console.log('\nPull reconciliation (webhook never arrives)');
  const late = await claimToken();
  const lateCheckout = (await call('POST', '/api/checkout', { body: { token: late.raw } })).body;
  capture(lateCheckout.orderId);
  let lateStatus;
  for (let i = 0; i < 20; i++) {
    lateStatus = (await call('GET', `/api/checkout?orderId=${lateCheckout.orderId}`)).body;
    if (lateStatus?.status === 'paid') break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  check(
    lateStatus?.status === 'paid',
    `status poll pulled the capture from Razorpay (${lateStatus?.status})`,
  );
  check(
    (await order(lateCheckout.orderId))?.settledBy === 'reconcile',
    'settled by reconciliation',
  );
  check((await vaultItem(late.id))?.ownerUid === people.asha.uid, 'vault item minted');

  console.log('\nDuplicate payment → refund with transfer reversal');
  const twice = await claimToken();
  const first = (await call('POST', '/api/checkout', { body: { token: twice.raw } })).body;
  const second = (await call('POST', '/api/checkout', { body: { token: twice.raw } })).body;
  const p1 = capture(first.orderId);
  const p2 = capture(second.orderId);
  r = await webhook(p1);
  check(r.body?.outcome === 'minted', 'first payment mints');
  r = await webhook(p2);
  check(
    r.status === 200 && r.body?.outcome === 'refund_due',
    `second payment → refund_due (${r.body?.outcome})`,
  );
  const refund = razorpay.refunds.find((x) => x.payment_id === p2.id);
  check(
    refund?.amount === 10_000 &&
      refund.reverse_all === true &&
      refund.notes?.reason === 'already_claimed',
    `refunded in full with reverse_all (${JSON.stringify(refund)})`,
  );
  const refundedOrder = await order(second.orderId);
  check(
    refundedOrder.status === 'refunded' && refundedOrder.refundPending === false,
    `second order refunded (${refundedOrder.status})`,
  );
  r = await call('GET', `/api/checkout?orderId=${second.orderId}`);
  check(
    r.body?.status === 'refunded' && r.body.refundReason === 'already_claimed',
    'payer is told it was refunded and why',
  );
  check(
    (await vaultItem(twice.id))?.orderId === first.orderId,
    'credential belongs to the first order',
  );

  console.log('\nFree claim and the sweep route');
  r = await call('POST', '/api/claim', { body: { token: free.raw } });
  check(
    r.status === 200 && r.body.vaultItemId === free.id && !r.body.alreadyClaimed,
    'free credential claimed instantly',
  );
  let sweep = await fetch(`${origin}/api/cron/reconcile-payments`, { method: 'POST' });
  check(sweep.status === 401, `sweep without secret → 401 (${sweep.status})`);
  sweep = await fetch(`${origin}/api/cron/reconcile-payments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  const sweepBody = await sweep.json();
  check(
    sweep.status === 200 && typeof sweepBody.checked === 'number' && sweepBody.errors === 0,
    `sweep with secret → 200 (${JSON.stringify(sweepBody)})`,
  );

  console.log('\nClaim page in Chromium (phone)');
  const browserToken = await claimToken();
  const { chromium, devices } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ ...devices['Pixel 7'] });
    await context.addCookies([{ name: '__session', value: people.asha.cookie, url: origin }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const paidInBrowser = [];
    // Razorpay Checkout stand-in: "paying" captures the payment at the mock and delivers the
    // signed webhook, as Razorpay would; then calls the page's success handler.
    await page.exposeFunction('__e2ePay', async (orderId, amount) => {
      const captured = capture(orderId);
      paidInBrowser.push({ orderId, amount, paymentId: captured.id });
      await new Promise((resolve) => setTimeout(resolve, 1500)); // the webhook takes a moment
      return (await webhook(captured)).body;
    });
    await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `window.Razorpay = function (options) {
          this.open = async function () {
            window.__checkoutOptions = { key: options.key, order_id: options.order_id, amount: options.amount };
            await window.__e2ePay(options.order_id, options.amount);
            options.handler({ razorpay_payment_id: 'pay_fromBrowser', razorpay_order_id: options.order_id, razorpay_signature: 'not-trusted' });
          };
        };`,
      }),
    );
    await page.goto(`${origin}/claim/${browserToken.raw}`);
    await page.getByTestId('claim-pay').waitFor({ timeout: 15_000 });
    const total = page.getByTestId('cart-total');
    check(/100\.00/.test(await total.innerText()), `cart shows ₹100 (${await total.innerText()})`);
    await page.getByTestId('add-on-ai').check();
    check(
      /149\.00/.test(await total.innerText()),
      `AI add-on → total ₹149 (${await total.innerText()})`,
    );
    check(
      /149\.00/.test(await page.getByTestId('pay-and-claim').innerText()),
      'pay button shows the total',
    );
    await page.screenshot({ path: join(out, 'e2e-checkout-cart.png') });
    await page.getByTestId('pay-and-claim').click();
    await page.getByTestId('claim-done').waitFor({ timeout: 30_000 });
    check(true, 'page confirms "Added to your vault" after the webhook');
    const options = await page.evaluate(() => window.__checkoutOptions);
    check(
      options?.key === KEY_ID && options.amount === 14_900 && /^order_E2E/.test(options.order_id),
      `Checkout opened with key, order and ₹149 (${JSON.stringify(options)})`,
    );
    const minted = await vaultItem(browserToken.id);
    check(
      minted?.ownerUid === people.asha.uid &&
        minted.addOns?.join() === 'ai_enrichment' &&
        minted.paymentId === paidInBrowser[0]?.paymentId,
      'vault item minted from the webhook (not from the browser’s callback)',
    );
    await page.screenshot({ path: join(out, 'e2e-checkout-done.png') });
    check(errors.length === 0, 'no script errors', errors.join('; '));
    await context.close();
  } finally {
    await browser.close();
  }
} finally {
  child.kill();
  mock.close();
}

if (failures > 0 && process.env.E2E_SHOW_SERVER_LOG) console.log(serverLog);
console.log(
  failures === 0 ? '\nAll checkout checks passed.' : `\n${failures} checkout check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
