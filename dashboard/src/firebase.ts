import { getApps, initializeApp } from "firebase/app";
import { getAuth as getBrowserAuth, GoogleAuthProvider as BrowserGoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { GoogleAuthProvider as ExtensionGoogleAuthProvider } from "firebase/auth/web-extension";
import { app as extensionApp, auth as extensionAuth, db as extensionDb, firebaseConfig } from "../../src/firebase.js";

const inExtension = Boolean((globalThis as typeof globalThis & { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id);

// The Vite dashboard runs on localhost and needs the browser popup resolver.
// Keep it on its own Firebase app so it doesn't reuse the extension's Auth instance.
const browserAppName = "dashboard-browser";
const browserApp = inExtension
  ? extensionApp
  : getApps().find(candidate => candidate.name === browserAppName)
    ?? initializeApp(firebaseConfig, browserAppName);

export const auth = inExtension ? extensionAuth : getBrowserAuth(browserApp);
export const db = inExtension ? extensionDb : getFirestore(browserApp);
export const googleProvider = inExtension
  ? new ExtensionGoogleAuthProvider()
  : new BrowserGoogleAuthProvider();
if (!inExtension) googleProvider.setCustomParameters({ prompt: "select_account" });
