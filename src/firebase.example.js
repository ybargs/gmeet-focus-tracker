import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth/web-extension";

// Firebase console → Project settings → General → Your apps → Web app → SDK setup and configuration
export const firebaseConfig = {
  apiKey: "your-api-key-here",
  authDomain: "your-project-id.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project-id.firebasestorage.app",
  messagingSenderId: "your-messaging-sender-id",
  appId: "your-app-id"
};

// Only needed for Brave, Edge and other non-Chrome browsers. Leave "" to use Chrome sign-in only.
// Google Cloud console → APIs & Services → Credentials → a "Web application" OAuth client ID
// whose authorized redirect URI is https://<extension-id>.chromiumapp.org/
export const GOOGLE_WEB_CLIENT_ID = "";

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
