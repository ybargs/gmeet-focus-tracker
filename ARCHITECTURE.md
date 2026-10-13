# PUP iSEENTA Architecture

## Overview

The project is a Chrome extension with a student popup and a professor dashboard. Firebase Authentication identifies users and Cloud Firestore stores class sessions and student activity. There is no custom application server.

## Main components

- `src/content.js` detects when a student is actually in Google Meet and reports room visibility, idle state, and tab-count changes.
- `src/background.js` owns extension authentication, role and consent state, session lookup, event validation, a retry queue, and Firestore writes.
- `src/popup.html`, `src/popup.css`, and `src/popup.js` implement the student status and professor entry popup. The popup follows the system/browser light or dark color scheme.
- `dashboard/src/App.tsx` and `dashboard/src/styles.css` implement the React professor dashboard. The roster is session-scoped; selecting a student opens their session activity details.
- `src/firebase.js` is a local-only Firebase configuration file. It is ignored by Git. Start from `src/firebase.example.js` and fill in the Firebase web app settings.
- `firestore.rules` is the security boundary for session and event access. Publish it in Firebase Console; adding the file to the repository does not publish it.

## Activity model

The `sessions` collection holds professor-created sessions with a Meet code, status, elapsed time, and owner UID. The `events` collection holds student signals tied to one session. Event documents include the authenticated student's UID and email, event time, tab count, and trusted server receipt time.

The extension submits events only for an active matching Meet session. Firestore rules check the signed-in identity, verified email, event fields, meeting code, and session status. Professor reads and session controls are limited to the allowlisted accounts and the session owner.

Presence heartbeats allow the dashboard to show **Not detected** after 75 seconds without a signal and stop estimating focus time past the last fresh signal. The per-student detail view reports estimated focused, away, idle, and in-meeting time, focus share, activity counts, tab switches, and up to 100 recent events for the selected session. These signals describe browser and device activity; they do not measure attention.

## Build and local dashboard

`npm run build` first builds the dashboard with Vite and then bundles the extension with webpack into `dist/`. Vite deduplicates Firebase imports because the extension's local Firebase configuration is outside the dashboard package directory; this keeps Firestore objects on one SDK instance.

Use `npm --prefix dashboard run dev` to work on the professor dashboard in a regular browser. That browser flow uses a separate Firebase app with popup authentication. The student-facing popup is part of the extension and is viewed by loading `dist/` as an unpacked extension.
