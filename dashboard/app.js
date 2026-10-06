// ===== Firebase setup (same project as the extension) =====
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, query, where, orderBy, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAL9NhthsEicdZogXISL1SyEezKKaOWKaM",
  authDomain: "gmeet-focus-tracker.firebaseapp.com",
  projectId: "gmeet-focus-tracker",
  storageBucket: "gmeet-focus-tracker.firebasestorage.app",
  messagingSenderId: "596698279952",
  appId: "1:596698279952:web:7ffe0c5dd7031419f1da95"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// The extension writes to "events" (see background.js)
const EVENTS_COLLECTION = "events";

// Optional: only show one class session. Idle events only carry a meetingCode
// after the background.js patch, so leave this null until you've applied it.
const FILTER_MEET_CODE = null; // e.g. "imi-ssy-ouo"

let rawEvents = [];
let studentData = [];
let showOnlySwitchers = false;
let unsubscribe = null;

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function buildStudentRows(events) {
  const byStudent = new Map();
  events.forEach(evt => {
    if (!evt.email) return;
    if (!byStudent.has(evt.email)) byStudent.set(evt.email, []);
    byStudent.get(evt.email).push(evt);
  });

  const rows = [];

  byStudent.forEach((evts, email) => {
    evts.sort((a, b) => a.time - b.time);

    let inMeet = false, away = false, idle = false, everJoined = false;
    let switches = 0, activeMs = 0, focusedSince = null;
    let name = email;

    const settle = t => {
      const focused = inMeet && !away && !idle;
      if (focused && focusedSince === null) focusedSince = t;
      if (!focused && focusedSince !== null) {
        activeMs += t - focusedSince;
        focusedSince = null;
      }
    };

    evts.forEach(evt => {
      if (evt.student) name = evt.student;
      switch (evt.type) {
        case "JOINED":   inMeet = true; away = false; idle = false; everJoined = true; break;
        case "RETURNED": inMeet = true; away = false; everJoined = true; break;
        case "AWAY":     inMeet = true; away = true; switches += 1; everJoined = true; break;
        case "LEFT":     inMeet = false; away = false; break;
        case "IDLE":
        case "LOCKED":   idle = true; break;
        case "ACTIVE":   idle = false; break;
      }
      settle(evt.time);
    });

    // Ignore people with only idle events (never actually in a Meet)
    if (!everJoined) return;

    if (focusedSince !== null) activeMs += Date.now() - focusedSince;

    const status = !inMeet ? "Left" : away ? "Away" : idle ? "Idle" : "Active";
    const last = evts[evts.length - 1];

    rows.push({
      name,
      email,
      status,
      focusDuration: `${Math.round(activeMs / 60000)} m focus`,
      switches,
      lastEvent: humanizeEventType(last.type),
      lastTime: new Date(last.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    });
  });

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function humanizeEventType(type) {
  switch (type) {
    case "JOINED": return "Joined the Google Meet";
    case "RETURNED": return "Returned to Google Meet";
    case "AWAY": return "Switched Tab";
    case "IDLE": return "No Movements";
    case "ACTIVE": return "Active again";
    case "LOCKED": return "Screen Locked";
    case "LEFT": return "Left the meeting";
    default: return type;
  }
}

function refresh() {
  const events = FILTER_MEET_CODE
    ? rawEvents.filter(e => e.meetingCode === FILTER_MEET_CODE)
    : rawEvents;
  studentData = buildStudentRows(events);
  renderTable();
  updateStats();
}

// ===== Live subscription (today's events only) =====
function startListening() {
  stopListening();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const q = query(
    collection(db, EVENTS_COLLECTION),
    where("time", ">=", startOfToday.getTime()),
    orderBy("time", "asc")
  );

  unsubscribe = onSnapshot(q, snapshot => {
    rawEvents = snapshot.docs.map(d => d.data());
    refresh();
  }, err => {
    console.error("Failed to load events:", err);
    showTableMessage(
      err.code === "permission-denied"
        ? "This account isn't authorized to view the dashboard."
        : "Couldn't load events. Check the console."
    );
  });
}

function stopListening() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  rawEvents = [];
  studentData = [];
}

function showTableMessage(msg) {
  const tbody = document.getElementById("student-tbody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="4">${escapeHtml(msg)}</td></tr>`;
}

function getDotClass(status) {
  switch (status.toLowerCase()) {
    case 'active': return 'dot-active';
    case 'away': return 'dot-away';
    case 'idle': return 'dot-idle';
    case 'left': return 'dot-left';
    default: return '';
  }
}

function renderTable() {
  const tbody = document.getElementById("student-tbody");
  if (!tbody) return;

  const displayList = showOnlySwitchers
    ? studentData.filter(s => s.switches >= 3)
    : studentData;

  if (displayList.length === 0) {
    showTableMessage("No student activity yet.");
    return;
  }

  tbody.innerHTML = displayList.map(s => {
    const isLeft = s.status.toLowerCase() === 'left';
    return `
      <tr class="${isLeft ? 'row-left' : ''}">
        <td class="student-col">
          <div class="name">${escapeHtml(s.name)}</div>
          <div class="email">${escapeHtml(s.email)}</div>
        </td>
        <td>
          <div class="status-cell">
            <span class="table-dot ${getDotClass(s.status)}"></span>
            ${escapeHtml(s.status)}
          </div>
        </td>
        <td>
          <div class="duration-primary">${escapeHtml(s.focusDuration)}</div>
          <div class="duration-secondary">${s.switches} Switch/s</div>
        </td>
        <td>
          <div class="event-name">${escapeHtml(s.lastEvent)}</div>
          <div class="event-time">${escapeHtml(s.lastTime)}</div>
        </td>
      </tr>
    `;
  }).join('');
}

// ===== Stat cards (Attendance / Focused / Away) =====
function updateStats() {
  const total = studentData.length;
  const present = studentData.filter(s => s.status.toLowerCase() !== 'left').length;
  const focusedCount = studentData.filter(s => s.status.toLowerCase() === 'active').length;
  const awayCount = studentData.filter(s => s.status.toLowerCase() === 'away').length;

  const attendanceEl = document.getElementById('stat-attendance');
  const focusedEl = document.getElementById('stat-focused');
  const awayEl = document.getElementById('stat-away');

  if (attendanceEl) attendanceEl.textContent = `${present}/${total}`;
  if (focusedEl) focusedEl.textContent = focusedCount;
  if (awayEl) awayEl.textContent = awayCount;
}

// ===== Show Switchers toggle =====
function initShowSwitchersButton() {
  const btn = document.getElementById('btn-show-switchers');
  if (!btn) return;

  btn.addEventListener('click', () => {
    showOnlySwitchers = !showOnlySwitchers;
    btn.textContent = showOnlySwitchers ? 'SHOW ALL' : 'SHOW SWITCHERS';
    renderTable();
  });
}

// ===== Teacher sign-in =====
function initAuth() {
  const link = document.getElementById('nav-signin');

  link?.addEventListener('click', e => {
    e.preventDefault();
    if (auth.currentUser) signOut(auth);
    else signInWithPopup(auth, new GoogleAuthProvider()).catch(console.error);
  });

  onAuthStateChanged(auth, user => {
    if (user) {
      if (link) link.textContent = 'SIGN OUT';
      startListening();
    } else {
      if (link) link.textContent = 'SIGN IN';
      stopListening();
      showTableMessage('Sign in with your teacher account to view activity.');
      updateStats();
    }
  });

  setInterval(() => { if (rawEvents.length) refresh(); }, 30000);
}

let timerInterval = null;
let elapsedSeconds = 0;

function formatTime(totalSeconds) {
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function updateTimerDisplay() {
  const timerEl = document.getElementById('timer-value');
  if (timerEl) timerEl.textContent = formatTime(elapsedSeconds);
}

function startTimer() {
  if (timerInterval) return;
  timerInterval = setInterval(() => {
    elapsedSeconds++;
    updateTimerDisplay();
  }, 1000);
}

function pauseTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function endTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  elapsedSeconds = 0;
  updateTimerDisplay();
}

function initControlButtons() {
  document.getElementById('btn-start')?.addEventListener('click', startTimer);
  document.getElementById('btn-pause')?.addEventListener('click', pauseTimer);
  document.getElementById('btn-end')?.addEventListener('click', endTimer);
}

document.addEventListener('DOMContentLoaded', () => {
  updateTimerDisplay();
  initShowSwitchersButton();
  initControlButtons();
  initAuth();
});