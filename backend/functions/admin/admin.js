'use strict';

// Pure rules for the admin console. No Firebase here, so it's easy to test.
// index.js calls these and then writes the results to Firestore / Auth.

const ROLES = { moderator: 1, admin: 2 };

// Who may do what. Moderators handle day-to-day safety; admins own the business.
const USER_ACTIONS = {
  warn: 'moderator',
  clear_warnings: 'moderator',
  suspend_7d: 'moderator',
  restore: 'moderator',
  terminate: 'admin',
  grant_pro: 'admin',
  revoke_pro: 'admin',
  make_moderator: 'admin',
  remove_moderator: 'admin'
};
const VENUE_ACTIONS = ['verify', 'reject'];
const PAYOUT_ACTIONS = ['release', 'hold'];
const DISPUTE_ACTIONS = ['resolve_band', 'resolve_venue', 'split'];
const NOTE_REQUIRED = new Set(['suspend_7d', 'terminate', 'grant_pro', 'make_moderator', 'verify', 'reject', 'release', 'hold', 'resolve_band', 'resolve_venue', 'split']);

function roleOf(token) {
  if (!token) return null;
  if (token.admin === true) return 'admin';
  if (token.moderator === true) return 'moderator';
  return null;
}
function allowed(role, min) { return !!role && ROLES[role] >= ROLES[min]; }

function cleanNote(note) { return String(note == null ? '' : note).trim().slice(0, 1000); }

// Check an adminAction request. Returns { kind, id, action, note } or throws Error with .code.
function checkAction(role, data) {
  const err = (code, msg) => Object.assign(new Error(msg), { code });
  if (!role) throw err('permission-denied', 'Staff only.');
  const { kind, id, action } = data || {};
  const note = cleanNote(data && data.note);
  if (typeof id !== 'string' || !id || id.includes('/')) throw err('invalid-argument', 'Missing or bad id.');
  let min;
  if (kind === 'user') { min = USER_ACTIONS[action]; if (!min) throw err('invalid-argument', 'Unknown action.'); }
  else if (kind === 'venue') { if (!VENUE_ACTIONS.includes(action)) throw err('invalid-argument', 'Unknown action.'); min = 'admin'; }
  else if (kind === 'payout') { if (!PAYOUT_ACTIONS.includes(action)) throw err('invalid-argument', 'Unknown action.'); min = 'admin'; }
  else if (kind === 'dispute') { if (!DISPUTE_ACTIONS.includes(action)) throw err('invalid-argument', 'Unknown action.'); min = 'admin'; }
  else throw err('invalid-argument', 'Unknown kind.');
  if (!allowed(role, min)) throw err('permission-denied', 'Admins only.');
  if (NOTE_REQUIRED.has(action) && !note) throw err('invalid-argument', 'Add a note for the audit log.');
  return { kind, id, action, note };
}

// What a user action changes. standing: patch for standing/{uid}; claims: patch for custom claims;
// plan: new band plan; disabled: Auth disabled flag; message: what the person is told (null = nothing).
function decideUserAction(action, now) {
  const WEEK = 7 * 24 * 3600e3;
  switch (action) {
    case 'warn': return { warn: true, message: 'A moderator added a warning to your account for breaking the community guidelines.' };
    case 'clear_warnings': return { standing: { warnings: 0, warningLog: [], pauses: [], pausedUntil: 0, status: 'active' }, message: null };
    case 'suspend_7d': return { standing: { status: 'suspended', suspendedUntil: now + WEEK }, revoke: true, message: 'Your account is suspended for 7 days for breaking the community guidelines. You can appeal.' };
    case 'terminate': return { standing: { status: 'terminated', suspendedUntil: null }, disabled: true, revoke: true, message: 'Your Fame Plan membership was ended for breaking the Terms of Service. You can appeal within 30 days.' };
    case 'restore': return { standing: { status: 'active', suspendedUntil: null, pausedUntil: 0 }, disabled: false, message: 'Your account has been restored.' };
    case 'grant_pro': return { plan: { tier: 'pro', comp: true, since: now }, message: 'Your band now has Fame Plan Pro, on us.' };
    case 'revoke_pro': return { plan: { tier: 'free', comp: false, since: now }, message: null };
    case 'make_moderator': return { claims: { moderator: true }, message: null };
    case 'remove_moderator': return { claims: { moderator: false }, message: null };
    default: throw new Error('Unknown action');
  }
}

function decideMoney(kind, action) {
  if (kind === 'payout') return action === 'release' ? { status: 'paid', release: true } : { status: 'held', release: false };
  return { status: 'resolved', outcome: action };
}

// ---- App config

const FLAG_KEYS = ['signupsOpen', 'adsFree', 'lineupTagging', 'showFiles', 'spotifyImport', 'feedFilter', 'maintenance'];
const MOD_LIMITS = {
  warningsBeforePause: [1, 10, true],
  pauseHours: [1, 168, true],
  pausesBeforeReview: [1, 10, true],
  reportsToAutoHide: [1, 20, true],
  hateThreshold: [0.1, 0.95, false],
  threatThreshold: [0.1, 0.95, false]
};
const DEFAULT_CONFIG = {
  flags: { signupsOpen: true, adsFree: true, lineupTagging: true, showFiles: true, spotifyImport: true, feedFilter: true, maintenance: false },
  moderation: { warningsBeforePause: 3, pauseHours: 24, pausesBeforeReview: 3, reportsToAutoHide: 3, hateThreshold: 0.5, threatThreshold: 0.55 },
  minVersion: '1.0.0'
};

// The console sends flags as [on, label, help] (labels live with the UI); the server stores booleans.
function validateConfig(input) {
  const errors = [];
  const out = { flags: {}, moderation: {}, minVersion: DEFAULT_CONFIG.minVersion };
  const flags = (input && input.flags) || {};
  for (const k of FLAG_KEYS) {
    const v = Array.isArray(flags[k]) ? flags[k][0] : flags[k];
    out.flags[k] = typeof v === 'boolean' ? v : DEFAULT_CONFIG.flags[k];
  }
  for (const k of Object.keys(flags)) if (!FLAG_KEYS.includes(k)) errors.push('Unknown switch: ' + k);
  const m = (input && input.moderation) || {};
  for (const [k, [lo, hi, int]] of Object.entries(MOD_LIMITS)) {
    const v = m[k] === undefined ? DEFAULT_CONFIG.moderation[k] : Number(m[k]);
    if (!Number.isFinite(v) || v < lo || v > hi || (int && !Number.isInteger(v))) errors.push(k + ' must be ' + (int ? 'a whole number ' : '') + 'from ' + lo + ' to ' + hi);
    else out.moderation[k] = v;
  }
  const ver = input && input.minVersion !== undefined ? String(input.minVersion).trim() : DEFAULT_CONFIG.minVersion;
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ver)) errors.push('minVersion must look like 1.2.0');
  else out.minVersion = ver;
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { code: 'invalid-argument' });
  return out;
}

// Switches every user will notice. The console asks for an extra confirm; the log marks them.
function riskyChanges(before, after) {
  const b = (before && before.flags) || DEFAULT_CONFIG.flags, a = after.flags, out = [];
  if (a.maintenance !== b.maintenance) out.push(a.maintenance ? 'maintenance on' : 'maintenance off');
  if (!a.feedFilter && b.feedFilter !== false) out.push('feed filter off');
  if (!a.signupsOpen && b.signupsOpen !== false) out.push('sign-ups closed');
  return out;
}

// ---- Announcements
const AUDIENCES = ['everyone', 'bands', 'venues', 'pro'];
function validateBroadcast(msg) {
  const err = (m) => Object.assign(new Error(m), { code: 'invalid-argument' });
  const title = String((msg && msg.title) || '').trim(), body = String((msg && msg.body) || '').trim();
  const audience = (msg && msg.audience) || 'everyone';
  if (!AUDIENCES.includes(audience)) throw err('Unknown audience.');
  if (!title || title.length > 60) throw err('Title is required, 60 characters max.');
  if (!body || body.length > 280) throw err('Message is required, 280 characters max.');
  return { audience, title, body };
}
// Does a user profile belong to an audience?
function inAudience(profile, audience) {
  if (audience === 'everyone') return true;
  if (audience === 'venues') return profile.kind === 'venue';
  if (audience === 'bands') return profile.kind !== 'venue' && Array.isArray(profile.bands) && profile.bands.length > 0;
  if (audience === 'pro') return profile.plan === 'pro';
  return false;
}

// ---- Payout review: which payouts a person should look at before money moves.
function payoutNeedsReview(p, now) {
  const reasons = [];
  if (p.amount > 2000) reasons.push('Over $2,000');
  if (p.firstPayout) reasons.push('first payout for this band');
  if (p.bankChangedAt && now - p.bankChangedAt < 7 * 24 * 3600e3) reasons.push('bank details changed in the last 7 days');
  return reasons;
}

// ---- Metrics: turn raw counts into the overview numbers.
function summarize(c) {
  const pct = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : 0);
  return {
    users: c.users, usersD: pct(c.users, c.usersMonthAgo), dau: c.dau, mau: c.mau,
    bands: c.bands, venues: c.venues, venuesPending: c.venuesPending,
    pro: c.pro, mrr: Math.round(c.pro * c.proPrice), ads30: c.ads30,
    pitches30: c.pitches30, bookings30: c.bookings30, payouts30: c.payouts30,
    openMod: c.openMod, modHours: c.modHours
  };
}
function median(nums) {
  if (!nums.length) return 0;
  const s = nums.slice().sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

module.exports = {
  USER_ACTIONS, VENUE_ACTIONS, PAYOUT_ACTIONS, DISPUTE_ACTIONS, DEFAULT_CONFIG, FLAG_KEYS, AUDIENCES,
  roleOf, allowed, checkAction, decideUserAction, decideMoney, validateConfig, riskyChanges,
  validateBroadcast, inAudience, payoutNeedsReview, summarize, median
};
