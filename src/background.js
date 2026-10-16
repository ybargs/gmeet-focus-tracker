import { collection, doc, getDocs, onSnapshot, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import { auth, db } from "./firebase";
import { signInWithGoogle, signOutGoogle } from "./auth";
import { isProfessorEmail, meetCodeFromUrl, MEET_CODE_RE } from "./config";

let authInFlight = null;

let professorAlertUnsubscribe = null;
let professorAlertWatchKey = "";
let professorAlertQueue = Promise.resolve();
let studentSessionUnsubscribe = null;
let studentSessionWatchKey = "";
function processProfessorAlerts(alerts, activeSessionId) {
  professorAlertQueue = professorAlertQueue.then(async () => {
    const { seenProfessorAlertIds = [] } = await chrome.storage.local.get("seenProfessorAlertIds");
    const seen = new Set(seenProfessorAlertIds);
    const now = Date.now();
    for (const { id, data } of alerts) {
      if (seen.has(id) || data.sessionId !== activeSessionId) continue;
      const createdAt = typeof data.createdAt?.toMillis === "function" ? data.createdAt.toMillis() : 0;
      if (!createdAt || now - createdAt > 30 * 60 * 1000) continue;
      seen.add(id);
      const record = {
        id,
        sessionId: data.sessionId,
        message: String(data.message || "Your professor sent a class reminder."),
        receivedAt: Date.now()
      };
      await chrome.storage.local.set({ latestProfessorAlert: record, seenProfessorAlertIds: [...seen].slice(-500) });
      try {
        await chrome.notifications.create(`iseenta-${id}`, {
          type: "basic",
          iconUrl: "icon-128.png",
          title: "Class reminder from your professor",
          message: record.message,
          priority: 1
        });
      } catch (error) {
        console.warn("[Meet Focus Tracker] Could not show professor reminder:", error);
      }
    }
  }).catch(error => console.error("[Meet Focus Tracker] Could not process professor reminders:", error));
  return professorAlertQueue;
}

async function pollProfessorAlerts() {
  await auth.authStateReady();
  const { profile, activeSessionId } = await chrome.storage.local.get(["profile", "activeSessionId"]);
  if (profile?.role !== "student" || auth.currentUser?.uid !== profile.uid || !activeSessionId) return;
  const alertQuery = query(collection(db, "professorAlerts"), where("targetUids", "array-contains", profile.uid));
  const snapshot = await getDocs(alertQuery);
  await processProfessorAlerts(snapshot.docs.map(item => ({ id: item.id, data: item.data() })), activeSessionId);
}

async function syncProfessorAlertWatch() {
  await auth.authStateReady();
  const { profile, activeSessionId } = await chrome.storage.local.get(["profile", "activeSessionId"]);
  const user = auth.currentUser;
  const key = profile?.role === "student" && user?.uid === profile.uid && activeSessionId
    ? `${profile.uid}:${activeSessionId}`
    : "";
  if (key === professorAlertWatchKey) return;
  professorAlertUnsubscribe?.();
  professorAlertUnsubscribe = null;
  professorAlertWatchKey = key;
  if (!key) return;

  const alertQuery = query(collection(db, "professorAlerts"), where("targetUids", "array-contains", profile.uid));
  professorAlertUnsubscribe = onSnapshot(alertQuery, snapshot => {
    void processProfessorAlerts(snapshot.docChanges()
      .filter(change => change.type === "added")
      .map(change => ({ id: change.doc.id, data: change.doc.data() })), activeSessionId);
  }, error => console.error("[Meet Focus Tracker] Professor reminder sync failed:", error));
}

// Keep a student extension in sync when the professor starts or ends a class,
// even if the student joined Meet before the session was started.
async function syncStudentSessionWatch() {
  await auth.authStateReady();
  const { profile, activeMeeting } = await chrome.storage.local.get(["profile", "activeMeeting"]);
  const user = auth.currentUser;
  const key = profile?.role === "student" && user?.uid === profile.uid && activeMeeting
    ? `${profile.uid}:${activeMeeting}`
    : "";
  if (key === studentSessionWatchKey) return;
  studentSessionUnsubscribe?.();
  studentSessionUnsubscribe = null;
  studentSessionWatchKey = key;
  if (!key) return;

  // Students may read active sessions. Query by status so Firestore rules can
  // prove every returned document is readable, then select this Meet locally.
  const activeSessions = query(collection(db, "sessions"), where("status", "==", "active"));
  studentSessionUnsubscribe = onSnapshot(activeSessions, snapshot => {
    void (async () => {
      const current = snapshot.docs
        .map(item => ({ id: item.id, ...item.data() }))
        .filter(item => item.meetingCode === activeMeeting)
        .sort((a, b) => Number(b.startedAtMs ?? 0) - Number(a.startedAtMs ?? 0))[0];
      const state = await chrome.storage.local.get(["activeSessionId", "activeSessionRoom", "activeSessionTeacherUid"]);
      if (!current) {
        if (state.activeSessionRoom === activeMeeting) {
          await chrome.storage.local.remove(["activeSessionId", "activeSessionRoom", "activeSessionTeacherUid"]);
        }
        return;
      }
      if (state.activeSessionId !== current.id || state.activeSessionRoom !== activeMeeting || state.activeSessionTeacherUid !== current.teacherUid) {
        await chrome.storage.local.set({
          activeSessionId: current.id,
          activeSessionRoom: activeMeeting,
          activeSessionTeacherUid: current.teacherUid
        });
      }
    })().catch(error => console.error("[Meet Focus Tracker] Could not sync the active class session:", error));
  }, error => console.error("[Meet Focus Tracker] Active class session sync failed:", error));
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "professor-alert-poll") {
    void pollProfessorAlerts().catch(error => console.error("[Meet Focus Tracker] Reminder check failed:", error));
  }
});
chrome.alarms.create("professor-alert-poll", { periodInMinutes: 1 });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes.profile || changes.activeSessionId) {
      void syncProfessorAlertWatch().catch(error => console.error("[Meet Focus Tracker] Could not start reminder sync:", error));
    }
    if (changes.profile || changes.activeMeeting) {
      void syncStudentSessionWatch().catch(error => console.error("[Meet Focus Tracker] Could not start active session sync:", error));
    }
  }
});

chrome.notifications.onClicked.addListener(async notificationId => {
  if (!notificationId.startsWith("iseenta-")) return;
  const { activeMeetingTabId } = await chrome.storage.local.get("activeMeetingTabId");
  if (!Number.isInteger(activeMeetingTabId)) return;
  try {
    const tab = await chrome.tabs.update(activeMeetingTabId, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  } catch (error) {
    console.warn("[Meet Focus Tracker] Could not focus the class Meet tab:", error);
  }
});

async function ensureAuth() {
  await auth.authStateReady();
  if (auth.currentUser) return auth.currentUser;
  if (authInFlight) return authInFlight;

  authInFlight = signInWithGoogle({ interactive: false })
    .catch(e => {
      console.error("[Meet Focus Tracker] Background auth failed:", e);
      return null;
    })
    .finally(() => { authInFlight = null; });

  return authInFlight;
}

async function publishAuthState() {
  await auth.authStateReady();
  const user = auth.currentUser;
  const { profile } = await chrome.storage.local.get("profile");
  const validProfile = user && profile?.uid === user.uid
    ? { role: profile.role, uid: user.uid, email: user.email, name: user.displayName || user.email }
    : null;
  if (profile && !validProfile) await chrome.storage.local.remove("profile");
  const { extensionAuth } = await chrome.storage.local.get("extensionAuth");
  if (JSON.stringify(extensionAuth ?? null) !== JSON.stringify(validProfile)) {
    await chrome.storage.local.set({ extensionAuth: validProfile });
  }
}

let authStatePublishQueue = Promise.resolve();
auth.onAuthStateChanged(() => {
  // Serialize observer callbacks with sign-in/sign-out storage writes so an
  // earlier null-user callback can't overwrite the just-published signed-in user.
  authStatePublishQueue = authStatePublishQueue.then(publishAuthState, publishAuthState).then(syncProfessorAlertWatch).catch(error => {
    console.error("[Meet Focus Tracker] Couldn't publish auth state:", error);
  });
});

const MAX_OUTBOX = 500;
const SEND_TIMEOUT_MS = 10000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out")), ms))
  ]);
}

let outboxChain = Promise.resolve();
function updateOutbox(change) {
  const run = outboxChain.then(async () => {
    const { outbox = [] } = await chrome.storage.local.get("outbox");
    await chrome.storage.local.set({ outbox: change(outbox) });
  });
  outboxChain = run.catch(() => {});
  return run;
}

function scheduleRetry() {
  chrome.alarms.create("flush-outbox", { delayInMinutes: 1 });
}

function setSyncError(message) {
  return chrome.storage.local.set({ syncError: message });
}

async function resolveActiveSession(meetingCode) {
  const cached = await chrome.storage.local.get(["activeSessionId", "activeSessionRoom", "activeSessionTeacherUid"]);
  if (!navigator.onLine && cached.activeSessionRoom === meetingCode && cached.activeSessionId) {
    return cached.activeSessionId;
  }

  const snapshot = await getDocs(query(
    collection(db, "sessions"),
    where("status", "==", "active")
  ));
  const session = snapshot.docs
    .map(sessionDoc => ({ id: sessionDoc.id, ...sessionDoc.data() }))
    .filter(item => item.meetingCode === meetingCode)
    .sort((a, b) => b.startedAtMs - a.startedAtMs)[0];

  if (!session) {
    await chrome.storage.local.remove(["activeSessionId", "activeSessionRoom", "activeSessionTeacherUid"]);
    return null;
  }
  await chrome.storage.local.set({
    activeSessionId: session.id,
    activeSessionRoom: meetingCode,
    activeSessionTeacherUid: session.teacherUid
  });
  return session.id;
}

async function drainOutbox() {
  while (true) {
    const { outbox = [] } = await chrome.storage.local.get("outbox");
    const evt = outbox[0];
    if (!evt) return;

    if (!evt.sessionId || !Number.isInteger(evt.time) || !Number.isInteger(evt.tabCount)) {
      console.error("[Meet Focus Tracker] Discarding an event queued before session tracking was enabled.");
      await updateOutbox(box => box.filter(x => x.id !== evt.id));
      await setSyncError("discarded an old queued event; join the active class again");
      continue;
    }

    if (!navigator.onLine) {
      await setSyncError("offline, will retry");
      scheduleRetry();
      return;
    }

    const user = await ensureAuth();
    if (!user || user.uid !== evt.uid) {
      console.warn("[Meet Focus Tracker] Not signed in as the student; keeping events until they sign in.");
      await setSyncError("signed out, open the popup and sign in again");
      return;
    }

    try {
      await withTimeout(setDoc(doc(db, "events", evt.id), {
        type: evt.type,
        time: evt.time,
        clientTime: evt.time,
        meetingCode: evt.meetingCode,
        sessionId: evt.sessionId,
        student: evt.student,
        email: evt.email,
        uid: evt.uid,
        tabCount: evt.tabCount,
        receivedAt: serverTimestamp()
      }), SEND_TIMEOUT_MS);
    } catch (e) {
      if (e.code === "permission-denied") {
        // Retrying can't fix this one; drop it so it doesn't block the events behind it
        console.error("[Meet Focus Tracker] Firestore rejected an event:", e);
        await updateOutbox(box => box.filter(x => x.id !== evt.id));
        await setSyncError("Firestore rejected the event");
        continue;
      }
      console.error("[Meet Focus Tracker] Couldn't send event, will retry:", e);
      await setSyncError("couldn't reach Firestore, will retry");
      scheduleRetry();
      return;
    }

    console.log("[Meet Focus Tracker]", evt.email, evt.type, evt.meetingCode, new Date(evt.time).toLocaleTimeString());
    await updateOutbox(box => box.filter(x => x.id !== evt.id));
    await chrome.storage.local.set({ syncError: null });
  }
}

let flushing = null;
let flushAgain = false;
function flushOutbox() {
  if (flushing) {
    flushAgain = true;
    return flushing;
  }
  flushing = (async () => {
    try {
      do {
        flushAgain = false;
        await drainOutbox();
      } while (flushAgain);
    } catch (e) {
      console.error("[Meet Focus Tracker] Outbox flush failed:", e);
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "flush-outbox") flushOutbox();
});

async function saveEvent(evt) {
  const { profile } = await chrome.storage.local.get("profile");
  if (profile?.role !== "student" || !profile.consent) return;

  if (!Number.isFinite(evt.time)) evt.time = Date.now();
  evt.time = Math.trunc(evt.time);

  // Update the popup first so it reflects reality even if the write fails
  await chrome.storage.local.set({ currentMode: evt.type });

  const user = await ensureAuth();
  if (!user || user.uid !== profile.uid) {
    console.warn("[Meet Focus Tracker] Not signed in as the student; skipping event.");
    await setSyncError("signed out, open the popup and sign in again");
    return;
  }

  let sessionId;
  try {
    sessionId = await resolveActiveSession(evt.meetingCode);
  } catch (e) {
    console.error("[Meet Focus Tracker] Couldn't verify the active class session:", e);
    await setSyncError("couldn't verify the active class session");
    return;
  }
  if (!sessionId) {
    await setSyncError("no active class session for this Meet");
    return;
  }

  let tabCount;
  try {
    tabCount = Math.min((await chrome.tabs.query({})).length, 1000);
  } catch (e) {
    console.error("[Meet Focus Tracker] Couldn't count open tabs:", e);
    await setSyncError("couldn't read open tabs; event not queued");
    return;
  }

  const { joinedSessionIds = [] } = await chrome.storage.local.get("joinedSessionIds");
  const firstEventForSession = !joinedSessionIds.includes(sessionId);
  if (firstEventForSession && evt.type !== "JOINED") {
    await updateOutbox(box => {
      box.push({
        id: crypto.randomUUID(),
        uid: profile.uid,
        type: "JOINED",
        time: evt.time,
        meetingCode: evt.meetingCode,
        sessionId,
        tabCount,
        student: profile.name || profile.email,
        email: profile.email
      });
      return box.slice(-MAX_OUTBOX);
    });
  }
  if (firstEventForSession) {
    await chrome.storage.local.set({
      joinedSessionIds: [...joinedSessionIds, sessionId].slice(-100)
    });
  }

  await updateOutbox(box => {
    box.push({
      id: crypto.randomUUID(),
      uid: profile.uid,
      type: evt.type,
      time: evt.time,
      meetingCode: evt.meetingCode,
      sessionId,
      tabCount,
      student: profile.name || profile.email,
      email: profile.email
    });
    return box.slice(-MAX_OUTBOX);
  });

  flushOutbox();
}

let queue = Promise.resolve();
function serialized(fn) {
  queue = queue.then(fn, fn);
  return queue;
}

async function startMeeting(meetingCode, tabId, time) {
  const { activeMeeting, activeMeetingTabId } = await chrome.storage.local.get(["activeMeeting", "activeMeetingTabId"]);
  if (activeMeeting === meetingCode && activeMeetingTabId === tabId) return;
  // Joining a new call while another one is still recorded as open: close the old one
  if (activeMeeting) await saveEvent({ type: "LEFT", time, meetingCode: activeMeeting });

  await chrome.storage.local.set({ activeMeeting: meetingCode, activeMeetingTabId: tabId });
  await saveEvent({ type: "JOINED", time, meetingCode });
}

async function endMeeting(time, tabId, meetingCode) {
  const { activeMeeting, activeMeetingTabId } = await chrome.storage.local.get(["activeMeeting", "activeMeetingTabId"]);
  if (!activeMeeting) return;
  if (tabId !== undefined && tabId !== activeMeetingTabId) return;
  if (meetingCode !== undefined && meetingCode !== activeMeeting) return;

  await chrome.storage.local.set({ activeMeeting: null, activeMeetingTabId: null });
  await saveEvent({ type: "LEFT", time, meetingCode: activeMeeting });
}

async function handleSignIn(role, room, openDashboardAfterSignIn = true, forceAccountSelection = false) {
  await chrome.storage.local.remove("authError");
  if (role === "student") flushOutbox();
  try {
    // Reuse a restored Firebase session when present. Starting another
    // launchWebAuthFlow here can collide with another extension surface.
    await auth.authStateReady();
    const user = auth.currentUser || await signInWithGoogle({ interactive: true, forceAccountSelection });

    if (role === "professor" && !isProfessorEmail(user.email)) {
      await signOutGoogle();
      await chrome.storage.local.remove("profile");
      throw new Error(`${user.email} isn't recognized as a professor. You can only continue as a student.`);
    }

    const profile = { role, uid: user.uid, email: user.email, name: user.displayName || user.email };
    if (role === "student") profile.consent = true;
    await chrome.storage.local.set({ profile, extensionAuth: profile, syncError: null });

    if (role === "professor" && openDashboardAfterSignIn) {
      await openDashboard(room);
    } else {
      const { activeMeeting } = await chrome.storage.local.get("activeMeeting");
      if (activeMeeting) await saveEvent({ type: "JOINED", time: Date.now(), meetingCode: activeMeeting });
    }
    return { ok: true };
  } catch (e) {
    console.error("[Meet Focus Tracker] Sign-in failed:", e);
    const error = e.message || "Sign-in failed. Try again.";
    await chrome.storage.local.set({ authError: { role, message: error } });
    return { ok: false, error };
  }
}

async function openDashboard(room) {
  if (!room) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      room = tab?.url ? meetCodeFromUrl(tab.url) : null;
    } catch {
      // No focused window
    }
    if (!room) ({ activeMeeting: room } = await chrome.storage.local.get("activeMeeting"));
  }

  const path = room ? `dashboard/index.html?room=${encodeURIComponent(room)}` : "dashboard/index.html";
  await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
}

let signInInFlight = null;

function isDashboardSender(sender) {
  return !!sender.url?.startsWith(chrome.runtime.getURL("dashboard/"));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const dashboardSender = isDashboardSender(sender);
  if (msg?.cmd === "signIn" && (!sender.tab || dashboardSender)) {
    if (dashboardSender && msg.role !== "professor") return;
    if (msg.role !== "student" && msg.role !== "professor") return;
    if (msg.role === "student" && msg.consent !== true) return;
    const room = typeof msg.room === "string" && MEET_CODE_RE.test(msg.room) ? msg.room : null;
    if (!signInInFlight) {
      const forceAccountSelection = msg.forceAccountSelection === true;
      signInInFlight = serialized(() => handleSignIn(msg.role, room, !dashboardSender, forceAccountSelection))
        .finally(() => { signInInFlight = null; });
    }
    signInInFlight.then(sendResponse, () => sendResponse({ ok: false, error: "Sign-in failed. Try again." }));
    return true; // respond asynchronously
  }
  if (msg?.cmd === "signOut" && (!sender.tab || isDashboardSender(sender))) {
    serialized(async () => {
      try {
        // Record LEFT for an open meeting while still signed in, then sign out
        await endMeeting(Date.now());
        await flushOutbox();
        await chrome.storage.local.remove(["profile", "extensionAuth", "currentMode", "syncError", "authError"]);
        await signOutGoogle();
      } catch (e) {
        console.error("[Meet Focus Tracker] Sign-out failed:", e);
      }
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.cmd === "openDashboard" && !sender.tab) {
    openDashboard().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.cmd === "getExtensionAuth" && isDashboardSender(sender)) {
    publishAuthState().then(async () => {
      const { extensionAuth } = await chrome.storage.local.get("extensionAuth");
      sendResponse({ auth: extensionAuth ?? null });
    });
    return true;
  }

  const tabId = sender.tab?.id;
  if (!msg?.type || tabId === undefined) return;

  if (msg.type === "AWAY" && msg.visible && popupOpen) {
    sendResponse({ ignored: true });
    return;
  }

  serialized(async () => {
    if (msg.type === "JOINED") return startMeeting(msg.meetingCode, tabId, msg.time);
    if (msg.type === "LEFT") return endMeeting(msg.time, tabId, msg.meetingCode);

    const { activeMeeting, activeMeetingTabId } = await chrome.storage.local.get(["activeMeeting", "activeMeetingTabId"]);
    if (activeMeeting && activeMeetingTabId === tabId && msg.meetingCode === activeMeeting) {
      const allowedTypes = ["AWAY", "RETURNED", "IDLE", "LOCKED", "ACTIVE", "TABS_UPDATED", "HEARTBEAT"];
      if (allowedTypes.includes(msg.type)) {
        await saveEvent({ type: msg.type, time: msg.time, meetingCode: activeMeeting });
      }
    }
  });
});

let popupOpen = false;
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "popup" || port.sender?.tab) return;
  popupOpen = true;
  port.onDisconnect.addListener(() => { popupOpen = false; });
});

chrome.tabs.onRemoved.addListener(tabId => {
  serialized(() => endMeeting(Date.now(), tabId));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  serialized(async () => {
    const { activeMeeting, activeMeetingTabId } = await chrome.storage.local.get(["activeMeeting", "activeMeetingTabId"]);
    if (activeMeeting && tabId === activeMeetingTabId && meetCodeFromUrl(changeInfo.url) !== activeMeeting) {
      await endMeeting(Date.now(), tabId);
    }
  });
});

async function closeStaleMeeting() {
  const { activeMeeting } = await chrome.storage.local.get("activeMeeting");
  if (!activeMeeting) return;
  await endMeeting(Date.now());
}
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("professor-alert-poll", { periodInMinutes: 1 });
  serialized(closeStaleMeeting);
  flushOutbox();
  void syncProfessorAlertWatch();
  void syncStudentSessionWatch();
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("professor-alert-poll", { periodInMinutes: 1 });
  serialized(async () => {
    await chrome.storage.local.remove("student");
    await closeStaleMeeting();
  });
  flushOutbox();
  void syncProfessorAlertWatch();
  void syncStudentSessionWatch();
});

chrome.idle.setDetectionInterval(300);
chrome.idle.onStateChanged.addListener(state => {
  serialized(async () => {
    const { activeMeeting } = await chrome.storage.local.get("activeMeeting");
    if (!activeMeeting) return;
    await saveEvent({ type: state.toUpperCase(), time: Date.now(), meetingCode: activeMeeting });
  });
});
