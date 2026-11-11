'use strict';

// Turns text into a padded, lowercase form that defeats common filter-dodging:
// leetspeak (g0 d1e), symbols (f*ck), spaced or dotted letters (k.y.s, k y s)
// and stretched letters (diiiie). Matching happens on ' word word ' boundaries.

const LEET = { '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '+': 't' };

function normalize(text) {
  let s = String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  // Keep pure number codes (e.g. hate codes like 1488) intact; only convert digits inside words.
  s = s.replace(/[0134@5$7!+](?![0-9])/g, (c, i, str) => (/[0-9]/.test(str[i - 1] || '') ? c : LEET[c]));
  s = s.replace(/\*/g, 'u');
  // Join single letters split by dots, dashes, underscores or spaces: "k.y.s" -> "kys".
  s = s.replace(/\b(\w)[.\-_ ](?=\w\b)/g, '$1');
  s = s.replace(/[^a-z0-9\s']/g, ' ').replace(/'/g, '');
  s = s.replace(/(\w)\1{2,}/g, '$1$1');
  return ' ' + s.replace(/\s+/g, ' ').trim() + ' ';
}

// Same text with every run of repeated letters squashed to one ("diie" -> "die").
function squash(normalized) {
  return normalized.replace(/(\w)\1+/g, '$1');
}

module.exports = { normalize, squash };
