import { addDoc, collection, doc, onSnapshot, query, serverTimestamp, updateDoc, where } from "firebase/firestore";
import { auth, db } from "./firebase";
import { meetCodeFromUrl } from "./config";

const $ = id => document.getElementById(id);

// Theme: follow the browser setting by default; the header toggle overrides it.
// Same storage key as the teacher dashboard so both stay in step.
const THEME_KEY = "kinetic-theme";
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
function storedTheme() {
  try { const v = localStorage.getItem(THEME_KEY); return v === "dark" || v === "light" ? v : null; } catch { return null; }
}
function applyTheme() {
  const stored = storedTheme();
  if (stored) document.documentElement.dataset.theme = stored; else delete document.documentElement.dataset.theme;
  const dark = (stored || (systemDark.matches ? "dark" : "light")) === "dark";
  const toggle = $("theme-toggle");
  if (toggle) {
    toggle.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    toggle.title = dark ? "Switch to light theme" : "Switch to dark theme";
    toggle.classList.toggle("is-dark", dark);
  }
}
applyTheme();
systemDark.addEventListener("change", applyTheme);
$("theme-toggle")?.addEventListener("click", () => {
  const dark = (storedTheme() || (systemDark.matches ? "dark" : "light")) === "dark";
  try { localStorage.setItem(THEME_KEY, dark ? "light" : "dark"); } catch {}
  applyTheme();
});

const screens = ["screen-role", "screen-student-signin", "screen-student", "screen-professor"];
let afkWatchKey = "";
let afkUnsubscribe = null;
let pendingAfkRequest = false;
let latestAfkRequest = null;
let latestRenderRequest = 0;

function updateStudentBackButton(sessionId) {
  const hasAfkRequest = latestAfkRequest && latestAfkRequest.sessionId === sessionId && latestAfkRequest.status !== "returned";
  $("student-im-back").hidden = !hasAfkRequest;
}

function show(screenId) {
  screens.forEach(id => { $(id).hidden = id !== screenId; });
}

function setMessage(id, text) {
  const el = $(id);
  el.textContent = text || "";
  el.classList.toggle("error", !!text);
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.classList.toggle("busy", busy);
}

function setAfkFeedback(text, kind = "") {
  const feedback = $("afk-feedback");
  feedback.textContent = text;
  feedback.className = `afk-feedback${kind ? ` ${kind}` : ""}`;
}

function watchAfkRequests(profile, sessionId) {
  const key = profile?.role === "student" && profile.uid && sessionId ? `${profile.uid}:${sessionId}` : "";
  if (key === afkWatchKey) return;
  afkUnsubscribe?.();
  afkUnsubscribe = null;
  afkWatchKey = key;
  pendingAfkRequest = false;
  latestAfkRequest = null;
  if (!key) {
    $("afk-open").disabled = true;
    return;
  }
  const requests = query(collection(db, "afkRequests"), where("studentUid", "==", profile.uid));
  afkUnsubscribe = onSnapshot(requests, snapshot => {
    const latest = snapshot.docs
      .map(item => ({ id: item.id, ...item.data() }))
      .filter(item => item.sessionId === sessionId)
      .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0))[0];
    latestAfkRequest = latest ? { id: latest.id, sessionId: latest.sessionId, status: latest.status } : null;
    pendingAfkRequest = latest?.status === "pending";
    chrome.storage.local.get(["activeMeeting", "activeSessionId"]).then(state => {
      $("afk-open").disabled = !state.activeMeeting || state.activeSessionId !== sessionId || pendingAfkRequest;
    });
    if (latest?.status === "returned") {
      setAfkFeedback("");
    } else if (latest) {
      const sentAt = latest.createdAt?.toDate?.().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) || "just now";
      setAfkFeedback(pendingAfkRequest
        ? `Notice sent at ${sentAt}. Your professor has been notified.`
        : `Your professor acknowledged your notice from ${sentAt}.`, "success");
    } else {
      setAfkFeedback("");
    }
    updateStudentBackButton(sessionId);
  }, error => {
    console.error("Could not sync AFK notices", error);
    setAfkFeedback(error?.code === "permission-denied"
      ? "Firebase rules denied access. Publish the latest firestore.rules to enable away notices."
      : "Could not load your notice status. Check your connection and try again.", "error");
  });
}

// ===== Student status badge =====
const MODE_LABELS = {
  JOINED: "In call",
  RETURNED: "Focused",
  ACTIVE: "Focused",
  AWAY: "Away",
  IDLE: "Idle",
  LOCKED: "Idle",
  LEFT: "Not in a call"
};

// Visual state per mode: status-hero color signal + eye glyph
const MODE_VIEW = {
  JOINED: { eye: "focused", signal: "active" },
  RETURNED: { eye: "focused", signal: "active" },
  ACTIVE: { eye: "focused", signal: "active" },
  AWAY: { eye: "away", signal: "away" },
  IDLE: { eye: "idle", signal: "idle" },
  LOCKED: { eye: "idle", signal: "idle" },
  LEFT: { eye: "not-in-a-call", signal: "not-detected" }
};

const EYE_OUTLINES = {
  focused: "M16 50 Q80 -11 144 50 Q80 111 16 50Z",
  idle: "M16 50 Q80 26 144 50 Q80 111 16 50Z",
  away: "M16 50 Q80 14 144 50 Q80 111 16 50Z"
};

function eyeMarkup(state) {
  const inner = state === "not-in-a-call"
    ? `<path d="M23 50 Q80 64 137 50" /><path d="M42 57 l-5 10 M66 61 l-2 10 M94 61 l2 10 M118 57 l5 10" />`
    : `<path d="${EYE_OUTLINES[state]}" /><circle class="eye-pupil" cx="${state === "away" ? 105 : 80}" cy="${state === "idle" ? 61 : 50}" r="19" /><circle class="eye-shine" cx="${state === "away" ? 111 : 86}" cy="${state === "idle" ? 55 : 44}" r="5" />`;
  return `<svg class="eye-glyph" viewBox="0 0 160 100" aria-hidden="true"><g class="eye-blink">${inner}</g></svg>`;
}

// Re-render (and blink) only when the visual state actually changes
let renderedEye = "";
function renderEye(state) {
  if (state === renderedEye) return;
  renderedEye = state;
  $("eye-slot").innerHTML = eyeMarkup(state);
}

const MODE_CLASSES = {
  JOINED: "mode-joined",
  RETURNED: "mode-returned",
  ACTIVE: "mode-returned",
  AWAY: "mode-away",
  IDLE: "mode-idle",
  LOCKED: "mode-idle"
};

function updateTheme(mode, activeMeeting) {
  document.body.classList.remove(...Object.values(MODE_CLASSES));
  const m = activeMeeting && mode ? mode.toUpperCase() : "LEFT";
  $("currentMode").textContent = MODE_LABELS[m] || m;
  const captions = {
    JOINED: "You’re in your class Meet.",
    RETURNED: "You’re back in the class Meet.",
    ACTIVE: "Your device is active in the class Meet.",
    AWAY: "Your Meet tab is currently in the background.",
    IDLE: "Your device is idle or locked.",
    LOCKED: "Your device is locked.",
    LEFT: "Join your class Meet to start sharing activity."
  };
  $("status-caption").textContent = captions[m] || captions.LEFT;
  if (MODE_CLASSES[m]) document.body.classList.add(MODE_CLASSES[m]);

  const view = MODE_VIEW[m] || MODE_VIEW.LEFT;
  $("status-hero").className = `status-hero signal-${view.signal}`;
  renderEye(view.eye);
  $("privacy-meet").textContent = view.eye === "away" ? "Meet tab hidden" : view.eye === "not-in-a-call" ? "Not connected to Meet" : "Meet tab visible";
  $("privacy-idle").textContent = view.eye === "idle" ? "Device idle or locked" : "Device not idle or locked";
}

function updateConnection({ activeMeeting, syncError }) {
  const el = $("connection");
  const session = $("sessionState");
  const code = $("meetingCode");
  if (syncError) {
    el.textContent = `Not syncing: ${syncError}`;
    el.className = "connection error";
  } else if (activeMeeting) {
    el.textContent = "Your session activity is syncing.";
    el.className = "connection ok";
  } else {
    el.textContent = "Tracking starts when you join an active class Meet.";
    el.className = "connection";
  }
  code.textContent = activeMeeting || "Waiting for class";
  session.textContent = activeMeeting ? "In session" : "Waiting";
  session.classList.toggle("live", Boolean(activeMeeting));
}

// ===== Professor dashboard =====
// Room code of the Meet tab the professor is on, otherwise the last tracked one
async function currentRoom() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const fromTab = tab?.url && meetCodeFromUrl(tab.url);
    if (fromTab) return fromTab;
  } catch {
    // No focused window; fall back to storage
  }
  const { activeMeeting } = await chrome.storage.local.get("activeMeeting");
  return activeMeeting || null;
}

// Sign-in runs in the background service worker so it survives the popup closing
function requestSignIn(role, extra = {}) {
  return chrome.runtime.sendMessage({ cmd: "signIn", role, consent: role === "student", ...extra });
}

// ===== Rendering from storage =====
async function render() {
  const renderRequest = ++latestRenderRequest;
  const state = await chrome.storage.local.get(["profile", "currentMode", "activeMeeting", "activeSessionId", "syncError", "authError", "latestProfessorAlert"]);
  // Ignore older storage reads if another state update already triggered render.
  if (renderRequest !== latestRenderRequest) return;
  const { profile, authError } = state;

  if (profile?.role === "student") {
    $("student-email").textContent = profile.email;
    updateTheme(state.currentMode, state.activeMeeting);
    updateConnection(state);
    watchAfkRequests(profile, state.activeSessionId);
    $("afk-open").disabled = !state.activeMeeting || !state.activeSessionId || pendingAfkRequest;
    $("professor-alert-message").textContent = state.latestProfessorAlert && state.latestProfessorAlert.sessionId === state.activeSessionId
      ? state.latestProfessorAlert.message
      : "";
    $("professor-alert").hidden = !state.latestProfessorAlert || state.latestProfessorAlert.sessionId !== state.activeSessionId;
    updateStudentBackButton(state.activeSessionId);
    show("screen-student");
  } else if (profile?.role === "professor") {
    watchAfkRequests(null, null);
    $("professor-email").textContent = profile.email;
    $("professor-avatar").textContent = (profile.name || profile.email || "P").split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join("") || "P";
    const room = await currentRoom();
    if (renderRequest !== latestRenderRequest) return;
    $("professor-room").textContent = room
      ? `Dashboard will open for room ${room}.`
      : "Open this from a Google Meet tab to filter the dashboard to that room.";
    show("screen-professor");
  } else if (authError?.role === "student") {
    watchAfkRequests(null, null);
    show("screen-student-signin");
    setMessage("student-message", authError.message);
  } else if ($("screen-student-signin").hidden) {
    watchAfkRequests(null, null);
    // Don't kick a student off the consent screen while they're filling it in
    show("screen-role");
    setMessage("role-message", authError?.message);
  }
}

function renderSafely() {
  void render().catch(error => {
    console.error("Could not render the extension popup:", error);
    show("screen-role");
    const detail = error instanceof Error ? error.message : String(error);
    setMessage("role-message", "Could not load account state: " + detail);
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") renderSafely();
});

// ===== Role selection =====
$("role-student").addEventListener("click", () => {
  const button = $("role-student");
  if (button.disabled) return;
  setMessage("role-message", "");
  setMessage("student-message", "");
  $("consent").checked = false;
  $("student-signin-btn").disabled = true;
  // Switch immediately; storage cleanup must not block the popup interaction.
  show("screen-student-signin");
  void chrome.storage.local.remove("authError").catch(error => {
    console.warn("Could not clear the previous sign-in error:", error);
  });
});

$("role-professor").addEventListener("click", async () => {
  const btn = $("role-professor");
  const other = $("role-student");
  setMessage("role-message", "");
  setBusy(btn, true);
  other.disabled = true;
  try {
    // Send the previewed room along so the dashboard can't open for a different window
    const result = await requestSignIn("professor", { room: await currentRoom() });
    // On success the background opens the dashboard tab, which closes this popup
    if (!result?.ok) setMessage("role-message", result?.error || "Sign-in failed. Try again.");
  } catch (e) {
    console.error("Professor sign-in failed:", e);
    setMessage("role-message", "Sign-in failed. Try again.");
  } finally {
    setBusy(btn, false);
    other.disabled = false;
  }
});

// ===== Student sign-in =====
$("consent").addEventListener("change", () => {
  $("student-signin-btn").disabled = !$("consent").checked;
});

$("student-signin-btn").addEventListener("click", async () => {
  const btn = $("student-signin-btn");
  if (!$("consent").checked) {
    setMessage("student-message", "You need to enable tracking to continue as a student.");
    return;
  }

  setMessage("student-message", "");
  setBusy(btn, true);
  try {
    const result = await requestSignIn("student");
    if (!result?.ok) setMessage("student-message", result?.error || "Sign-in failed. Try again.");
  } catch (e) {
    console.error("Student sign-in failed:", e);
    setMessage("student-message", "Sign-in failed. Try again.");
  } finally {
    setBusy(btn, !$("consent").checked);
  }
});

// ===== Sign out / back =====
// Signs out in the background, which also closes any meeting still being tracked
async function signOutAndReset() {
  try {
    await chrome.runtime.sendMessage({ cmd: "signOut" });
    await render();
  } catch (e) {
    console.error("Sign-out failed:", e);
    // Show real state instead of claiming a sign-out that didn't happen
    render();
  }
}

$("student-signout").addEventListener("click", signOutAndReset);
$("professor-signout").addEventListener("click", signOutAndReset);
$("open-dashboard").addEventListener("click", () => chrome.runtime.sendMessage({ cmd: "openDashboard" }));
$("afk-open").addEventListener("click", () => {
  if ($("afk-open").disabled) return;
  $("afk-form").hidden = false;
  document.querySelector('.reason-chip[aria-pressed="true"]')?.focus();
});
$("afk-cancel").addEventListener("click", () => { $("afk-form").hidden = true; });
document.querySelectorAll(".reason-chip").forEach(chip => chip.addEventListener("click", () => {
  document.querySelectorAll(".reason-chip").forEach(other => other.setAttribute("aria-pressed", String(other === chip)));
  $("afk-reason").value = chip.dataset.reason;
}));
$("afk-send").addEventListener("click", async () => {
  const button = $("afk-send");
  if (button.disabled || pendingAfkRequest) return;
  setBusy(button, true);
  setAfkFeedback("Sending your notice…");
  try {
    await auth.authStateReady();
    const state = await chrome.storage.local.get(["profile", "activeMeeting", "activeSessionId", "activeSessionTeacherUid"]);
    const profile = state.profile;
    if (profile?.role !== "student" || auth.currentUser?.uid !== profile.uid || !state.activeMeeting || !state.activeSessionId || !state.activeSessionTeacherUid) {
      throw new Error("Join an active class Meet and sign in as a student before sending a notice.");
    }
    await addDoc(collection(db, "afkRequests"), {
      sessionId: state.activeSessionId,
      teacherUid: state.activeSessionTeacherUid,
      studentUid: profile.uid,
      studentEmail: profile.email,
      studentName: profile.name || profile.email,
      reason: $("afk-reason").value,
      status: "pending",
      createdAt: serverTimestamp()
    });
    $("afk-form").hidden = true;
    setAfkFeedback("Notice sent. Your professor can acknowledge it from the dashboard.", "success");
  } catch (error) {
    console.error("Could not send AFK notice", error);
    setAfkFeedback(error instanceof Error ? error.message : "Could not send your notice. Please try again.", "error");
  } finally {
    setBusy(button, false);
    render();
  }
});
$("dismiss-professor-alert").addEventListener("click", async () => {
  const { latestProfessorAlert } = await chrome.storage.local.get("latestProfessorAlert");
  if (latestProfessorAlert?.id) await chrome.notifications.clear(`iseenta-${latestProfessorAlert.id}`);
  await chrome.storage.local.remove("latestProfessorAlert");
});
$("student-im-back").addEventListener("click", async () => {
  const button = $("student-im-back");
  if (button.disabled) return;
  setBusy(button, true);
  let noticeError = null;
  let currentSessionId = null;
  try {
    const state = await chrome.storage.local.get(["activeSessionId", "latestProfessorAlert"]);
    currentSessionId = state.activeSessionId;
    if (latestAfkRequest && latestAfkRequest.sessionId === state.activeSessionId && latestAfkRequest.status !== "returned") {
      await updateDoc(doc(db, "afkRequests", latestAfkRequest.id), {
        status: "returned",
        returnedAt: serverTimestamp()
      });
    }
    if (state.latestProfessorAlert?.sessionId === state.activeSessionId) {
      if (state.latestProfessorAlert.id) await chrome.notifications.clear(`iseenta-${state.latestProfessorAlert.id}`);
      await chrome.storage.local.remove("latestProfessorAlert");
    }
    setAfkFeedback("");
  } catch (error) {
    console.error("Could not mark the student as back", error);
    noticeError = error;
    setAfkFeedback(error?.code === "permission-denied"
      ? "Could not clear your away notice. Publish the latest firestore.rules and try again."
      : "Could not update your notice. Check your connection and try again.", "error");
    const { latestProfessorAlert } = await chrome.storage.local.get("latestProfessorAlert");
    if (latestProfessorAlert?.sessionId === currentSessionId) {
      if (latestProfessorAlert.id) await chrome.notifications.clear(`iseenta-${latestProfessorAlert.id}`);
      await chrome.storage.local.remove("latestProfessorAlert");
    }
  } finally {
    setBusy(button, false);
    if (!noticeError) await render();
  }
});
document.querySelectorAll("[data-back]").forEach(btn =>
  btn.addEventListener("click", async () => {
    await chrome.storage.local.remove("authError");
    setMessage("student-message", "");
    show("screen-role");
  })
);

// Lets the background know the popup is open (see AWAY handling in background.js)
chrome.runtime.connect({ name: "popup" });

// The service worker owns authentication. Render immediately from extension
// storage instead of waiting for Firebase initialization in the popup.
renderSafely();
