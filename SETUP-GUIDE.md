# PUP iSEENTA: Setup Guide

## 1. Get the code and add the Firebase keys

```bash
cp src/firebase.example.js src/firebase.js
```

**Right after checking out, fill in `src/firebase.js`.** Without it, the build fails with `Can't resolve './firebase'`.
- Paste the `firebaseConfig` values from the Firebase console: Project settings → General → Your apps → Web app.
- Or ask a teammate for their `src/firebase.js`. Share it privately: the repo is public, and git ignores this file so it never gets committed.

Then build:

```bash
npm ci
npm --prefix dashboard install
npm run build
```

## 2. Load the extension

1. Open `chrome://extensions` (or `brave://extensions` / `edge://extensions`).
2. Turn on **Developer mode** and click **Load unpacked**.
3. Select the `dist` folder, not the project root or `src`.
4. Check that the extension ID is `kkffkfcdgbgjklhejknjphjiaekopdhj`. The `key` in `manifest.json` fixes this ID, and Google sign-in only works with it.

If you used v1 before, click ↻ reload on the extension card and sign in again from the popup. v1 sign-ins don't carry over.

## 3. Use it

**Student**
1. Open the popup and click **I am a Student**.
2. Tick **Enable activity and focus tracking**, then click **Sign in with Google**.
3. Join a Google Meet call. Tracking only starts once you're actually in the call, not in the lobby.

**Professor**
1. Open the popup and click **I am a Professor**, then sign in.
2. Only the emails in `src/config.js` are accepted. Any other account is signed out and sent back to role selection.
3. The dashboard opens in a new tab. If the active tab is a Meet room, its code is prefilled; otherwise enter the Meet code manually.
4. If no room code was prefilled, set the Google Meet link in the banner, then click **Start**. Students' events are accepted only while an active session exists for that Meet.
5. Use **Pause** to stop accepting new tracking events temporarily, **Start** to resume, and the stop control to finish the session. Session state and elapsed time are stored in Firestore.

The dashboard is now part of the extension. `npx serve dashboard` no longer works.

## 4. One-time project setup (owner only)

**Firestore rules.** Copy `firestore.rules` into Firebase console → Firestore Database → Rules, then click Publish. The extension and dashboard depend on both the `sessions` and `events` rules. Event writes require the submitted email to match the authenticated, verified account email and to reference the matching Meet session. The rules must include the `HEARTBEAT` event type for stale-presence detection. If a student's events are rejected, have them sign in again with their Google account. If you add a professor, update both:
- `PROFESSOR_EMAILS` in `src/config.js`
- the dashboard allowlist in `dashboard/src/App.tsx`
- the list in `firestore.rules`

**Student away notices and professor reminders.** Publish the updated `firestore.rules` to enable the `afkRequests` and `professorAlerts` collections. Students can send a preset away reason from the extension popup during an active session. Professors see requests live in the dashboard and can acknowledge them. The dashboard can send a fixed reminder to students currently marked Away; Chrome's notification permission must be allowed for the system alert to appear. The 30-day cleanup function also removes these notice documents after it has been deployed.

**Google account chooser in the dashboard / Brave / Edge sign-in.** The dashboard's explicit **Sign in** button uses a Google account chooser so it doesn't silently reuse Chrome's cached account. This web OAuth client is also used for Brave and Edge, which don't support Chrome's built-in Google sign-in:
1. Go to Google Cloud console → APIs & Services → Credentials → **Create credentials → OAuth client ID**, and choose **Web application**.
2. Add this authorized redirect URI: `https://kkffkfcdgbgjklhejknjphjiaekopdhj.chromiumapp.org/`
3. Put the client ID in `GOOGLE_WEB_CLIENT_ID` in `src/firebase.js`, then rebuild.
4. In Firebase console → Authentication → Sign-in method → Google, add this client ID under "Safelist client IDs from external projects", if Firebase rejects the sign-in.

The extension popup's normal Chrome sign-in works without this. To open the account chooser from the dashboard, configure this web client ID even in Chrome.

**30-day activity retention (project owner).** `functions/pruneExpiredActivity` runs daily at 2:30 AM Manila time. It deletes event records more than 30 days past their trusted Firestore `receivedAt` timestamp and deletes ended sessions more than 30 days past `endedAt`. Events attached to active or paused sessions are kept until those sessions end. Firestore client rules continue to deny deletes; only this Admin SDK scheduled function performs cleanup.

Deploy the cleanup function from the project root after signing into Firebase CLI and selecting the correct project:

```bash
npm --prefix functions install
firebase deploy --only functions:pruneExpiredActivity
```

Scheduled Cloud Functions require the Firebase project to use the Blaze plan and Cloud Scheduler to be enabled. The scheduled job must be deployed before automatic deletion occurs. Review current Cloud Functions and Cloud Scheduler pricing before deployment.

## 5. After pulling or changing code

1. Run `npm run build`.
2. Click ↻ reload on the extension card.
3. Refresh any open Meet tab. Content scripts don't reload on their own. Students must reload the extension and refresh Meet to send presence heartbeats.

## 6. Troubleshooting

| Problem | Fix |
|---|---|
| Popup shows "Not syncing: signed out" | Sign out in the popup and sign in again. |
| Popup shows "Not syncing: Firestore rejected the event" | Publish `firestore.rules` (section 4). |
| Brave/Edge: "Google sign-in isn't set up for this browser" | Set `GOOGLE_WEB_CLIENT_ID` (section 4). |
| Dashboard: "isn't recognized as a professor" | Sign out and use a whitelisted account. |
| Dashboard: "This account isn't authorized" | That professor's email is missing from the published Firestore rules. |
| No events at all | Go to `chrome://extensions` and click **service worker** on the card. Look for `[Meet Focus Tracker]` lines. |
