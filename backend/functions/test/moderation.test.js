'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalize } = require('../moderation/normalize');
const rules = require('../moderation/rules');
const { classify, mapScores } = require('../moderation/classify');
const policy = require('../moderation/policy');

test('normalize defeats common dodges', () => {
  assert.match(normalize('K.Y.S'), / kys /);
  assert.match(normalize('k y s'), / kys /);
  assert.match(normalize('g0 d1e'), / go die /);
  assert.match(normalize('f*ck'), / fuck /);
  assert.match(normalize('diiiiie'), / diie /);
  assert.match(normalize('1488'), / 1488 /);
});

test('swearing and band talk pass', () => {
  for (const t of [
    'Damn that was so fucking loud', 'fuck you lol, nice solo', 'piece of shit van broke again',
    'we killed it tonight', 'that riff kills', 'I could die happy', 'I love Black Sabbath',
    'Asian fusion after the show?', 'go back to your place after the show', 'muslims are welcome here',
    'the black van is outside', 'white people be like haha'
  ]) assert.strictEqual(rules.check(t), null, t);
});

test('threats and self-harm aimed at others are flagged', () => {
  for (const t of ['kys', 'K.Y.S', 'k y s', 'go die in a fire', 'You g0 d1e', 'just kill yourself', 'drink bleach lol']) {
    assert.strictEqual((rules.check(t) || {}).category, 'threat', t);
  }
});

test('prejudice is flagged', () => {
  for (const t of ['all mexicans are criminals', 'Those Asian people should leave', 'go back where you came from', 'go back to your country', 'heil hitler', '1488', 'white power', 'immigrants are vermin']) {
    assert.strictEqual((rules.check(t) || {}).category, 'hate', t);
  }
});

test('hate-term list is matched as whole words with dodges', () => {
  rules.setHateTerms(['zzbadterm']);
  assert.strictEqual(rules.check('you z.z.b.a.d.t.e.r.m').category, 'hate');
  assert.strictEqual(rules.check('zzbadtermination is fine'), null);
  rules.setHateTerms([]);
});

test('OpenAI scores map to Fame Plan categories', () => {
  assert.strictEqual(mapScores({ hate: 0.9 }, 'x').category, 'hate');
  assert.strictEqual(mapScores({ 'harassment/threatening': 0.8 }, 'x').category, 'threat');
  assert.strictEqual(mapScores({ 'sexual/minors': 0.5 }, 'x').category, 'minors');
  assert.strictEqual(mapScores({ harassment: 0.99, violence: 0.9, sexual: 0.9 }, 'x'), null, 'plain harassment, violence, adult talk ignored');
  assert.strictEqual(mapScores({ 'self-harm': 0.9 }, 'I feel like I could die'), null, 'own feelings are not a threat');
  assert.strictEqual(mapScores({ 'self-harm': 0.9 }, 'you should do it').category, 'threat');
});

test('classify uses rules first, then the API, and fails open', async () => {
  let calls = 0;
  const fakeFetch = async () => { calls++; return { ok: true, json: async () => ({ results: [{ category_scores: { hate: 0.97 } }] }) }; };
  assert.strictEqual((await classify('kys', { apiKey: 'k', fetchImpl: fakeFetch })).source, 'rules');
  assert.strictEqual(calls, 0);
  const r = await classify('some coded slur', { apiKey: 'k', fetchImpl: fakeFetch });
  assert.deepStrictEqual([r.category, r.source, calls], ['hate', 'openai', 1]);
  const down = async () => { throw new Error('offline'); };
  const f = await classify('hello', { apiKey: 'k', fetchImpl: down });
  assert.strictEqual(f.category, null);
  assert.ok(f.apiError);
  const swear = async () => ({ ok: true, json: async () => ({ results: [{ category_scores: { harassment: 0.95 } }] }) });
  assert.strictEqual((await classify('fuck you lol', { apiKey: 'k', fetchImpl: swear })).category, null);
});

test('three warnings pause posting for 24 hours', () => {
  const now = 1_000_000;
  let s = policy.emptyStanding();
  s = policy.addStrike(s, now, 'a').standing;
  s = policy.addStrike(s, now, 'b').standing;
  const third = policy.addStrike(s, now, 'c');
  assert.ok(third.paused);
  assert.strictEqual(third.standing.pausedUntil, now + 24 * 3600 * 1000);
  assert.strictEqual(policy.canPost(third.standing, now + 1000).reason, 'paused');
  assert.ok(policy.canPost(third.standing, now + 25 * 3600 * 1000).ok);
});

test('repeated pauses send the account to moderator review', () => {
  let now = 0, s = policy.emptyStanding(), last;
  for (let i = 0; i < 9; i++) { last = policy.addStrike(s, now, 'x' + i); s = last.standing; now += 3600 * 1000; }
  assert.ok(last.needsReview);
  assert.strictEqual(s.status, 'review');
});

test('removing a strike can lift an active pause', () => {
  const now = 5;
  let s = policy.emptyStanding();
  for (const r of ['a', 'b', 'c']) s = policy.addStrike(s, now, r).standing;
  const out = policy.removeStrike(s, 'c', now + 1);
  assert.ok(out.removed);
  assert.ok(policy.canPost(out.standing, now + 2).ok);
});

test('good fun clears joking threats but never prejudice', () => {
  assert.ok(policy.decideGoodFun('threat', 1, 0).clear);
  assert.ok(!policy.decideGoodFun('threat', 2, 1).clear);
  assert.ok(!policy.decideGoodFun('hate', 4, 0).clear);
  assert.ok(!policy.decideGoodFun('minors', 4, 0).clear);
});

test('learned viewer preference only relaxes threat-type blur', () => {
  const relaxed = { fun: 3, hurt: 0 };
  assert.strictEqual(policy.viewerSeesBlur('threat', relaxed, true), false);
  assert.strictEqual(policy.viewerSeesBlur('hate', relaxed, true), true);
  assert.strictEqual(policy.viewerSeesBlur('hate', relaxed, false), true);
  assert.strictEqual(policy.viewerSeesBlur('threat', { fun: 3, hurt: 2 }, true), true);
});

test('content decisions', () => {
  assert.strictEqual(policy.decideContent({ category: null }).status, 'clear');
  assert.strictEqual(policy.decideContent({ category: 'hate' }).queue.priority, 'high');
  const m = policy.decideContent({ category: 'minors' });
  assert.deepStrictEqual([m.status, m.queue.priority, m.suspendAuthor], ['removed', 'urgent', true]);
  assert.ok(policy.decideReport(3).autoHide);
  assert.throws(() => policy.decideModeratorAction('nuke', 0));
  assert.strictEqual(policy.decideModeratorAction('terminate', 0).account.status, 'terminated');
});
