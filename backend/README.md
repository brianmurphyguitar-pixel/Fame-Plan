# Fame Plan backend: moderation and admin console

This folder is the real, server-side version of the feed filter that the prototype only simulates,
plus the staff web app for running Fame Plan (control, insight and moderation).
It runs on **Firebase** (Google Cloud), so it lives in the same Google Cloud account you're opening
under the LLC.

## What it does

| Situation | What happens |
|---|---|
| Swearing, banter, "we killed it tonight" | Nothing. Posts normally. |
| "KYS", "go die", threats (any spelling: `k.y.s`, `g0 d1e`) | Blurred for the band, sent to the moderator queue, author gets a warning |
| Racial or other prejudice, hate slogans or codes, slurs | Same, and it's marked **high priority** |
| Sexual content involving minors | Removed immediately, author suspended, **urgent** queue item |
| Someone reports a post the filter missed | Goes to the queue. 3 different reporters → auto-blurred until reviewed |
| Bandmate answers "No offense taken" | Joking threat-type flag is cleared and the warning removed. **Prejudice is never cleared this way.** |
| A viewer keeps answering "good fun" (3+) | Joking threat-type posts stop being blurred *for that viewer*. Prejudice always stays blurred. |
| 3 warnings | Can't post or comment for 24 hours (enforced by the server and the database rules) |
| Paused 3 times in 90 days | Account goes to the queue for a membership decision |
| Moderator action | Dismiss, remove, remove + warn, suspend 7 days, end membership, restore. All logged. |
| User disagrees | Appeal from the app. Lands in the queue. |

### How text is checked

1. **Local rules** (`functions/moderation/rules.js`): instant and free. Threat phrases, prejudice
   patterns, hate codes, plus your own term list. Handles leetspeak, symbols, spaced letters and
   stretched letters.
2. **OpenAI moderation** (`omni-moderation-latest`): free to use, works in ~40 languages, catches
   slurs and coded hate the rules miss. Fame Plan only acts on its *hate*, *threatening*,
   *self-harm aimed at someone* and *minors* categories, so swearing and rough talk still pass.
3. If OpenAI is unreachable, the post goes up (fail open) and is re-checked every 15 minutes.

Why not Google's Perspective API: it shuts down on December 31, 2026.

## Files

```
backend/
  firebase.json              deploy config (functions, rules, console hosting)
  firestore.rules            who can read/write what; blocks posting while paused
  firestore.indexes.json
  functions/
    index.js                 triggers + callable functions (the server)
    moderation/
      normalize.js           text clean-up that defeats filter dodging
      rules.js               local rules
      hate-terms.txt         your own term list (ships empty, see below)
      classify.js            rules + OpenAI, mapped to Fame Plan categories
      policy.js              all decisions: warnings, pauses, good fun, reports, actions
    admin/admin.js           admin rules: who can do what, settings checks, announcements, metrics
    scripts/make-moderator.js
    test/                    37 tests, run with: npm test
  console/                   admin web app (hosted on Firebase Hosting)
```

## Setup (one time, about an hour)

You'll need: the Google Cloud account under the LLC, a card on it, and a computer with Node 22.

1. **Create the Firebase project.** Go to console.firebase.google.com, choose **Add project**,
   and pick the Google Cloud project you made for Fame Plan. Upgrade it to the **Blaze**
   (pay-as-you-go) plan. Cloud Functions need it. At Fame Plan's early size this should stay
   inside the free allowance. Set a budget alert like the $25/month one for Maps.
2. **Turn on** Firestore (production mode, region `us-east1`) and Authentication
   (Google, Apple, email link, matching the app's sign-in screen).
3. **Get an OpenAI API key.** Sign up at platform.openai.com under the LLC and create a key.
   The moderation endpoint is free, but the account needs to exist.
4. **Install the tools** on your computer:
   ```
   npm install -g firebase-tools
   firebase login
   cd backend/functions && npm install && npm test
   ```
5. **Store the key as a secret** (never put it in code):
   ```
   cd backend
   firebase use --add            # pick your project
   firebase functions:secrets:set OPENAI_API_KEY
   ```
6. **Deploy:**
   ```
   firebase deploy --only functions,firestore:rules,firestore:indexes,hosting
   ```
7. **Admin console:** in Firebase console → Project settings → **Add app → Web**, copy the
   config into `console/config.js`, and deploy hosting again. The console URL is
   `https://<project-id>.web.app`. Open it with `?demo=1` any time to see sample data.
8. **Make yourself an admin** (once; after that, make moderators from the console's People page):
   ```
   gcloud auth application-default login
   cd backend/functions && node scripts/make-moderator.js you@yourdomain.com --admin
   ```

## The admin console

Open `https://<project-id>.web.app` and sign in with Google. Add `?demo=1` for sample data, and
`?demo=1&role=moderator` to see what a moderator sees.

| Section | Who | What it's for |
|---|---|---|
| Overview | Admin | Users, daily actives, bands, venues, Pro and ad revenue, booking funnel, top cities, sign-ups. Built nightly by `dailyMetrics`. |
| Moderation | Moderator + admin | Flagged posts, reports, repeat offenders, appeals. Content is blurred until you choose to look. |
| People | Moderator + admin | Find anyone. Warn, clear warnings, suspend 7 days, restore. Admins also: end membership, give Pro free, make moderator. Moderators don't see email addresses. |
| Venues | Admin | Verify venue claims before bands see them as trusted. |
| Money | Admin | Payouts held for review (over $2,000, first payout, bank details just changed) and disputes. Money itself stays in Square/PayPal. |
| App control | Admin | Feature switches (sign-ups, ads, lineup tagging, show files, Spotify import, feed filter, maintenance mode), safety settings, minimum app version, announcements. |
| Audit log | Admin | Every staff action, who did it and the note they wrote. Can't be edited. |

Serious actions (suspend, end membership, give Pro, verify, payouts, disputes, settings, announcements)
require a note, which goes in the audit log.

**Safety settings** in App control are read by the moderation functions within a minute, so the
numbers there override `policy.js` → `CONFIG`. Keep them in line with the Terms of Service.

**Ad revenue** isn't in Firestore. Put the last-30-day AdMob figure in `metrics/adRevenue`
(`{ last30: 214 }`) by hand or from an AdMob export, and the nightly job picks it up.

**What the app needs to write** for the console to fill in: `users/{uid}` (name, email, kind,
roleLabel, org, city, bands, joined, lastActive), `pitches/{id}` (createdAt, status, lineupConfirmed,
played, venueCity), `venueClaims/{id}` (name, city, cap, by, byUid, email, evidence, submitted,
status: 'pending'), `payouts/{id}` (amount, paidAt). Payout holds go in `payoutReviews`, disputes
in `disputes`; the payments integration creates those.

## Maintaining the hate-term list

`functions/moderation/hate-terms.txt` is one term per line. It ships empty because OpenAI's
model already catches slurs. Use it for:

- coded or new terms your moderators keep seeing that slip through,
- local or scene-specific slurs,
- anything you always want flagged.

Only the base spelling is needed. Redeploy functions after editing. Keep the file in a private
repo, or load it from Cloud Storage, if you don't want the list public.

## What the app (iOS/Android) has to do

The prototype already shows the screens. When the real app is built, it:

- writes posts/comments to `bands/{bandId}/posts/...` with just `authorId` and `text`.
  The server adds `moderation`.
- blurs a post when `moderation.blurred` is true, using `viewerSeesBlur()` from `policy.js` with
  the viewer's `filterPrefs/{uid}`. Same logic, so app and server agree.
- shows "paused until…" from `standing/{uid}.pausedUntil`.
- calls `answerGoodFun`, `reportContent` and `submitAppeal` (Firebase callable functions).
- shows `notifications/{uid}/items` and the latest `announcements`.
- reads `config/app` at launch: feature switches, `minVersion` (ask to update) and maintenance mode.

## Legal and policy notes (not legal advice)

- **Child sexual abuse material:** US law (18 U.S.C. § 2258A) requires online services to report
  apparent CSAM to NCMEC's CyberTipline. The console flags these as urgent. Before launch, ask your
  lawyer to set up the reporting process. Don't download or forward the material.
- **Privacy policy:** say that posts and comments are checked by automated tools, including a
  third-party moderation service (OpenAI), and reviewed by people when flagged. Check OpenAI's
  current API data-retention terms when you sign up.
- **Terms of Service:** the in-app draft already reserves the right to remove content and end
  memberships. The thresholds in `policy.js` (`CONFIG`) match it. If you change one, change both.

## Tuning

- `policy.js` → `CONFIG`: warnings before a pause, pause length, pauses before account review,
  reports to auto-hide, "good fun" answers needed.
- `classify.js` → `THRESHOLDS`: how sure OpenAI must be before flagging. Raise a number to flag
  less, lower it to flag more.
- `rules.js`: threat phrases and prejudice patterns.

Run `npm test` after any change.
