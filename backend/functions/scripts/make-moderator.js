'use strict';

// Give (or take away) moderator access.
//   node scripts/make-moderator.js someone@example.com          -> make moderator
//   node scripts/make-moderator.js someone@example.com --remove -> remove
// Needs Application Default Credentials for your Firebase project:
//   gcloud auth application-default login

const admin = require('firebase-admin');

async function main() {
  const email = process.argv[2];
  const remove = process.argv.includes('--remove');
  if (!email) { console.error('Usage: node scripts/make-moderator.js <email> [--remove]'); process.exit(1); }
  admin.initializeApp();
  const user = await admin.auth().getUserByEmail(email);
  const claims = Object.assign({}, user.customClaims || {});
  if (remove) delete claims.moderator; else claims.moderator = true;
  await admin.auth().setCustomUserClaims(user.uid, claims);
  console.log((remove ? 'Removed moderator from ' : 'Made moderator: ') + email + ' (' + user.uid + '). They need to sign out and back in.');
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
