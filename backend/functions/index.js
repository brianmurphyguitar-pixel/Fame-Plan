'use strict';

// Fame Plan moderation backend (Firebase Cloud Functions, 2nd gen).
//
// Data model (Firestore):
//   bands/{bandId}                                 members: { uid: 'admin' | 'member' | 'fillin' | 'guest' }
//   bands/{bandId}/posts/{postId}                  authorId, text, createdAt, moderation{}, goodFun{uid: 'fun'|'hurt'}
//   bands/{bandId}/posts/{postId}/comments/{id}    same fields as posts
//   standing/{uid}                                 warnings, warningLog, pausedUntil, pauses, status   (server-only)
//   filterPrefs/{uid}                              fun, hurt, filterOn                                  (server-only)
//   hidden/{uid}                                   paths: []  posts this user reported and hid          (server-only)
//   modQueue/{itemId}                              one item per flagged/reported piece of content or account
//   reports/{reportId}, appeals/{appealId}, modLog/{entryId}
//
// Users never write moderation fields. Security rules (firestore.rules) enforce that,
// and block posting while paused, suspended or terminated.

const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { classify } = require('./moderation/classify');
const policy = require('./moderation/policy');

admin.initializeApp();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');

const REGION = 'us-east1';
const POST = 'bands/{bandId}/posts/{postId}';
const COMMENT = 'bands/{bandId}/posts/{postId}/comments/{commentId}';

const queueId = (path) => path.replace(/\//g, '__');

// ---------------------------------------------------------------- content checks

async function moderateDoc(snap, bandId, kind) {
  if (!snap || !snap.exists) return;
  const data = snap.data();
  const path = snap.ref.path;
  const authorId = data.authorId;
  const now = Date.now();

  // Belt and braces: rules already block paused users, but never trust the client.
  const standingSnap = await db.doc('standing/' + authorId).get();
  const gate = policy.canPost(standingSnap.exists ? standingSnap.data() : null, now);
  if (!gate.ok) { await snap.ref.delete(); return; }

  const result = await classify(data.text, { apiKey: OPENAI_API_KEY.value() });
  const decision = policy.decideContent(result);

  await snap.ref.update({
    moderation: {
      status: decision.status,
      category: result.category || null,
      label: result.category ? policy.LABELS[result.category] : null,
      blurred: decision.blurred,
      source: result.source,
      recheck: !!result.apiError,
      checkedAt: now
    }
  });

  if (!decision.strike) return;

  // Warning + possible 24h pause, in a transaction so two posts can't race.
  const strike = await db.runTransaction(async (tx) => {
    const ref = db.doc('standing/' + authorId);
    const cur = await tx.get(ref);
    const out = policy.addStrike(cur.exists ? cur.data() : null, now, path);
    if (decision.suspendAuthor) out.standing.status = 'suspended';
    tx.set(ref, out.standing);
    return out;
  });

  await db.doc('modQueue/' + queueId(path)).set({
    type: kind, path, bandId, authorId,
    text: String(data.text || '').slice(0, 2000),
    category: result.category, label: policy.LABELS[result.category],
    source: result.source, score: result.score || null,
    priority: decision.queue.priority, status: 'open',
    reports: 0, reasons: [], fun: 0, hurt: 0,
    createdAt: now, updatedAt: now
  }, { merge: true });

  await notify(authorId, strike.paused
    ? { kind: 'paused', text: 'Your feed posting is paused for 24 hours after 3 warnings.', until: strike.standing.pausedUntil }
    : { kind: 'warning', text: 'Your ' + kind + ' was flagged for ' + policy.LABELS[result.category] + '. Warning ' + strike.standing.warnings + ' of 3.' });

  if (strike.needsReview) {
    await db.doc('modQueue/account__' + authorId).set({
      type: 'account', authorId, priority: 'high', status: 'open',
      category: 'repeat', label: 'Paused ' + policy.CONFIG.pausesBeforeReview + ' times in ' + policy.CONFIG.pauseWindowDays + ' days. Decide on membership.',
      createdAt: now, updatedAt: now
    }, { merge: true });
  }
}

async function notify(uid, item) {
  await db.collection('notifications').doc(uid).collection('items').add(Object.assign({ at: Date.now(), read: false }, item));
}

const runOpts = { region: REGION, secrets: [OPENAI_API_KEY] };

exports.moderatePost = onDocumentCreated(Object.assign({ document: POST }, runOpts),
  (e) => moderateDoc(e.data, e.params.bandId, 'post'));

exports.moderateComment = onDocumentCreated(Object.assign({ document: COMMENT }, runOpts),
  (e) => moderateDoc(e.data, e.params.bandId, 'comment'));

// Edited comments/posts are re-checked when the text changes.
async function onEdit(e, kind) {
  const before = e.data.before.data(), after = e.data.after.data();
  if (!after || before.text === after.text) return;
  await moderateDoc(e.data.after, e.params.bandId, kind);
}
exports.recheckEditedPost = onDocumentUpdated(Object.assign({ document: POST }, runOpts), (e) => onEdit(e, 'post'));
exports.recheckEditedComment = onDocumentUpdated(Object.assign({ document: COMMENT }, runOpts), (e) => onEdit(e, 'comment'));

// If the moderation API was down, re-check those items every 15 minutes.
exports.recheckFailed = onSchedule(Object.assign({ schedule: 'every 15 minutes' }, runOpts), async () => {
  const snaps = await db.collectionGroup('posts').where('moderation.recheck', '==', true).limit(100).get();
  const csnaps = await db.collectionGroup('comments').where('moderation.recheck', '==', true).limit(100).get();
  for (const d of snaps.docs.concat(csnaps.docs)) {
    const bandId = d.ref.path.split('/')[1];
    await moderateDoc(d, bandId, d.ref.parent.id === 'comments' ? 'comment' : 'post');
  }
});

// ---------------------------------------------------------------- user actions

async function requireMember(uid, path) {
  const bandId = path.split('/')[1];
  const band = await db.doc('bands/' + bandId).get();
  if (!band.exists || !band.data().members || !band.data().members[uid]) {
    throw new HttpsError('permission-denied', 'Not a member of this band.');
  }
  return bandId;
}

function checkPath(path) {
  if (typeof path !== 'string' || !/^bands\/[^/]+\/posts\/[^/]+(\/comments\/[^/]+)?$/.test(path)) {
    throw new HttpsError('invalid-argument', 'Bad content path.');
  }
}

// "Was this in good fun?"  answer: 'fun' | 'hurt'
exports.answerGoodFun = onCall({ region: REGION }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const { path, answer } = req.data || {};
  checkPath(path);
  if (!['fun', 'hurt'].includes(answer)) throw new HttpsError('invalid-argument', 'answer must be fun or hurt');
  await requireMember(uid, path);

  const result = await db.runTransaction(async (tx) => {
    const ref = db.doc(path);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Gone.');
    const d = snap.data();
    if (d.authorId === uid) throw new HttpsError('failed-precondition', 'You can’t vote on your own post.');
    const m = d.moderation || {};
    if (!m.category) return { changed: false };
    const votes = Object.assign({}, d.goodFun || {}, { [uid]: answer });
    const fun = Object.values(votes).filter((v) => v === 'fun').length;
    const hurt = Object.values(votes).filter((v) => v === 'hurt').length;
    const dec = policy.decideGoodFun(m.category, fun, hurt);
    const upd = { goodFun: votes };
    if (dec.clear) upd.moderation = Object.assign({}, m, { status: 'cleared_by_band', blurred: false });
    tx.update(ref, upd);
    tx.set(db.doc('modQueue/' + queueId(path)), Object.assign({ fun, hurt, updatedAt: Date.now() },
      dec.clear ? { status: 'resolved', resolution: 'cleared_by_band' } : {},
      dec.priority ? { priority: dec.priority } : {}), { merge: true });
    return { changed: true, dec, authorId: d.authorId };
  });

  // Learn this viewer's tolerance.
  await db.doc('filterPrefs/' + uid).set({ [answer]: FieldValue.increment(1) }, { merge: true });

  if (result.changed && result.dec.removeStrike) {
    await db.runTransaction(async (tx) => {
      const ref = db.doc('standing/' + result.authorId);
      const cur = await tx.get(ref);
      if (!cur.exists) return;
      tx.set(ref, policy.removeStrike(cur.data(), path, Date.now()).standing);
    });
    await notify(result.authorId, { kind: 'cleared', text: 'Your bandmates said no offense taken. That warning was removed.' });
  }
  return { ok: true, cleared: !!(result.dec && result.dec.clear) };
});

const REPORT_REASONS = ['prejudice', 'threat', 'harassment', 'sexual', 'scam', 'other'];

exports.reportContent = onCall({ region: REGION }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const { path, reason, hide, note } = req.data || {};
  checkPath(path);
  if (!REPORT_REASONS.includes(reason)) throw new HttpsError('invalid-argument', 'Unknown reason.');
  const bandId = await requireMember(uid, path);
  const now = Date.now();

  const reportRef = db.doc('reports/' + queueId(path) + '__' + uid); // one report per person per item
  const qRef = db.doc('modQueue/' + queueId(path));
  await db.runTransaction(async (tx) => {
    const [rep, content, q] = await Promise.all([tx.get(reportRef), tx.get(db.doc(path)), tx.get(qRef)]);
    if (!content.exists) throw new HttpsError('not-found', 'Gone.');
    if (rep.exists) return;
    const c = content.data();
    if (c.authorId === uid) throw new HttpsError('failed-precondition', 'You can’t report yourself.');
    const count = (q.exists ? q.data().reports || 0 : 0) + 1;
    const dec = policy.decideReport(count);
    tx.set(reportRef, { path, bandId, reporterId: uid, reason, note: String(note || '').slice(0, 500), at: now });
    tx.set(qRef, {
      type: path.includes('/comments/') ? 'comment' : 'post', path, bandId, authorId: c.authorId,
      text: String(c.text || '').slice(0, 2000),
      reports: count, reasons: FieldValue.arrayUnion(reason),
      priority: q.exists && q.data().priority === 'urgent' ? 'urgent' : dec.priority,
      status: 'open', updatedAt: now, createdAt: q.exists ? q.data().createdAt : now
    }, { merge: true });
    if (dec.autoHide) {
      tx.update(db.doc(path), { 'moderation.blurred': true, 'moderation.status': 'review', 'moderation.label': 'reported by several people' });
    }
  });
  if (hide) await db.doc('hidden/' + uid).set({ paths: FieldValue.arrayUnion(path) }, { merge: true });
  await db.doc('filterPrefs/' + uid).set({ hurt: FieldValue.increment(1) }, { merge: true });
  return { ok: true };
});

exports.submitAppeal = onCall({ region: REGION }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const msg = String((req.data && req.data.message) || '').trim();
  if (msg.length < 10) throw new HttpsError('invalid-argument', 'Tell us a bit more (10+ characters).');
  const ref = await db.collection('appeals').add({
    uid, ref: (req.data && req.data.ref) || null, message: msg.slice(0, 3000), status: 'open', at: Date.now()
  });
  await db.doc('modQueue/appeal__' + ref.id).set({
    type: 'appeal', authorId: uid, appealId: ref.id, text: msg.slice(0, 2000), priority: 'normal',
    status: 'open', category: 'appeal', label: 'Appeal', createdAt: Date.now(), updatedAt: Date.now()
  });
  return { ok: true, id: ref.id };
});

// ---------------------------------------------------------------- moderators

function requireModerator(req) {
  if (!req.auth || req.auth.token.moderator !== true) throw new HttpsError('permission-denied', 'Moderators only.');
  return req.auth.uid;
}

exports.moderatorAction = onCall({ region: REGION }, async (req) => {
  const modUid = requireModerator(req);
  const { itemId, action, note } = req.data || {};
  if (!policy.ACTIONS.includes(action)) throw new HttpsError('invalid-argument', 'Unknown action.');
  const qRef = db.doc('modQueue/' + itemId);
  const q = await qRef.get();
  if (!q.exists) throw new HttpsError('not-found', 'No such queue item.');
  const item = q.data();
  const now = Date.now();
  const dec = policy.decideModeratorAction(action, now);

  if (item.path) {
    const ref = db.doc(item.path);
    const snap = await ref.get();
    if (snap.exists) {
      if (dec.content === 'removed') await ref.update({ 'moderation.status': 'removed', 'moderation.blurred': true });
      if (dec.content === 'clear') await ref.update({ 'moderation.status': 'clear', 'moderation.blurred': false });
    }
  }

  if (item.authorId) {
    await db.runTransaction(async (tx) => {
      const sRef = db.doc('standing/' + item.authorId);
      const cur = await tx.get(sRef);
      let s = cur.exists ? cur.data() : policy.emptyStanding();
      if (dec.strike === 'remove' && item.path) s = policy.removeStrike(s, item.path, now).standing;
      if (dec.account === 'warn') s = policy.addStrike(s, now, 'moderator:' + itemId).standing;
      else if (dec.account && dec.account.status) {
        s = Object.assign({}, s, { status: dec.account.status, suspendedUntil: dec.account.until || null });
      }
      tx.set(sRef, s);
    });
    if (dec.account && dec.account.status === 'terminated') {
      await admin.auth().updateUser(item.authorId, { disabled: true });
      await admin.auth().revokeRefreshTokens(item.authorId);
    }
    if (dec.account && dec.account.status === 'active' && item.type === 'appeal') {
      await admin.auth().updateUser(item.authorId, { disabled: false });
    }
    const msg = {
      dismiss: 'A moderator reviewed your post and cleared it.',
      restore: 'A moderator restored your account and content.',
      remove: 'A moderator removed your post for breaking the community guidelines.',
      remove_and_warn: 'A moderator removed your post and added a warning.',
      suspend_7d: 'Your account is suspended for 7 days for breaking the community guidelines. You can appeal.',
      terminate: 'Your Fame Plan membership was ended for breaking the Terms of Service. You can appeal within 30 days.'
    }[action];
    await notify(item.authorId, { kind: 'moderation', text: msg });
  }

  await qRef.update({ status: 'resolved', resolution: action, resolvedBy: modUid, note: String(note || '').slice(0, 1000), updatedAt: now });
  if (item.type === 'appeal' && item.appealId) await db.doc('appeals/' + item.appealId).update({ status: 'resolved', resolution: action });
  await db.collection('modLog').add({ itemId, action, by: modUid, note: note || '', at: now, authorId: item.authorId || null, path: item.path || null });
  return { ok: true };
});

// Lift expired suspensions daily.
exports.liftSuspensions = onSchedule({ region: REGION, schedule: 'every day 04:00', timeZone: 'America/New_York' }, async () => {
  const now = Date.now();
  const snaps = await db.collection('standing').where('status', '==', 'suspended').where('suspendedUntil', '<=', now).get();
  for (const d of snaps.docs) await d.ref.update({ status: 'active', suspendedUntil: null });
});
