import { collection, addDoc } from "firebase/firestore";
import { signInWithCredential, GoogleAuthProvider } from "firebase/auth";
import { auth, db } from "./firebase";

let cachedUser = null;
let authInFlight = null;

async function ensureAuth() {
  if (auth.currentUser) {
    cachedUser = auth.currentUser;
    return cachedUser;
  }
  if (cachedUser) return cachedUser;
  if (authInFlight) return authInFlight;

  authInFlight = (async () => {
    try {
      const { token } = await chrome.identity.getAuthToken({ interactive: false });
      if (!token) return null;

      const credential = GoogleAuthProvider.credential(null, token);
      const userCredential = await signInWithCredential(auth, credential);
      cachedUser = userCredential.user;
      return cachedUser;
    } catch (e) {
      console.error("[Meet Focus Tracker] Background auth failed:", e);
      return null;
    } finally {
      authInFlight = null;
    }
  })();

  return authInFlight;
}

async function saveEvent(evt) {
  const { student } = await chrome.storage.local.get(["student"]);
  if (!student || !student.consent) return;

  const user = await ensureAuth();
  if (!user) {
    console.warn("[Meet Focus Tracker] Could not authenticate in background context; skipping event.");
    return;
  }

  try {
    await addDoc(collection(db, "events"), {
      ...evt,
      student: student.name,
      email: student.email,
      uid: user.uid,
      timestamp: evt.time
    });
    console.log("[Meet Focus Tracker]", student.email, evt.type, new Date(evt.time).toLocaleTimeString());

    await chrome.storage.local.set({ currentMode: evt.type });
  } catch (e) {
    console.error("Error adding document: ", e);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  (async () => {
    if (msg.meetingCode) {
      await chrome.storage.local.set({
        activeMeeting: msg.type === "LEFT" ? null : msg.meetingCode
      });
    }
    await saveEvent(msg);
  })();
});

chrome.idle.setDetectionInterval(15);
chrome.idle.onStateChanged.addListener(async (state) => {
  const { activeMeeting } = await chrome.storage.local.get("activeMeeting");
  if (!activeMeeting) return;
  saveEvent({ type: state.toUpperCase(), time: Date.now(), meetingCode: activeMeeting });
});