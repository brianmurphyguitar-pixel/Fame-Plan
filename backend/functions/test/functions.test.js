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
function collRef(path) {
  return {
    doc: (id) => docRef(path + '/' + id),
    async add(data) { const id = 'auto' + (++autoId); await docRef(path + '/' + id).set(data); return { id }; }
  };
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
const fakeAdmin = {
  initializeApp() {},
  firestore: Object.assign(() => db, { FieldValue: { increment: (n) => ({ [INC]: n }), arrayUnion: (...a) => ({ [UNION]: a }) } }),
  auth: () => ({ updateUser: async (uid, p) => authCalls.push(['update', uid, p]), revokeRefreshTokens: async (uid) => authCalls.push(['revoke', uid]) })
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
