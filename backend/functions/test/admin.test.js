'use strict';
const test = require('node:test');
const assert = require('node:assert');
const A = require('../admin/admin');

test('roles', () => {
  assert.strictEqual(A.roleOf({ admin: true, moderator: true }), 'admin');
  assert.strictEqual(A.roleOf({ moderator: true }), 'moderator');
  assert.strictEqual(A.roleOf({}), null);
  assert.ok(A.allowed('admin', 'moderator'));
  assert.ok(!A.allowed('moderator', 'admin'));
});

test('checkAction rejects bad input', () => {
  assert.throws(() => A.checkAction(null, { kind: 'user', id: 'x', action: 'warn' }), /Staff only/);
  assert.throws(() => A.checkAction('admin', { kind: 'user', id: 'a/b', action: 'warn' }), /bad id/);
  assert.throws(() => A.checkAction('admin', { kind: 'user', id: 'x', action: 'delete_everything' }), /Unknown action/);
  assert.throws(() => A.checkAction('moderator', { kind: 'venue', id: 'x', action: 'verify', note: 'n' }), /Admins only/);
  assert.throws(() => A.checkAction('admin', { kind: 'payout', id: 'x', action: 'release' }), /note/);
  assert.deepStrictEqual(A.checkAction('moderator', { kind: 'user', id: 'x', action: 'warn' }), { kind: 'user', id: 'x', action: 'warn', note: '' });
});

test('validateConfig fills defaults and enforces limits', () => {
  const c = A.validateConfig({});
  assert.deepStrictEqual(c, A.DEFAULT_CONFIG);
  assert.throws(() => A.validateConfig({ moderation: { pauseHours: 0 } }), /pauseHours/);
  assert.throws(() => A.validateConfig({ moderation: { warningsBeforePause: 2.5 } }), /whole number/);
  assert.throws(() => A.validateConfig({ flags: { nukes: true } }), /Unknown switch/);
  assert.strictEqual(A.validateConfig({ flags: { adsFree: [false, 'Ads'] } }).flags.adsFree, false);
});

test('risky changes', () => {
  const next = A.validateConfig({ flags: { feedFilter: false, signupsOpen: false } });
  assert.deepStrictEqual(A.riskyChanges(A.DEFAULT_CONFIG, next), ['feed filter off', 'sign-ups closed']);
});

test('broadcast audiences', () => {
  assert.throws(() => A.validateBroadcast({ title: '', body: 'x' }), /Title/);
  assert.ok(A.inAudience({ kind: 'venue' }, 'venues'));
  assert.ok(!A.inAudience({ kind: 'venue' }, 'bands'));
  assert.ok(A.inAudience({ kind: 'musician', bands: ['b'] }, 'bands'));
  assert.ok(A.inAudience({ plan: 'pro' }, 'pro'));
});

test('payout review reasons', () => {
  const now = Date.now();
  assert.deepStrictEqual(A.payoutNeedsReview({ amount: 300 }, now), []);
  assert.strictEqual(A.payoutNeedsReview({ amount: 2400, firstPayout: true, bankChangedAt: now - 1e6 }, now).length, 3);
});

test('summary and median', () => {
  const s = A.summarize({ users: 110, usersMonthAgo: 100, pro: 58, proPrice: 9.99, ads30: 214 });
  assert.strictEqual(s.usersD, 10);
  assert.strictEqual(s.mrr, 579);
  assert.strictEqual(A.median([5, 1, 3]), 3);
  assert.strictEqual(A.median([]), 0);
});
