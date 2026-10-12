import { collection, doc, getDocs, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import { signInWithCredential, GoogleAuthProvider } from "firebase/auth";
import { auth, db } from "./firebase";

const OUTBOX_KEY = "pendingEvents";
let cachedUser = null;
let authInFlight = null;

async function ensureAuth() {
  if (auth.currentUser) return (cachedUser = auth.currentUser);
  if (cachedUser) return cachedUser;
  if (authInFlight) return authInFlight;
  authInFlight = (async () => {
    try {
      const { token } = await chrome.identity.getAuthToken({ interactive: false });
      if (!token) return null;
      const credential = GoogleAuthProvider.credential(null, token);
      const user = (await signInWithCredential(auth, credential)).user;
      return (cachedUser = user);
    } catch (error) {
      console.warn("[iSEENTA] Background sign-in unavailable:", error);
      return null;
    } finally { authInFlight = null; }
  })();
  return authInFlight;
}

async function findActiveSession(meetingCode) {
  if (!meetingCode) return null;
  try {
    const sessions = await getDocs(query(collection(db, "sessions"), where("status", "==", "active")));
    const match = sessions.docs.find(item => item.data().meetingCode === meetingCode);
    return match ? { id: match.id, meetingCode } : null;
  } catch (error) {
    console.warn("[iSEENTA] Could not verify active class session:", error);
    return undefined;
  }
}

async function queueEvent(event) {
  const { [OUTBOX_KEY]: queue = [] } = await chrome.storage.local.get(OUTBOX_KEY);
  if (!queue.some(item => item.eventId === event.eventId)) {
    await chrome.storage.local.set({ [OUTBOX_KEY]: [...queue, event] });
  }
  await flushQueue();
}

async function flushQueue() {
  const user = await ensureAuth();
  if (!user) return;
  const { [OUTBOX_KEY]: queue = [], student } = await chrome.storage.local.get([OUTBOX_KEY, "student"]);
  if (!student?.consent || !queue.length) return;
  const remaining = [];
  for (const event of queue) {
    try {
      await setDoc(doc(db, "events", event.eventId), {
        type: event.type,
        meetingCode: event.meetingCode,
        sessionId: event.sessionId,
        student: student.name || user.displayName || student.email,
        email: student.email || user.email,
        uid: user.uid,
        time: event.time,
        clientTime: event.time,
        receivedAt: serverTimestamp()
      });
      await chrome.storage.local.set({ currentMode: event.type });
    } catch (error) {
      console.warn("[iSEENTA] Event queued until connection/rules permit upload:", error);
      remaining.push(event);
    }
  }
  await chrome.storage.local.set({ [OUTBOX_KEY]: remaining });
}

async function sendTrackedEvent(message, sessionId) {
  const { student } = await chrome.storage.local.get("student");
  if (!student?.consent || !sessionId) return;
  await queueEvent({
    eventId: message.eventId || crypto.randomUUID(),
    type: message.type,
    meetingCode: message.meetingCode,
    sessionId,
    time: Number(message.time) || Date.now()
  });
}

async function handleMeetMessage(message) {
  const { activeMeeting, activeSessionId } = await chrome.storage.local.get(["activeMeeting", "activeSessionId"]);
  const session = await findActiveSession(message.meetingCode);
  if (session) {
    await chrome.storage.local.set({ activeMeeting: message.meetingCode, activeSessionId: session.id });
    await sendTrackedEvent(message, session.id);
  } else if (session === undefined && activeMeeting === message.meetingCode && activeSessionId) {
    // Network unavailable: retain the previously verified session ID in the local outbox.
    await sendTrackedEvent(message, activeSessionId);
  } else if (message.type === "JOINED") {
    // Remember the Meet code so the alarm can detect a teacher starting the class later.
    await chrome.storage.local.set({ activeMeeting: message.meetingCode, activeSessionId: null });
  } else if (session === null && activeMeeting === message.meetingCode) {
    await chrome.storage.local.set({ activeSessionId: null });
  }
  if (message.type === "LEFT" && activeMeeting === message.meetingCode) {
    await chrome.storage.local.set({ activeMeeting: null, activeSessionId: null });
  }
}

chrome.runtime.onMessage.addListener(message => {
  void handleMeetMessage(message);
});

chrome.idle.setDetectionInterval(120);
chrome.idle.onStateChanged.addListener(async state => {
  const { activeMeeting, activeSessionId, student } = await chrome.storage.local.get(["activeMeeting", "activeSessionId", "student"]);
  if (!activeMeeting || !student?.consent) return;
  const session = await findActiveSession(activeMeeting);
  if (session) {
    await chrome.storage.local.set({ activeSessionId: session.id });
    await sendTrackedEvent({ type: state === "active" ? "ACTIVE" : state.toUpperCase(), time: Date.now(), meetingCode: activeMeeting, eventId: crypto.randomUUID() }, session.id);
  } else if (session === undefined && activeSessionId) {
    await sendTrackedEvent({ type: state === "active" ? "ACTIVE" : state.toUpperCase(), time: Date.now(), meetingCode: activeMeeting, eventId: crypto.randomUUID() }, activeSessionId);
  } else if (session === null) {
    await chrome.storage.local.set({ activeSessionId: null });
  }
});

chrome.alarms.create("flush-pending-events", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== "flush-pending-events") return;
  const { activeMeeting, activeSessionId } = await chrome.storage.local.get(["activeMeeting", "activeSessionId"]);
  if (activeMeeting) {
    const session = await findActiveSession(activeMeeting);
    if (session && session.id !== activeSessionId) {
      await chrome.storage.local.set({ activeSessionId: session.id });
      await sendTrackedEvent({ type: "JOINED", time: Date.now(), meetingCode: activeMeeting, eventId: crypto.randomUUID() }, session.id);
    } else if (session === null && activeSessionId) {
      await chrome.storage.local.set({ activeSessionId: null });
    }
  }
  await flushQueue();
});
