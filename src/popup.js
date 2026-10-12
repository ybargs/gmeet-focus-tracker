import { auth } from "./firebase";
import { GoogleAuthProvider, onAuthStateChanged, signInWithCredential, signOut } from "firebase/auth";

const consentBox = document.getElementById("consent");
const status = document.getElementById("status");
const authBtn = document.getElementById("auth-btn");
const modeDisplay = document.getElementById("currentMode");
const statusDetail = document.getElementById("statusDetail");
const sessionState = document.getElementById("sessionState");
const meetingCodeDisplay = document.getElementById("meetingCode");
const signedOut = document.getElementById("signedOut");
const signedIn = document.getElementById("signedIn");
const userName = document.getElementById("user-name");
const userEmail = document.getElementById("user-email");
const avatar = document.getElementById("avatar");
const signOutButton = document.getElementById("sign-out");

let currentUser = null;
let savedStudent = null;
let currentMode = "UNKNOWN";
let activeMeeting = null;
let activeSessionId = null;

function setFeedback(message, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function render() {
  const signed = Boolean(currentUser);
  signedOut.hidden = signed;
  signedIn.hidden = !signed;
  authBtn.textContent = signed ? "Save tracking preference" : "Sign in with Google";
  authBtn.disabled = false;
  consentBox.disabled = !signed;
  if (signed) {
    userName.textContent = currentUser.displayName || savedStudent?.name || "Student";
    userEmail.textContent = currentUser.email || savedStudent?.email || "";
    avatar.textContent = (currentUser.displayName || currentUser.email || "S").trim().charAt(0).toUpperCase();
    consentBox.checked = Boolean(savedStudent?.consent);
  } else {
    consentBox.checked = false;
  }

  const tracking = Boolean(savedStudent?.consent && activeSessionId);
  modeDisplay.textContent = currentMode;
  document.body.classList.remove("mode-active", "mode-away", "mode-idle", "mode-left");
  if (currentMode === "ACTIVE" || currentMode === "RETURNED" || currentMode === "JOINED") document.body.classList.add("mode-active");
  else if (currentMode === "AWAY") document.body.classList.add("mode-away");
  else if (currentMode === "IDLE" || currentMode === "LOCKED") document.body.classList.add("mode-idle");
  else if (currentMode === "LEFT") document.body.classList.add("mode-left");

  if (activeSessionId && activeMeeting) {
    sessionState.textContent = "Live";
    sessionState.className = "state-pill live";
    meetingCodeDisplay.textContent = activeMeeting;
  } else {
    sessionState.textContent = currentUser ? "Waiting" : "Sign in";
    sessionState.className = "state-pill";
    meetingCodeDisplay.textContent = currentUser ? "No active session yet" : "Sign in to check";
  }
  if (!activeSessionId) {
    modeDisplay.textContent = "NOT IN CLASS";
    statusDetail.textContent = currentUser ? "Tracking starts when your Meet code matches an active class session." : "Sign in to check for the active class session.";
  } else if (!savedStudent?.consent) {
    modeDisplay.textContent = "TRACKING OFF";
    statusDetail.textContent = "Enable class tracking below to share focus and idle events.";
  } else {
    statusDetail.textContent = tracking ? "Your Meet focus, idle status, and open-tab count are being recorded for this session." : "Waiting for the next focus update.";
  }
}

onAuthStateChanged(auth, user => {
  currentUser = user;
  render();
});

chrome.storage.local.get(["student", "currentMode", "activeMeeting", "activeSessionId"], values => {
  savedStudent = values.student || null;
  currentMode = values.currentMode || "UNKNOWN";
  activeMeeting = values.activeMeeting || null;
  activeSessionId = values.activeSessionId || null;
  render();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.student) savedStudent = changes.student.newValue || null;
  if (changes.currentMode) currentMode = changes.currentMode.newValue || "UNKNOWN";
  if (changes.activeMeeting) activeMeeting = changes.activeMeeting.newValue || null;
  if (changes.activeSessionId) activeSessionId = changes.activeSessionId.newValue || null;
  render();
});

authBtn.addEventListener("click", async () => {
  authBtn.disabled = true;
  setFeedback("Please wait…");
  try {
    let user = currentUser;
    if (!user) {
      const { token } = await chrome.identity.getAuthToken({ interactive: true });
      if (!token) throw new Error("Google sign-in did not return an account token.");
      const credential = GoogleAuthProvider.credential(null, token);
      user = (await signInWithCredential(auth, credential)).user;
    }
    const student = {
      uid: user.uid,
      email: user.email,
      name: user.displayName,
      consent: Boolean(consentBox.checked)
    };
    await chrome.storage.local.set({ student, ...(student.consent ? {} : { pendingEvents: [] }) });
    savedStudent = student;
    render();
    setFeedback(student.consent ? "Saved. Tracking is enabled for active class sessions." : "Saved. Tracking is off.");
  } catch (error) {
    console.error("[iSEENTA] Sign-in/settings error:", error);
    setFeedback(error instanceof Error ? error.message : "Could not save sign-in settings.", true);
  } finally { authBtn.disabled = false; }
});

signOutButton.addEventListener("click", async () => {
  await chrome.storage.local.set({ student: { ...savedStudent, consent: false }, pendingEvents: [] });
  await signOut(auth);
  currentUser = null;
  savedStudent = { ...savedStudent, consent: false };
  render();
  setFeedback("Signed out. Tracking is off.");
});

consentBox.addEventListener("change", () => {
  if (!currentUser) return;
  setFeedback(consentBox.checked ? "Save to enable tracking." : "Save to turn tracking off.");
});

