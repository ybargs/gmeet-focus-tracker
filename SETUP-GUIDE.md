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

**Brave / Edge sign-in.** These browsers don't support Chrome's built-in Google sign-in, so the extension falls back to a web sign-in. This needs a second OAuth client:
1. Go to Google Cloud console → APIs & Services → Credentials → **Create credentials → OAuth client ID**, and choose **Web application**.
2. Add this authorized redirect URI: `https://kkffkfcdgbgjklhejknjphjiaekopdhj.chromiumapp.org/`
3. Put the client ID in `GOOGLE_WEB_CLIENT_ID` in `src/firebase.js`, then rebuild.
4. In Firebase console → Authentication → Sign-in method → Google, add this client ID under "Safelist client IDs from external projects", if Firebase rejects the sign-in.

Chrome works without this.

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
