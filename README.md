# iSEENTA Class Activity Tracker

A Chrome extension and teacher dashboard for recording student focus signals during an active Google Meet class session.

## Requirements

- Node.js and npm
- A Firebase project with Authentication and Cloud Firestore enabled
- Google sign-in enabled in Firebase Authentication
- The dashboard's Firebase project and authorized domains configured

## Configure Firebase

1. Copy `src/firebase.example.js` to `src/firebase.js`.
2. Fill in the Firebase web app configuration for your project in `src/firebase.js`.
3. Keep `src/firebase.js` local; it is ignored by Git.

The dashboard uses `dashboard/src/firebase.ts`. Set it to the same Firebase project before building the dashboard. The Firebase web API key identifies the project; configure Authentication and Firestore access in Firebase Console.

## Build and load the Chrome extension

From the repository root:

```sh
npm install
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the generated `dist` folder. Sign in to the extension using the student's Google account and enable class tracking.

The extension records only when the student's Meet code matches an active class session and tracking consent is enabled. Idle status is delayed by two minutes. A hidden Meet tab is reported as Away; using another window or monitor does not by itself mark the student Away. It also shares the number of open tabs in the student's Chrome profile while tracking is active. It does not read or send tab titles, URLs, or favicons, and it does not require the separate `tabs` permission.

## Run the teacher dashboard

```sh
cd dashboard
npm install
npm run dev
```

Open the local URL printed by Vite. Sign in with the teacher account, then use the session controls in the banner to start, pause, resume, or stop the class session. Before starting, paste and save a separate test Meet link in the banner. The dashboard stores its code on that browser and matches student events to the class session using that code. The extension detects the code from the student's Meet page automatically.

## Firestore rules

Firestore rules are not included in this preview because the team is reviewing them separately. The session collection and student event writes need compatible rules before using session tracking with live data. To enable browser tab counts, the rules must allow the `TABS_UPDATED` event type and the numeric `tabCount` event field. Do not treat Firebase client configuration as a substitute for Firestore security rules.


