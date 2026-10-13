import { auth } from "./firebase";
import { meetCodeFromUrl } from "./config";

const $ = id => document.getElementById(id);

const screens = ["screen-role", "screen-student-signin", "screen-student", "screen-professor"];

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

// ===== Student status badge =====
const MODE_LABELS = {
  JOINED: "IN CALL",
  RETURNED: "FOCUSED",
  ACTIVE: "FOCUSED",
  AWAY: "AWAY",
  IDLE: "IDLE",
  LOCKED: "IDLE",
  LEFT: "NOT IN A CALL"
};

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
    AWAY: "The class Meet tab is not in view.",
    IDLE: "No device input has been detected.",
    LOCKED: "Your device is locked.",
    LEFT: "Join your class Meet to begin."
  };
  $("status-caption").textContent = captions[m] || captions.LEFT;
  if (MODE_CLASSES[m]) document.body.classList.add(MODE_CLASSES[m]);
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
  session.textContent = activeMeeting ? "IN SESSION" : "WAITING";
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
  const state = await chrome.storage.local.get(["profile", "currentMode", "activeMeeting", "syncError", "authError"]);
  const { profile, authError } = state;

  if (profile?.role === "student") {
    $("student-email").textContent = profile.email;
    updateTheme(state.currentMode, state.activeMeeting);
    updateConnection(state);
    show("screen-student");
  } else if (profile?.role === "professor") {
    $("professor-email").textContent = profile.email;
    const room = await currentRoom();
    $("professor-room").textContent = room
      ? `Dashboard will open for room ${room}.`
      : "Open this from a Google Meet tab to filter the dashboard to that room.";
    show("screen-professor");
  } else if (authError?.role === "student") {
    show("screen-student-signin");
    setMessage("student-message", authError.message);
  } else if ($("screen-student-signin").hidden) {
    // Don't kick a student off the consent screen while they're filling it in
    show("screen-role");
    setMessage("role-message", authError?.message);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") render();
});

// ===== Role selection =====
$("role-student").addEventListener("click", () => {
  chrome.storage.local.remove("authError");
  setMessage("role-message", "");
  setMessage("student-message", "");
  $("consent").checked = false;
  $("student-signin-btn").disabled = true;
  show("screen-student-signin");
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
    show("screen-role");
  } catch (e) {
    console.error("Sign-out failed:", e);
    // Show real state instead of claiming a sign-out that didn't happen
    render();
  }
}

$("student-signout").addEventListener("click", signOutAndReset);
$("professor-signout").addEventListener("click", signOutAndReset);
$("open-dashboard").addEventListener("click", () => chrome.runtime.sendMessage({ cmd: "openDashboard" }));
document.querySelectorAll("[data-back]").forEach(btn =>
  btn.addEventListener("click", async () => {
    await chrome.storage.local.remove("authError");
    setMessage("student-message", "");
    show("screen-role");
  })
);

// Lets the background know the popup is open (see AWAY handling in background.js)
chrome.runtime.connect({ name: "popup" });

// Wait for Firebase to restore its saved session before picking a screen; render anyway
// if that fails so the popup never stays blank
auth.authStateReady().catch(e => console.error("Auth restore failed:", e)).finally(render);
