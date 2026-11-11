'use strict';

// Pure decision logic: what happens to a piece of content and to its author.
// No Firebase here, so every rule is unit-tested. index.js applies the decisions.

const CONFIG = {
  warningsBeforePause: 3,
  pauseHours: 24,
  // After this many pauses inside the window, the account goes to a moderator
  // for a membership decision (Terms: "suspend or permanently end your membership").
  pausesBeforeReview: 3,
  pauseWindowDays: 90,
  // Reports from different people that auto-blur a post until a moderator looks.
  reportsToAutoHide: 3,
  // "No offense taken" answers from bandmates needed to clear a joking threat-type flag.
  goodFunToClear: 1
};

const LABELS = {
  threat: 'threats or telling someone to harm themselves',
  hate: 'racial or other prejudice',
  minors: 'sexual content involving minors'
};

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function emptyStanding() {
  return { warnings: 0, warningLog: [], pausedUntil: 0, pauses: [], status: 'active' };
}

function isPaused(standing, now) {
  return !!standing && standing.pausedUntil > now;
}

function canPost(standing, now) {
  if (!standing) return { ok: true };
  if (standing.status === 'terminated') return { ok: false, reason: 'terminated' };
  if (standing.status === 'suspended') return { ok: false, reason: 'suspended' };
  if (isPaused(standing, now)) return { ok: false, reason: 'paused', until: standing.pausedUntil };
  return { ok: true };
}

// Decide what to do with new content given the classifier result.
function decideContent(result) {
  const c = result && result.category;
  if (!c) return { status: 'clear', blurred: false, strike: false, queue: null };
  if (c === 'minors') {
    return { status: 'removed', blurred: true, strike: true, queue: { priority: 'urgent', reason: c }, suspendAuthor: true };
  }
  return { status: 'review', blurred: true, strike: true, queue: { priority: c === 'hate' ? 'high' : 'normal', reason: c } };
}

// Add a warning. Returns the new standing plus what happened.
function addStrike(standing, now, ref) {
  const s = Object.assign(emptyStanding(), standing || {});
  s.warningLog = (s.warningLog || []).concat([{ at: now, ref: ref || null }]).slice(-20);
  s.warnings = (s.warnings || 0) + 1;
  const out = { standing: s, paused: false, needsReview: false };
  if (s.warnings >= CONFIG.warningsBeforePause) {
    s.pausedUntil = now + CONFIG.pauseHours * HOUR;
    s.warnings = 0;
    s.pauses = (s.pauses || []).filter((t) => now - t < CONFIG.pauseWindowDays * DAY).concat([now]);
    out.paused = true;
    if (s.pauses.length >= CONFIG.pausesBeforeReview) {
      s.status = 'review';
      out.needsReview = true;
    }
  }
  return out;
}

// Take back one warning (bandmates said "no offense taken", or a moderator dismissed it).
// If that drops the user below a pause they're in, the pause is lifted.
function removeStrike(standing, ref, now) {
  const s = Object.assign(emptyStanding(), standing || {});
  const log = s.warningLog || [];
  const idx = ref ? log.findIndex((w) => w.ref === ref) : log.length - 1;
  if (idx < 0) return { standing: s, removed: false };
  s.warningLog = log.slice(0, idx).concat(log.slice(idx + 1));
  if (s.warnings > 0) s.warnings -= 1;
  else if (s.pausedUntil && s.pausedUntil > (now || Date.now())) { s.pausedUntil = 0; s.warnings = CONFIG.warningsBeforePause - 1; s.pauses = (s.pauses || []).slice(0, -1); }
  return { standing: s, removed: true };
}

// Bandmates answer "Was this in good fun?".
// fun/hurt are counts of distinct bandmates (author excluded).
function decideGoodFun(category, fun, hurt) {
  if (category === 'threat' && fun >= CONFIG.goodFunToClear && hurt === 0) {
    return { clear: true, removeStrike: true, priority: null };
  }
  if (hurt > 0) return { clear: false, removeStrike: false, priority: 'high' };
  // Prejudice and anything involving minors are never cleared by bandmates.
  return { clear: false, removeStrike: false, priority: null };
}

// A user's own learned preference: after enough "good fun" answers, joking
// threat-type posts stop being blurred for that user. Prejudice always stays blurred.
function viewerSeesBlur(category, prefs, filterOn) {
  if (!category) return false;
  if (category === 'minors') return true;
  if (filterOn === false) return category === 'hate' ? true : false;
  if (category === 'threat' && prefs && prefs.fun >= 3 && prefs.fun > (prefs.hurt || 0) * 2) return false;
  return true;
}

function decideReport(reportCount) {
  return { autoHide: reportCount >= CONFIG.reportsToAutoHide, priority: reportCount >= CONFIG.reportsToAutoHide ? 'high' : 'normal' };
}

// Moderator actions on a queue item.
const ACTIONS = ['dismiss', 'remove', 'remove_and_warn', 'suspend_7d', 'terminate', 'restore'];

function decideModeratorAction(action, now) {
  switch (action) {
    case 'dismiss': return { content: 'clear', strike: 'remove', account: null };
    case 'remove': return { content: 'removed', strike: 'keep', account: null };
    case 'remove_and_warn': return { content: 'removed', strike: 'keep', account: 'warn' };
    case 'suspend_7d': return { content: 'removed', strike: 'keep', account: { status: 'suspended', until: now + 7 * DAY } };
    case 'terminate': return { content: 'removed', strike: 'keep', account: { status: 'terminated' } };
    case 'restore': return { content: 'clear', strike: 'remove', account: { status: 'active' } };
    default: throw new Error('unknown action ' + action);
  }
}

module.exports = {
  CONFIG, LABELS, ACTIONS, emptyStanding, isPaused, canPost, decideContent, addStrike,
  removeStrike, decideGoodFun, viewerSeesBlur, decideReport, decideModeratorAction
};
