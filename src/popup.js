import { auth } from "./firebase";
import { signInWithCredential, GoogleAuthProvider, onAuthStateChanged } from "firebase/auth";

const consentBox = document.getElementById("consent");
const status = document.getElementById("status");
const authBtn = document.getElementById("auth-btn");
const modeDisplay = document.getElementById("currentMode");
const userInfo = document.getElementById("user-info");
const userEmail = document.getElementById("user-email");

let currentUser = null;

function updateTheme(mode) {
  if (!mode) return;
  document.body.className = ''; // reset

  const m = mode.toUpperCase();
  modeDisplay.textContent = m;

  if (m === 'JOINED') document.body.classList.add('mode-joined');
  else if (m === 'RETURNED') document.body.classList.add('mode-returned');
  else if (m === 'AWAY') document.body.classList.add('mode-away');
  else if (m === 'IDLE') document.body.classList.add('mode-idle');
}

function updateUI(student) {
  if (student && student.email) {
    userInfo.style.display = "block";
    userEmail.textContent = student.email;
    consentBox.checked = student.consent;

    authBtn.innerHTML = "Save Settings";
    status.textContent = student.consent ? "Tracking is ON in Meet." : "Tracking is OFF.";
  }
}

onAuthStateChanged(auth, (user) => {
  currentUser = user;
});

chrome.storage.local.get(["student", "currentMode"], ({ student, currentMode }) => {
  updateUI(student);
  updateTheme(currentMode);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.currentMode) {
    updateTheme(changes.currentMode.newValue);
  }
});

authBtn.addEventListener("click", async () => {
  try {
    if (currentUser) {
      const student = {
        uid: currentUser.uid,
        email: currentUser.email,
        name: currentUser.displayName,
        consent: consentBox.checked
      };

      await chrome.storage.local.set({ student });
      updateUI(student);

      status.textContent = consentBox.checked
        ? "Saved. Tracking is ON in Meet."
        : "Saved. Tracking is OFF.";
      return;
    }

    const { token } = await chrome.identity.getAuthToken({ interactive: true });

    const credential = GoogleAuthProvider.credential(null, token);
    const userCredential = await signInWithCredential(auth, credential);
    const user = userCredential.user;

    const student = {
      uid: user.uid,
      email: user.email,
      name: user.displayName,
      consent: consentBox.checked
    };

    await chrome.storage.local.set({ student });
    updateUI(student);

    status.textContent = consentBox.checked
      ? "Saved. Tracking is ON in Meet."
      : "Saved. Tracking is OFF.";

  } catch (error) {
    console.error("Auth Error:", error);
    status.textContent = "Authentication failed. Try again.";
  }
});