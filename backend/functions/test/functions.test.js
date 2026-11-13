'use strict';

// Runs index.js against an in-memory stand-in for Firestore/Auth, so the trigger and
// callable flows are exercised without a Firebase project or network.

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ---- tiny in-memory Firestore
const store = new Map();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const INC = Symbol('inc'), UNION = Symbol('union');
function applyPatch(cur, patch) {
  const out = clone(cur) || {};
  for (const [k, v] of Object.entries(patch)) {
    const keys = k.split('.');
    let o = out;
    for (let i = 0; i < keys.length - 1; i++) { o[keys[i]] = o[keys[i]] || {}; o = o[keys[i]]; }
    const last = keys[keys.length - 1];
    if (v && v[INC] !== undefined) o[last] = (o[last] || 0) + v[INC];
    else if (v && v[UNION]) o[last] = Array.from(new Set((o[last] || []).concat(v[UNION])));
    else o[last] = clone(v);
  }
  return out;
}
let autoId = 0;
function docRef(path) {
  const ref = {
    path,
    id: path.split('/').pop(),
    get parent() { const p = path.split('/'); return { id: p[p.length - 2] }; },
    async get() { const d = store.get(path); return { exists: d !== undefined, data: () => clone(d), ref }; },
    async set(data, opts) { store.set(path, opts && opts.merge ? applyPatch(store.get(path), data) : applyPatch({}, data)); },
    async update(patch) { if (!store.has(path)) throw new Error('no doc ' + path); store.set(path, applyPatch(store.get(path), patch)); },
    async delete() { store.delete(path); },
    collection: (name) => collRef(path + '/' + name)
  };
  return ref;
}
const getField = (o, k) => k.split('.').reduce((v, p) => (v == null ? undefined : v[p]), o);
const OPS = { '==': (a, b) => a === b, '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, in: (a, b) => b.includes(a) };
function query(path, steps) {
  const run = () => {
    let docs = [...store.entries()].filter(([k]) => k.startsWith(path + '/') && !k.slice(path.length + 1).includes('/'))
      .map(([k, v]) => ({ id: k.split('/').pop(), ref: docRef(k), data: () => clone(v) }));
    for (const s of steps) {
      if (s[0] === 'where') docs = docs.filter((d) => OPS[s[2]](getField(d.data(), s[1]), s[3]));
      if (s[0] === 'orderBy') docs.sort((a, b) => (getField(a.data(), s[1]) > getField(b.data(), s[1]) ? 1 : -1) * (s[2] === 'desc' ? -1 : 1));
      if (s[0] === 'limit') docs = docs.slice(0, s[1]);
    }
    return docs;
  };
  return {
    where: (...a) => query(path, steps.concat([['where', ...a]])),
    orderBy: (...a) => query(path, steps.concat([['orderBy', ...a]])),
    limit: (n) => query(path, steps.concat([['limit', n]])),
    select: () => query(path, steps),
    count: () => ({ get: async () => ({ data: () => ({ count: run().length }) }) }),
    async get() { return { docs: run() }; }
  };
}
function collRef(path) {
  return Object.assign(query(path, []), {
    doc: (id) => docRef(path + '/' + id),
    async add(data) { const id = 'auto' + (++autoId); await docRef(path + '/' + id).set(data); return { id }; }
  });
}
const db = {
  doc: docRef,
  collection: collRef,
  async runTransaction(fn) {
    const tx = { get: (r) => r.get(), set: (r, d, o) => r.set(d, o), update: (r, p) => r.update(p) };
    return fn(tx);
  }
};
const authCalls = [];
const claimsStore = {};
const fakeAdmin = {
  initializeApp() {},
  firestore: Object.assign(() => db, { FieldValue: { increment: (n) => ({ [INC]: n }), arrayUnion: (...a) => ({ [UNION]: a }) } }),
  auth: () => ({
    updateUser: async (uid, p) => authCalls.push(['update', uid, p]),
    revokeRefreshTokens: async (uid) => authCalls.push(['revoke', uid]),
    getUser: async (uid) => ({ uid, customClaims: claimsStore[uid] || {} }),
    setCustomUserClaims: async (uid, c) => { claimsStore[uid] = c; authCalls.push(['claims', uid, c]); }
  })
};
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const stubs = {
  'firebase-admin': fakeAdmin,
  'firebase-functions/v2/firestore': { onDocumentCreated: (o, h) => h, onDocumentUpdated: (o, h) => h },
  'firebase-functions/v2/https': { onCall: (o, h) => h, HttpsError },
  'firebase-functions/v2/scheduler': { onSchedule: (o, h) => h },
  'firebase-functions/params': { defineSecret: () => ({ value: () => '' }) } // no API key: rules only
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return stubs[req] || origLoad.call(this, req, ...rest); };
const fn = require('../index');
Module._load = origLoad;

// ---- helpers
async function seed() {
  store.clear(); authCalls.length = 0;
  await db.doc('bands/b1').set({ members: { sam: 'member', maya: 'admin', jo: 'member', ray: 'fillin' } });
}
async function post(id, author, text) {
  const ref = db.doc('bands/b1/posts/' + id);
  await ref.set({ authorId: author, text, createdAt: Date.now() });
  await fn.moderatePost({ data: await ref.get(), params: { bandId: 'b1', postId: id } });
  return (await ref.get()).data();
}
const call = (f, uid, data, claims) => f({ auth: { uid, token: Object.assign({}, claims) }, data });

test('swearing passes, kys is blurred, queued and warned', async () => {
  await seed();
  assert.strictEqual((await post('p1', 'sam', 'fucking great show')).moderation.status, 'clear');
  const p = await post('p2', 'sam', 'lol k.y.s');
  assert.deepStrictEqual([p.moderation.status, p.moderation.category, p.moderation.blurred], ['review', 'threat', true]);
  assert.strictEqual(store.get('modQueue/bands__b1__posts__p2').status, 'open');
  assert.strictEqual(store.get('standing/sam').warnings, 1);
});

test('third warning pauses, and paused posts are deleted', async () => {
  await seed();
  await post('a', 'sam', 'kys'); await post('b', 'sam', 'go die'); await post('c', 'sam', 'all mexicans are criminals');
  const s = store.get('standing/sam');
  assert.ok(s.pausedUntil > Date.now());
  await post('d', 'sam', 'hello');
  assert.strictEqual(store.has('bands/b1/posts/d'), false);
});

test('good fun from a bandmate clears a threat and removes the warning', async () => {
  await seed();
  await post('p', 'sam', 'kys lol');
  const r = await call(fn.answerGoodFun, 'jo', { path: 'bands/b1/posts/p', answer: 'fun' });
  assert.ok(r.cleared);
  assert.strictEqual(store.get('bands/b1/posts/p').moderation.blurred, false);
  assert.strictEqual(store.get('standing/sam').warnings, 0);
  assert.strictEqual(store.get('filterPrefs/jo').fun, 1);
  await assert.rejects(call(fn.answerGoodFun, 'sam', { path: 'bands/b1/posts/p', answer: 'fun' }), /own post/);
  await assert.rejects(call(fn.answerGoodFun, 'stranger', { path: 'bands/b1/posts/p', answer: 'fun' }), /Not a member/);
});

test('good fun never clears prejudice', async () => {
  await seed();
  await post('h', 'sam', 'go back where you came from');
  const r = await call(fn.answerGoodFun, 'jo', { path: 'bands/b1/posts/h', answer: 'fun' });
  assert.strictEqual(r.cleared, false);
  assert.strictEqual(store.get('bands/b1/posts/h').moderation.blurred, true);
  assert.strictEqual(store.get('standing/sam').warnings, 1);
});

test('reports: one per person, three people auto-blur', async () => {
  await seed();
  await post('q', 'sam', 'something the filter misses');
  await call(fn.reportContent, 'jo', { path: 'bands/b1/posts/q', reason: 'harassment', hide: true });
  await call(fn.reportContent, 'jo', { path: 'bands/b1/posts/q', reason: 'harassment' });
  assert.strictEqual(store.get('modQueue/bands__b1__posts__q').reports, 1);
  assert.deepStrictEqual(store.get('hidden/jo').paths, ['bands/b1/posts/q']);
  await call(fn.reportContent, 'maya', { path: 'bands/b1/posts/q', reason: 'prejudice' });
  await call(fn.reportContent, 'ray', { path: 'bands/b1/posts/q', reason: 'other' });
  const p = store.get('bands/b1/posts/q');
  assert.strictEqual(p.moderation.blurred, true);
  assert.strictEqual(store.get('modQueue/bands__b1__posts__q').priority, 'high');
});

test('moderator actions: only moderators; terminate disables the account', async () => {
  await seed();
  await post('t', 'sam', 'heil hitler');
  await assert.rejects(call(fn.moderatorAction, 'jo', { itemId: 'bands__b1__posts__t', action: 'terminate' }), /Moderators only/);
  await call(fn.moderatorAction, 'mod1', { itemId: 'bands__b1__posts__t', action: 'terminate', note: 'hate slogan' }, { moderator: true });
  assert.strictEqual(store.get('bands/b1/posts/t').moderation.status, 'removed');
  assert.strictEqual(store.get('standing/sam').status, 'terminated');
  assert.deepStrictEqual(authCalls[0], ['update', 'sam', { disabled: true }]);
  assert.strictEqual(store.get('modQueue/bands__b1__posts__t').resolution, 'terminate');
});

test('moderator dismiss clears content and removes the warning', async () => {
  await seed();
  await post('x', 'sam', 'go die');
  await call(fn.moderatorAction, 'mod1', { itemId: 'bands__b1__posts__x', action: 'dismiss' }, { moderator: true });
  assert.strictEqual(store.get('bands/b1/posts/x').moderation.blurred, false);
  assert.strictEqual(store.get('standing/sam').warnings, 0);
});

test('appeals land in the queue', async () => {
  await seed();
  const r = await call(fn.submitAppeal, 'sam', { message: 'It was an inside joke with my drummer.' });
  assert.strictEqual(store.get('modQueue/appeal__' + r.id).type, 'appeal');
});

// ================================================================ admin console
const ADMIN = { admin: true, email: 'brian@example.com' }, MOD = { moderator: true, email: 'mod@example.com' };
async function seedPeople() {
  await seed();
  const now = Date.now();
  await db.doc('users/sam').set({ name: 'Sam', email: 'sam@x.com', kind: 'musician', bands: ['b1'], plan: 'free', lastActive: now, joined: now - 5e9 });
  await db.doc('users/kara').set({ name: 'Kara', email: 'kara@x.com', kind: 'venue', bands: [], lastActive: now - 1e6, joined: now });
  await db.doc('standing/sam').set({ status: 'active', warnings: 2, strikes: [], pauses: [] });
}

test('adminListUsers: staff only, emails for admins only', async () => {
  await seedPeople();
  await assert.rejects(call(fn.adminListUsers, 'jo', {}), /Staff only/);
  const asMod = await call(fn.adminListUsers, 'm', {}, MOD);
  assert.strictEqual(asMod.users[0].uid, 'sam');
  assert.strictEqual(asMod.users[0].email, '');
  assert.strictEqual(asMod.users[0].warnings, 2);
  const asAdmin = await call(fn.adminListUsers, 'a', {}, ADMIN);
  assert.strictEqual(asAdmin.users[0].email, 'sam@x.com');
  assert.strictEqual(asAdmin.users[1].plan, 'Venue');
});

test('adminAction: moderators can suspend, only admins can terminate or grant Pro', async () => {
  await seedPeople();
  await assert.rejects(call(fn.adminAction, 'm', { kind: 'user', id: 'sam', action: 'suspend_7d' }, MOD), /note/);
  await call(fn.adminAction, 'm', { kind: 'user', id: 'sam', action: 'suspend_7d', note: 'harassing DMs' }, MOD);
  assert.strictEqual(store.get('standing/sam').status, 'suspended');
  assert.ok(store.get('standing/sam').suspendedUntil > Date.now());
  assert.deepStrictEqual(authCalls.pop(), ['revoke', 'sam']);
  await assert.rejects(call(fn.adminAction, 'm', { kind: 'user', id: 'sam', action: 'terminate', note: 'x' }, MOD), /Admins only/);
  await assert.rejects(call(fn.adminAction, 'm', { kind: 'user', id: 'sam', action: 'grant_pro', note: 'x' }, MOD), /Admins only/);
  await call(fn.adminAction, 'a', { kind: 'user', id: 'sam', action: 'grant_pro', note: 'early supporter' }, ADMIN);
  assert.strictEqual(store.get('bands/b1').plan.tier, 'pro');
  assert.strictEqual(store.get('bands/b1').plan.comp, true);
  const log = [...store.entries()].filter(([k]) => k.startsWith('adminLog/')).map(([, v]) => v);
  assert.strictEqual(log.length, 2);
  assert.strictEqual(log[1].note, 'early supporter');
});

test('adminAction: warn adds a strike, restore re-enables, no self-termination', async () => {
  await seedPeople();
  await call(fn.adminAction, 'm', { kind: 'user', id: 'sam', action: 'warn' }, MOD);
  // Third warning: posting paused and the count starts over.
  assert.ok(store.get('standing/sam').pausedUntil > Date.now());
  assert.strictEqual(store.get('standing/sam').warnings, 0);
  await call(fn.adminAction, 'a', { kind: 'user', id: 'sam', action: 'restore' }, ADMIN);
  assert.ok(authCalls.some((c) => c[0] === 'update' && c[2].disabled === false));
  await db.doc('users/a').set({ name: 'Admin' });
  await assert.rejects(call(fn.adminAction, 'a', { kind: 'user', id: 'a', action: 'terminate', note: 'oops' }, ADMIN), /own account/);
});

test('adminAction: make moderator sets the claim', async () => {
  await seedPeople();
  await call(fn.adminAction, 'a', { kind: 'user', id: 'kara', action: 'make_moderator', note: 'trusted booker' }, ADMIN);
  assert.deepStrictEqual(claimsStore.kara, { moderator: true });
  await call(fn.adminAction, 'a', { kind: 'user', id: 'kara', action: 'remove_moderator' }, ADMIN);
  assert.deepStrictEqual(claimsStore.kara, {});
});

test('venue verification marks the venue and only once', async () => {
  await seedPeople();
  await db.doc('venueClaims/c1').set({ name: 'The Rusty Nail', venueId: 'rusty', byUid: 'kara', status: 'pending' });
  await call(fn.adminAction, 'a', { kind: 'venue', id: 'c1', action: 'verify', note: 'called them' }, ADMIN);
  assert.strictEqual(store.get('venues/rusty').verified, true);
  await assert.rejects(call(fn.adminAction, 'a', { kind: 'venue', id: 'c1', action: 'reject', note: 'x' }, ADMIN), /Already decided/);
});

test('payout release and dispute resolve', async () => {
  await seedPeople();
  await db.doc('payoutReviews/p1').set({ band: 'Velvet Static', amount: 2400, status: 'review', notify: ['sam'] });
  await call(fn.adminAction, 'a', { kind: 'payout', id: 'p1', action: 'release', note: 'checked contract' }, ADMIN);
  assert.strictEqual(store.get('payoutReviews/p1').status, 'paid');
  await db.doc('disputes/d1').set({ parties: 'A ↔ B', status: 'open' });
  await call(fn.adminAction, 'a', { kind: 'dispute', id: 'd1', action: 'split', note: 'both counts plausible' }, ADMIN);
  assert.strictEqual(store.get('disputes/d1').outcome, 'split');
});

test('adminSetConfig validates, stores booleans and logs risky changes', async () => {
  await seedPeople();
  const cfg = { flags: { maintenance: [true, 'Maintenance mode', '...'], feedFilter: [true] }, moderation: { warningsBeforePause: 3, pauseHours: 24, pausesBeforeReview: 3, reportsToAutoHide: 3, hateThreshold: 0.5, threatThreshold: 0.55 }, minVersion: '1.2.0' };
  await assert.rejects(call(fn.adminSetConfig, 'm', { config: cfg, note: 'x' }, MOD), /Admins only/);
  await assert.rejects(call(fn.adminSetConfig, 'a', { config: Object.assign({}, cfg, { minVersion: 'new' }), note: 'x' }, ADMIN), /minVersion/);
  const r = await call(fn.adminSetConfig, 'a', { config: cfg, note: 'db upgrade' }, ADMIN);
  assert.deepStrictEqual(r.risky, ['maintenance on']);
  assert.strictEqual(store.get('config/app').flags.maintenance, true);
  assert.strictEqual(store.get('config/app').flags.adsFree, true);
});

test('adminBroadcast reaches the right audience', async () => {
  await seedPeople();
  const r = await call(fn.adminBroadcast, 'a', { audience: 'venues', title: 'Hi venues', body: 'Show files are live.' }, ADMIN);
  assert.strictEqual(r.sent, 1);
  assert.ok([...store.keys()].some((k) => k.startsWith('notifications/kara/items/')));
  await assert.rejects(call(fn.adminBroadcast, 'a', { audience: 'all', title: 'x', body: 'y' }, ADMIN), /audience/);
});

test('dailyMetrics builds the overview', async () => {
  await seedPeople();
  const now = Date.now();
  await db.doc('pitches/p1').set({ createdAt: now, status: 'booked', lineupConfirmed: true, played: false });
  await db.doc('pitches/p2').set({ createdAt: now, status: 'new' });
  await db.doc('bands/b1').set({ members: {}, plan: { tier: 'pro' } });
  await db.doc('metrics/adRevenue').set({ last30: 214 });
  await fn.dailyMetrics();
  const ov = await call(fn.adminOverview, 'a', {}, ADMIN);
  assert.strictEqual(ov.kpis.users, 2);
  assert.strictEqual(ov.kpis.pro, 1);
  assert.strictEqual(ov.kpis.ads30, 214);
  assert.deepStrictEqual(ov.funnel.slice(0, 3).map((f) => f[1]), [2, 1, 1]);
  assert.strictEqual(ov.dau.length, 1);
  assert.strictEqual(ov.revenue.length, 1);
});
