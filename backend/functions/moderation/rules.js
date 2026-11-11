'use strict';

// Fast local rules. They run first, on every post and comment, with no network call.
// Swearing is deliberately NOT on any list: Fame Plan allows it.

const fs = require('fs');
const path = require('path');
const { normalize, squash } = require('./normalize');

// Telling someone to harm themselves, and direct threats.
const THREAT_PHRASES = [
  'kill yourself', 'kys', 'go kill yourself', 'go die', 'die in a fire', 'hope you die',
  'i will kill you', 'ill kill you', 'gonna kill you', 'end yourself', 'neck yourself',
  'drink bleach', 'unalive yourself', 'hang yourself', 'shoot yourself'
];

const GROUPS = '(black|white|asian|mexican|jewish|jews|muslim|muslims|arab|indian|latino|latina|latinx|hispanic|chinese|japanese|korean|african|immigrant|immigrants|gay|gays|lesbian|lesbians|trans|native|middle eastern|people of color|christian|christians)';

// Hostile statements about a group, and hate slogans or codes.
const HATE_PATTERNS = [
  new RegExp(' (all|those|these|you|your|them|filthy|dirty|stupid|lazy) ' + GROUPS + 's? (people |folks )?(are|should|need to|dont belong|ruin|always) '),
  new RegExp(' ' + GROUPS + 's? (people )?(are|r) (animals|subhuman|vermin|trash|filth|apes|monkeys|criminals|inferior|disgusting|a disease|parasites) '),
  / go back (to|where) (your (own )?country|where you came from|you came from|africa|mexico|china|india) /,
  new RegExp(' (no|keep out|ban|deport) (the |all )?' + GROUPS + 's? (allowed|people|in|out) '),
  / (heil hitler|sieg heil|white power|white pride world wide|race war now|gas the|fourteen words|1488|14 88) /
];

// Maintained list of slurs and coded hate terms, one per line, lowercase.
// Kept in a separate file so it can be updated without code changes. See README.
function loadTermList(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith('#'));
  } catch (e) {
    return [];
  }
}

let HATE_TERMS = loadTermList(path.join(__dirname, 'hate-terms.txt'));

function setHateTerms(list) { HATE_TERMS = list.map((t) => normalize(t).trim()).filter(Boolean); }

function check(text) {
  const n = normalize(text);
  const sq = squash(n);
  for (const p of THREAT_PHRASES) {
    const w = ' ' + p + ' ';
    if (n.includes(w) || sq.includes(squash(w))) return { category: 'threat', match: p, source: 'rules' };
  }
  for (const re of HATE_PATTERNS) {
    if (re.test(n)) return { category: 'hate', match: re.source.slice(0, 40), source: 'rules' };
  }
  for (const t of HATE_TERMS) {
    const w = ' ' + t + ' ';
    if (n.includes(w) || sq.includes(squash(w))) return { category: 'hate', match: '[term list]', source: 'rules' };
  }
  return null;
}

module.exports = { check, setHateTerms, loadTermList, THREAT_PHRASES };
