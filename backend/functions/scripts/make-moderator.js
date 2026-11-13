'use strict';

// Give (or take away) staff access.
//   node scripts/make-moderator.js someone@example.com                   -> moderator
//   node scripts/make-moderator.js someone@example.com --admin           -> admin (sees everything)
//   node scripts/make-moderator.js someone@example.com --remove          -> remove moderator
//   node scripts/make-moderator.js someone@example.com --admin --remove  -> remove admin
// Needs Application Default Credentials for your Firebase project:
//   gcloud auth application-default login
// Use this once to make yourself admin. After that, make moderators from the admin console.

const admin = require('firebase-admin');

async function main() {
  const email = process.argv[2];
  const remove = process.argv.includes('--remove');
  const key = process.argv.includes('--admin') ? 'admin' : 'moderator';
  if (!email || email.startsWith('--')) { console.error('Usage: node scripts/make-moderator.js <email> [--admin] [--remove]'); process.exit(1); }
  admin.initializeApp();
  const user = await admin.auth().getUserByEmail(email);
  const claims = Object.assign({}, user.customClaims || {});
  if (remove) delete claims[key]; else claims[key] = true;
  await admin.auth().setCustomUserClaims(user.uid, claims);
  await admin.firestore().doc('users/' + user.uid).set({ isModerator: !!(claims.moderator || claims.admin) }, { merge: true });
  console.log((remove ? 'Removed ' + key + ' from ' : 'Made ' + key + ': ') + email + ' (' + user.uid + '). They need to sign out and back in.');
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
