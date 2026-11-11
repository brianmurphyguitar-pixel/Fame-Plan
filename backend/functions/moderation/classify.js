'use strict';

// Two-layer check: local rules first (instant, free), then OpenAI's moderation model
// (free to use, catches slurs, coded hate and threats the rules miss, in ~40 languages).
// Only the categories Fame Plan cares about are acted on. Plain swearing, rough
// banter, "violence" in the music sense ("we killed it") and adult talk are ignored.

const rules = require('./rules');

const OPENAI_URL = 'https://api.openai.com/v1/moderations';
const MODEL = 'omni-moderation-latest';

// Score thresholds (0 to 1). Raise to flag less, lower to flag more.
const THRESHOLDS = {
  'sexual/minors': 0.2,          // -> 'minors' (removed immediately, urgent review)
  'hate/threatening': 0.35,      // -> 'hate'
  hate: 0.5,                     // -> 'hate'
  'harassment/threatening': 0.55, // -> 'threat'
  'self-harm/instructions': 0.5, // -> 'threat'
  'self-harm': 0.75              // -> 'threat', only when aimed at someone else (see below)
};

const AIMED_AT_SOMEONE = /\b(you|your|yourself|u|ur|urself|him|her|them|themselves)\b/i;

function mapScores(scores, text) {
  const s = scores || {};
  const over = (k) => (s[k] || 0) >= THRESHOLDS[k];
  if (over('sexual/minors')) return { category: 'minors', score: s['sexual/minors'] };
  if (over('hate/threatening')) return { category: 'hate', score: s['hate/threatening'] };
  if (over('hate')) return { category: 'hate', score: s.hate };
  if (over('harassment/threatening')) return { category: 'threat', score: s['harassment/threatening'] };
  if (over('self-harm/instructions')) return { category: 'threat', score: s['self-harm/instructions'] };
  if (over('self-harm') && AIMED_AT_SOMEONE.test(text)) return { category: 'threat', score: s['self-harm'] };
  return null;
}

async function callOpenAI(text, { apiKey, fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model: MODEL, input: text }),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('moderation api ' + res.status);
    const data = await res.json();
    const r = data && data.results && data.results[0];
    return r ? r.category_scores : null;
  } finally {
    clearTimeout(timer);
  }
}

// Returns { category: null | 'threat' | 'hate' | 'minors', source, score?, apiError? }
async function classify(text, opts = {}) {
  const t = String(text || '').trim();
  if (!t) return { category: null, source: 'empty' };

  const local = rules.check(t);
  // Local rules are certain enough to act on without waiting for the API.
  if (local) return local;

  if (!opts.apiKey) return { category: null, source: 'rules' };
  try {
    const scores = await callOpenAI(t, opts);
    const hit = mapScores(scores, t);
    return hit ? Object.assign({ source: 'openai' }, hit) : { category: null, source: 'openai' };
  } catch (e) {
    // Fail open (post goes up) but mark it so a scheduled job can re-check it.
    return { category: null, source: 'rules', apiError: String(e.message || e) };
  }
}

module.exports = { classify, mapScores, THRESHOLDS, MODEL };
