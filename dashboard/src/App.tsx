import { useEffect, useMemo, useState } from "react";
import { addDoc, collection, doc, onSnapshot, query, serverTimestamp, updateDoc, where } from "firebase/firestore";
import { onAuthStateChanged, signOut } from "firebase/auth/web-extension";
import { signInWithPopup as webSignInWithPopup } from "firebase/auth";
import { Activity, BookOpen, CalendarDays, Check, Clock3, Copy, History, Info, LockKeyhole, LogIn, LogOut, Moon, PanelsTopLeft, Pause, Pencil, Play, Search, Square, Sun, Users, Video, WifiOff, X } from "lucide-react";
import { useRef } from "react";
import { auth, db, googleProvider } from "./firebase";
import wordmarkLight from "../assets/seenta-wordmark-light.png";
import wordmarkDark from "../assets/seenta-wordmark-dark.png";

type EventType = "JOINED" | "RETURNED" | "AWAY" | "LEFT" | "IDLE" | "LOCKED" | "ACTIVE" | "TABS_UPDATED" | "HEARTBEAT";
type TrackerEvent = { email?: string; student?: string; type: EventType; time: number; tabCount?: number; meetingCode?: string; sessionId?: string; receivedAt?: { seconds?: number; nanoseconds?: number; toMillis?: () => number } | null };
type ClassSession = { id: string; meetingCode: string; status: "active" | "paused"; startedAtMs: number; elapsedMs: number; pausedAtMs?: number; teacherUid?: string };
type SessionDocument = { status?: string; startedAtMs?: number; elapsedMs?: number; pausedAtMs?: number | null; teacherUid?: string };
type Status = "Active" | "Idle" | "Away" | "Not detected" | "Left";
type Student = { name: string; email: string; status: Status; focusMs: number; tabCount: number | null; lastEvent: string; lastTime: string };
type StudentActivityStats = { switches: number; meetingMs: number; focusedMs: number; awayMs: number; idleMs: number; focusPercent: number; counts: Map<EventType, number> };

const statusClass: Record<Status, string> = { Active: "active", Idle: "idle", Away: "away", "Not detected": "not-detected", Left: "left" };
const meetingCodePattern = /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/i;
const presenceTimeoutMs = 75_000;
// Keep this dashboard gate aligned with PROFESSOR_EMAILS in src/config.js and
// the isProfessor() allowlist in firestore.rules. Firestore rules remain authoritative.
const professorEmails = new Set([
  "draconic788@gmail.com",
  "renzkerbysajuelaofficial@gmail.com",
  "ajosejustingabriel@gmail.com",
]);
const isProfessorEmail = (email: string | null | undefined) => Boolean(email && professorEmails.has(email.toLowerCase()));
const parseMeetingCode = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const candidate = trimmed.startsWith("meet.google.com/") ? `https://${trimmed}` : trimmed;
  if (candidate.includes("://")) {
    try {
      const url = new URL(candidate);
      if (url.hostname.toLowerCase() !== "meet.google.com") return "";
      const code = url.pathname.split("/").filter(Boolean)[0] ?? "";
      return meetingCodePattern.test(code) ? code.toLowerCase() : "";
    } catch { return ""; }
  }
  return meetingCodePattern.test(trimmed) ? trimmed.toLowerCase() : "";
};
const labelEvent = (type: EventType) => ({ JOINED: "Joined the Google Meet", RETURNED: "Returned to Google Meet", AWAY: "Meet tab hidden", LEFT: "Left the meeting", IDLE: "No device input", LOCKED: "Screen locked", ACTIVE: "Active again", TABS_UPDATED: "Browser tab count updated", HEARTBEAT: "Presence check" })[type] ?? type;
const formatClock = (seconds: number) => [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map(n => String(n).padStart(2, "0")).join(":");
const formatDuration = (milliseconds: number) => {
  const totalMinutes = Math.floor(milliseconds / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours} hr ${minutes} min` : `${minutes} min`;
};
const formatEventTime = (milliseconds: number) => new Date(milliseconds).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const initials = (name: string) => name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase() ?? "").join("") || "?";
const statusOrder: Status[] = ["Active", "Idle", "Away", "Not detected", "Left"];
const attentionStatuses = new Set<Status>(["Away", "Idle", "Not detected"]);

function summarizeStudentActivity(events: TrackerEvent[], asOf: number): StudentActivityStats {
  const sorted = [...events].sort((a, b) => a.time - b.time);
  const counts = new Map<EventType, number>();
  let inMeet = false, away = false, idle = false, switches = 0;
  let meetingMs = 0, focusedMs = 0, awayMs = 0, idleMs = 0;
  let previousTime: number | null = null;
  const accumulate = (time: number) => {
    if (previousTime === null || !inMeet) return;
    const duration = Math.max(0, time - previousTime);
    meetingMs += duration;
    if (away) awayMs += duration;
    else if (idle) idleMs += duration;
    else focusedMs += duration;
  };
  for (const event of sorted) {
    accumulate(event.time);
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    switch (event.type) {
      case "JOINED": inMeet = true; away = false; idle = false; break;
      case "RETURNED": inMeet = true; away = false; break;
      case "AWAY": inMeet = true; away = true; switches += 1; break;
      case "LEFT": inMeet = false; away = false; idle = false; break;
      case "IDLE": case "LOCKED": idle = true; break;
      case "ACTIVE": idle = false; break;
    }
    previousTime = event.time;
  }
  const last = sorted.at(-1);
  if (last && inMeet && previousTime !== null) {
    const effectiveAsOf = Math.min(asOf, last.time + presenceTimeoutMs);
    accumulate(effectiveAsOf);
  }
  return { switches, meetingMs, focusedMs, awayMs, idleMs, focusPercent: meetingMs ? Math.round(focusedMs / meetingMs * 100) : 0, counts };
}

function toStudents(events: TrackerEvent[], now: number): Student[] {
  const grouped = new Map<string, TrackerEvent[]>();
  for (const event of events) {
    if (!event.email) continue;
    const list = grouped.get(event.email) ?? [];
    list.push(event);
    grouped.set(event.email, list);
  }
  const students: Student[] = [];
  for (const [email, list] of grouped) {
    list.sort((a, b) => {
      const aReceipt = a.receivedAt?.seconds;
      const bReceipt = b.receivedAt?.seconds;
      if (typeof aReceipt === "number" && typeof bReceipt === "number") {
        return aReceipt - bReceipt || (a.receivedAt?.nanoseconds ?? 0) - (b.receivedAt?.nanoseconds ?? 0);
      }
      return a.time - b.time;
    });
    let inMeet = false, away = false, idle = false, joined = false, focusMs = 0, focusedSince: number | null = null, tabCount: number | null = null, name = email;
    const settle = (time: number) => {
      const focused = inMeet && !away && !idle;
      if (focused && focusedSince === null) focusedSince = time;
      else if (!focused && focusedSince !== null) { focusMs += Math.max(0, time - focusedSince); focusedSince = null; }
    };
    for (const event of list) {
      name = event.student || name;
      if (Number.isInteger(event.tabCount) && (event.tabCount as number) >= 0) tabCount = event.tabCount as number;
      switch (event.type) {
        case "JOINED": case "RETURNED": inMeet = true; away = false; joined = true; if (event.type === "JOINED") idle = false; break;
        case "AWAY": inMeet = true; away = true; joined = true; break;
        case "LEFT": inMeet = false; away = false; break;
        case "IDLE": case "LOCKED": idle = true; break;
        case "ACTIVE": idle = false; break;
      }
      settle(event.time);
    }
    if (!joined) continue;
    const last = list[list.length - 1];
    const presenceExpired = inMeet && now > last.time + presenceTimeoutMs;
    if (focusedSince !== null) focusMs += Math.max(0, Math.min(now, last.time + presenceTimeoutMs) - focusedSince);
    const lastVisibleEvent = list.slice().reverse().find(event => event.type !== "HEARTBEAT") ?? last;
    students.push({ name, email, status: !inMeet ? "Left" : presenceExpired ? "Not detected" : away ? "Away" : idle ? "Idle" : "Active", focusMs, tabCount, lastEvent: labelEvent(lastVisibleEvent.type), lastTime: new Date(lastVisibleEvent.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) });
  }
  return students.sort((a, b) => a.name.localeCompare(b.name));
}

export default function App() {
  const detailDialog = useRef<HTMLDialogElement>(null);
  const [user, setUser] = useState(auth.currentUser);
  const [events, setEvents] = useState<TrackerEvent[]>([]);
  const [loadError, setLoadError] = useState("");
  const [authError, setAuthError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [meetingCode, setMeetingCode] = useState(() => {
    const roomFromPopup = parseMeetingCode(new URLSearchParams(window.location.search).get("room") || "");
    return roomFromPopup || localStorage.getItem("kinetic-test-meeting-code") || "";
  });
  const [meetingLinkDraft, setMeetingLinkDraft] = useState(() => {
    const savedCode = localStorage.getItem("kinetic-test-meeting-code") || "";
    return savedCode ? `https://meet.google.com/${savedCode}` : "";
  });
  const [meetingLinkError, setMeetingLinkError] = useState("");
  const [activeSession, setActiveSession] = useState<ClassSession | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const timerRunning = activeSession?.status === "active";
  const elapsedMs = activeSession ? activeSession.elapsedMs + (timerRunning ? Math.max(0, now - activeSession.startedAtMs) : 0) : 0;
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const [dark, setDark] = useState(() => localStorage.getItem("kinetic-theme") === "dark");
  const [navPinned, setNavPinned] = useState(false);
  const [awayOnly, setAwayOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [meetingCodeCopied, setMeetingCodeCopied] = useState(false);
  const [editingLink, setEditingLink] = useState(false);
  const [selectedStudentEmail, setSelectedStudentEmail] = useState<string | null>(null);

  useEffect(() => onAuthStateChanged(auth, currentUser => {
    if (!currentUser) { setUser(null); return; }
    if (!isProfessorEmail(currentUser.email)) {
      setUser(null);
      setAuthError("This Google account is not authorized to view the professor dashboard.");
      void signOut(auth);
      return;
    }
    setAuthError("");
    setUser(currentUser);
  }), []);
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); localStorage.setItem("kinetic-theme", dark ? "dark" : "light"); }, [dark]);
  useEffect(() => {
    const onScroll = () => {
      setNavPinned(window.scrollY > 24);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => {
    const dialog = detailDialog.current;
    if (!dialog) return;
    if (selectedStudentEmail && !dialog.open) dialog.showModal();
    else if (!selectedStudentEmail && dialog.open) dialog.close();
  }, [selectedStudentEmail]);
  useEffect(() => { if (!user || !meetingCode) { setActiveSession(null); return; }
    const roomSessions = query(collection(db, "sessions"), where("meetingCode", "==", meetingCode));
    return onSnapshot(roomSessions, snap => {
      const match = snap.docs
        .map(item => ({ id: item.id, ...(item.data() as SessionDocument) }))
        .filter(item => item.status === "active" || item.status === "paused")
        .sort((a, b) => Number(b.startedAtMs ?? 0) - Number(a.startedAtMs ?? 0))[0];
      if (!match) { setActiveSession(null); return; }
      setActiveSession({ id: match.id, meetingCode, status: match.status === "active" ? "active" : "paused", startedAtMs: Number(match.startedAtMs ?? Date.now()), elapsedMs: Number(match.elapsedMs ?? 0), pausedAtMs: Number(match.pausedAtMs ?? 0), teacherUid: match.teacherUid });
    }, error => { console.error("Could not load class session", error); setLoadError("Could not load the class session. Check Firestore rules."); });
  }, [user, meetingCode]);
  useEffect(() => {
    if (!user || !activeSession) { setEvents([]); return; }
    setLoadError("");
    const sessionEvents = query(collection(db, "events"), where("sessionId", "==", activeSession.id));
    return onSnapshot(sessionEvents, snap => setEvents(snap.docs.map(item => { const data = item.data(); const serverTime = data.receivedAt?.toMillis?.(); return { ...data, time: typeof serverTime === "number" ? serverTime : Number(data.time) } as TrackerEvent; })), error => {
      console.error("Could not load session events", error);
      setLoadError(error.code === "permission-denied" ? "This Google account is not authorized to view this session." : "Could not load session activity. Check Firestore rules and try again.");
    });
  }, [user, activeSession?.id]);

  const students = useMemo(() => toStudents(events, activeSession?.status === "paused" ? (activeSession.pausedAtMs || now) : now), [events, now, activeSession?.status, activeSession?.pausedAtMs]);
  const visible = useMemo(() => students.filter(s => (!awayOnly || s.status === "Away") && `${s.name} ${s.email}`.toLowerCase().includes(search.trim().toLowerCase())), [students, awayOnly, search]);
  const present = students.filter(s => s.status !== "Left").length;
  const focusedNow = students.filter(student => student.status === "Active").length;
  const totalOpenTabs = students.reduce((total, student) => total + (student.tabCount ?? 0), 0);
  const studentsWithTabCounts = students.filter(student => student.tabCount !== null).length;
  const attention = students.filter(s => s.status === "Away" || s.status === "Idle" || s.status === "Not detected").length;
  const selectedStudent = students.find(student => student.email === selectedStudentEmail) ?? null;
  const selectedEvents = selectedStudent ? events.filter(event => event.email === selectedStudent.email).sort((a, b) => b.time - a.time) : [];
  const detailAsOf = activeSession?.status === "paused" ? (activeSession.pausedAtMs || now) : now;
  const activityStats = selectedStudent ? summarizeStudentActivity(selectedEvents, detailAsOf) : null;
  const ownsActiveSession = !activeSession || activeSession.teacherUid === user?.uid;
  const signIn = async () => {
    setAuthError("");
    const extensionRuntime = (globalThis as typeof globalThis & { chrome?: { runtime?: { id?: string } } }).chrome?.runtime;
    if (extensionRuntime?.id) {
      setAuthError("Sign in as a professor from the extension popup, then refresh this dashboard.");
      return;
    }
    try {
      const credential = await webSignInWithPopup(auth, googleProvider);
      if (!isProfessorEmail(credential.user.email)) {
        await signOut(auth);
        setAuthError("This Google account is not authorized to view the professor dashboard.");
      }
    } catch (error) { setAuthError(error instanceof Error ? error.message : "Google sign-in failed."); }
  };
  const saveMeetingLink = () => {
    const code = parseMeetingCode(meetingLinkDraft);
    if (!code) { setMeetingLinkError("Paste a valid Google Meet link or code, such as meet.google.com/abc-defg-hij."); return; }
    setMeetingCode(code);
    setMeetingLinkDraft(`https://meet.google.com/${code}`);
    localStorage.setItem("kinetic-test-meeting-code", code);
    setMeetingLinkError("");
    setEditingLink(false);
  };
  const toggleTimer = async () => {
    if (!user) { setAuthError("Sign in with the teacher account to start a class session."); return; }
    if (!meetingCode) { setMeetingLinkError("Set your separate test Google Meet link before starting a session."); return; }
    setSessionBusy(true);
    try {
      const timestamp = Date.now();
      if (activeSession?.status === "active") {
        await updateDoc(doc(db, "sessions", activeSession.id), { status: "paused", elapsedMs, pausedAtMs: timestamp, updatedAt: serverTimestamp() });
      } else if (activeSession?.status === "paused") {
        await updateDoc(doc(db, "sessions", activeSession.id), { status: "active", startedAtMs: timestamp, pausedAtMs: null, updatedAt: serverTimestamp() });
      } else {
        await addDoc(collection(db, "sessions"), { status: "active", meetingCode, course: "INTE 301: Systems Integration and Application", classLabel: "BSIT 3-5", startedAtMs: timestamp, elapsedMs: 0, startedAt: serverTimestamp(), teacherUid: user.uid });
      }
    } catch (error) { console.error("Could not update class session", error); setLoadError("Could not update the class session. Firestore rules may need team approval."); }
    finally { setSessionBusy(false); }
  };
  const stopTimer = async () => {
    if (!activeSession) return;
    setSessionBusy(true);
    try { await updateDoc(doc(db, "sessions", activeSession.id), { status: "ended", elapsedMs, endedAt: serverTimestamp(), updatedAt: serverTimestamp() }); setActiveSession(null); }
    catch (error) { console.error("Could not stop class session", error); setLoadError("Could not stop the session. Check Firestore rules."); }
    finally { setSessionBusy(false); }
  };
  const copyMeetingCode = async () => {
    try {
      await navigator.clipboard.writeText(meetingCode);
      setMeetingCodeCopied(true);
      window.setTimeout(() => setMeetingCodeCopied(false), 1800);
    } catch (error) {
      console.error("Could not copy meeting code", error);
    }
  };


  const statusCounts = statusOrder.map(status => ({ status, count: students.filter(s => s.status === status).length }));
  const breakdownShare = (ms: number) => activityStats && activityStats.meetingMs ? (ms / activityStats.meetingMs) * 100 : 0;
  const sessionStateLabel = activeSession ? (timerRunning ? "Live" : "Paused") : "Ready";

  const sessionSignal = activeSession ? (timerRunning ? "active" : "idle") : "not-detected";
  const filtersActive = awayOnly || search.trim() !== "";
  const clearFilters = () => { setSearch(""); setAwayOnly(false); };
  const pulseLive = activeSession ? (timerRunning ? "Updating live" : "Updates paused") : "Ready to start";
  const empty = !user
    ? { icon: LogIn, title: "Sign in to view live activity", text: "Sign in with your teacher Google account to view live activity." }
    : visible.length > 0 ? null
    : events.length > 0 ? { icon: Search, title: "No students found", text: "Try another name or turn off Show switchers." }
    : activeSession ? { icon: Users, title: "No activity yet", text: "No student activity recorded today." }
    : { icon: Users, title: "Ready for your next class", text: "Start the session when your class is ready." };
  const EmptyIcon = empty?.icon ?? Search;
  const drawerStats = activityStats ? [
    ["Tab switches", String(activityStats.switches)],
    ["Estimated focused", formatDuration(activityStats.focusedMs)],
    ["Focus share", `${activityStats.focusPercent}%`],
    ["Time in Meet", formatDuration(activityStats.meetingMs)],
    ["Away from Meet", formatDuration(activityStats.awayMs)],
    ["Idle or locked", formatDuration(activityStats.idleMs)],
  ] : [];

  return <div className="app-shell">
    <header className={`topbar ${navPinned ? "scrolled" : ""}`}>
      <div className="brand-block"><img className="brand-wordmark brand-wordmark-light" src={wordmarkLight} alt="Seenta" /><img className="brand-wordmark brand-wordmark-dark" src={wordmarkDark} alt="Seenta" /><span className="brand-caption">Class activity tracker</span></div>
      <nav className="topnav" aria-label="Session navigation">
        <a className="btn btn-ghost nav-link" href="#activity"><History />Session activity</a>
        <span className="nav-divider" />
        <button type="button" className="btn btn-ghost nav-link" onClick={() => user ? signOut(auth) : void signIn()}>{user ? <LogOut /> : <LogIn />}{user ? "Sign out" : "Sign in"}</button>
        <button type="button" className="btn btn-ghost btn-icon icon-bordered" onClick={() => setDark(v => !v)} aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} title={dark ? "Switch to light theme" : "Switch to dark theme"}>{dark ? <Sun /> : <Moon />}</button>
      </nav>
    </header>
    <main id="top" className="workspace">
      <div className="page-intro"><div><h1>Your class, at a glance.</h1><p>A little visibility. A more connected classroom.</p></div></div>

      <section className="session-panel" aria-label="Current class session">
        <div>
          <div className="course-context"><BookOpen size={15} />Your current class</div>
          <h2 className="course-title">INTE 301 Systems Integration<br className="lg-br" /> and Application</h2>
          <div className="course-meta"><span><Users size={15} />BSIT 3-5</span><span><CalendarDays size={14} />9:00 to 11:30 AM</span></div>
        </div>
        <div className="session-tools">
          <div className="timer-row">
            <div className="timer-main">
              <div className="timer-head"><span className="timer-caption">Session elapsed</span><span className={`pill status-pill signal-${sessionSignal}`}><span className="dot" />{sessionStateLabel}</span></div>
              <div className="number timer">{formatClock(elapsedSeconds)}</div>
            </div>
            <div className="timer-controls">
              <button type="button" className="btn btn-ghost btn-icon ctrl ctrl-solid" onClick={() => void toggleTimer()} disabled={sessionBusy || !ownsActiveSession} aria-label={timerRunning ? "Pause session tracking" : activeSession ? "Resume session tracking" : "Start class session"} title={timerRunning ? "Pause tracking" : activeSession ? "Resume tracking" : "Start session"}>{timerRunning ? <Pause /> : <Play />}</button>
              <button type="button" className="btn btn-ghost btn-icon ctrl ctrl-ghost" onClick={() => void stopTimer()} disabled={sessionBusy || !activeSession || !ownsActiveSession} aria-label="Stop class session" title="Stop session"><Square size={14} /></button>
            </div>
          </div>
          <div className="meeting-tools">
            {meetingCode && !editingLink ? <>
              <span className="meet-chip"><Video size={15} /><span className="meeting-code">{meetingCode}</span>
              <button type="button" className="btn btn-ghost btn-icon" onClick={() => void copyMeetingCode()} aria-label={meetingCodeCopied ? "Meeting code copied" : "Copy meeting code"} title={meetingCodeCopied ? "Copied" : "Copy meeting code"}>{meetingCodeCopied ? <Check /> : <Copy />}</button>
              {!activeSession && <button type="button" className="btn btn-ghost btn-icon" onClick={() => { setMeetingLinkDraft(`https://meet.google.com/${meetingCode}`); setMeetingLinkError(""); setEditingLink(true); }} aria-label="Change meeting link" title="Change meeting link"><Pencil /></button>}</span>
              <a className="btn btn-primary meet-button" href={`https://meet.google.com/${meetingCode}`} target="_blank" rel="noreferrer"><Video />Open Google Meet</a>
            </> : <span className="meet-chip editing"><Video size={15} />
              <input className="meeting-input" value={meetingLinkDraft} onChange={event => setMeetingLinkDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") saveMeetingLink(); if (event.key === "Escape" && meetingCode) { setEditingLink(false); setMeetingLinkError(""); } }} placeholder="Paste Meet link or code" aria-label="Google Meet link or code" disabled={Boolean(activeSession)} />
              <button type="button" className="btn btn-primary btn-sm set-link" onClick={saveMeetingLink} disabled={Boolean(activeSession)}>Set link</button>
              {meetingCode && <button type="button" className="btn btn-ghost btn-icon" onClick={() => { setEditingLink(false); setMeetingLinkError(""); }} aria-label="Cancel editing" title="Cancel editing"><X /></button>}
            </span>}
          </div>
          {meetingLinkError && <p className="small meeting-error" role="alert">{meetingLinkError}</p>}
        </div>
      </section>

      <section className="pulse-section" aria-label="Class pulse">
        <div>
          <div className="pulse-heading"><h2><Activity />Class pulse</h2><span className="pulse-live"><Clock3 size={12} />{pulseLive}</span></div>
          <div className="stacked-bar" role="img" aria-label={statusCounts.map(item => `${item.count} ${item.status}`).join(", ")}>{statusCounts.map(item => <span key={item.status} className={`signal-${statusClass[item.status]} ${item.count === 0 ? "empty" : ""}`} style={{ flexGrow: item.count }} />)}</div>
          <div className="pulse-legend">{statusCounts.map(item => <span key={item.status} className={`legend-item signal-${statusClass[item.status]}`}><span className="dot" />{item.status}<b>{item.count}</b></span>)}</div>
        </div>
        <div className="pulse-figures">
          <div><p className="pulse-figure-label">Attendance</p><div className="number pulse-number">{present}<small>/{students.length}</small></div><p className="pulse-figure-note">Students in session</p></div>
          <div><p className="pulse-figure-label">Focused now</p><div className="number pulse-number">{focusedNow}</div><p className="pulse-figure-note">Active in Meet</p></div>
          <div><p className="pulse-figure-label">Needs attention</p><div className="number pulse-number">{attention}</div><p className="pulse-figure-note">Idle, away or undetected</p></div>
        </div>
      </section>

      <section id="activity" className="panel roster-panel" aria-label="Student activity">
        <div className="roster-header">
          <div><h2>Student activity</h2><p>{activeSession ? "Live focus signals for this class session" : "Start the class session to begin tracking Meet focus."}</p></div>
          <div className="roster-tools">
            <label className="search-box"><Search size={16} /><input aria-label="Search students" placeholder="Search students" value={search} onChange={e => setSearch(e.target.value)} />{search && <button type="button" className="btn btn-ghost btn-icon" aria-label="Clear search" onClick={() => setSearch("")}><X /></button>}</label>
            <button type="button" className="btn btn-ghost switch-control" aria-pressed={awayOnly} onClick={() => setAwayOnly(v => !v)} title="Show only students whose Meet tab is hidden or in another tab"><span className="switch-track"><span className="switch-thumb" /></span>Show switchers</button>
          </div>
        </div>
        {authError && <div className="inline-notice error" role="alert"><Info size={15} /><span>{authError}</span></div>}
        {loadError && <div className="inline-notice error" role="alert"><WifiOff size={15} /><span>{loadError}</span></div>}
        {activeSession && !ownsActiveSession && <div className="inline-notice" role="status"><Info size={15} /><span>This session is controlled by a different professor.</span></div>}
        <table className="roster-table"><caption className="sr-only">Student activity signals for INTE 301, BSIT 3-5.</caption><thead><tr><th scope="col">Student</th><th scope="col">Status</th><th scope="col">Focus time</th><th scope="col">Last event</th></tr></thead><tbody>{user && visible.map(student => <tr key={student.email} className={`signal-${statusClass[student.status]} ${attentionStatuses.has(student.status) ? "attention" : ""}`}>
          <td><div className="student-cell"><div className="avatar" aria-hidden="true">{initials(student.name)}</div><div className="student-info"><button type="button" className="btn btn-link student-name" onClick={() => setSelectedStudentEmail(student.email)} aria-label={`View activity details for ${student.name}`}>{student.name}</button><div className="student-email">{student.email}</div></div></div></td>
          <td><span className={`pill status-pill signal-${statusClass[student.status]}`}><span className="dot" />{student.status}</span></td>
          <td><div className="focus-cell"><div className="focus-details"><span>{Math.round(student.focusMs / 60000)} min</span><span className="tab-chip" aria-label={`${student.tabCount ?? "Unknown"} open browser tabs`}><PanelsTopLeft />{student.tabCount ?? "—"} {student.tabCount === 1 ? "tab" : "tabs"}</span></div><div className="focus-track" aria-hidden="true"><div className="focus-fill" style={{ width: `${Math.min(100, activeSession ? student.focusMs / Math.max(1, elapsedMs) * 100 : 0)}%` }} /></div></div></td>
          <td><div className="event-label">{student.lastEvent}</div><div className="event-time">{student.lastTime}</div></td>
        </tr>)}</tbody></table>
        {empty && <div className="empty-state"><EmptyIcon size={27} /><h3>{empty.title}</h3><p>{empty.text}</p>{!user ? <button type="button" className="btn btn-outline empty-action" onClick={() => void signIn()}>Sign in with Google</button> : filtersActive && events.length > 0 && <button type="button" className="btn btn-outline empty-action" onClick={clearFilters}>Clear filters</button>}</div>}
        <div className="roster-footer"><span>{students.length ? `Showing ${visible.length} of ${students.length} students` : "No active students"}{studentsWithTabCounts > 0 && ` · ${totalOpenTabs} open tab${totalOpenTabs === 1 ? "" : "s"} across ${studentsWithTabCounts} browser${studentsWithTabCounts === 1 ? "" : "s"}`}</span><span className="footer-note"><Info size={12} />Activity signals, not attention scores</span></div>
      </section>
      <footer className="page-footer"><span className="footer-note"><LockKeyhole />Only Meet visibility, idle signals and tab counts are shared.</span><span>Seenta for Polytechnic University of the Philippines</span></footer>
    </main>

    <dialog ref={detailDialog} className="student-drawer" aria-labelledby="student-detail-title" onClose={() => setSelectedStudentEmail(null)} onClick={event => { if (event.target === event.currentTarget) detailDialog.current?.close(); }}>
      {selectedStudent && activityStats && <div className="drawer-inner">
        <button type="button" className="btn btn-ghost btn-icon drawer-close" onClick={() => detailDialog.current?.close()} aria-label="Close student details" title="Close student details"><X /></button>
        <div className="drawer-heading"><div className="avatar" aria-hidden="true">{initials(selectedStudent.name)}</div><h2 id="student-detail-title">{selectedStudent.name}</h2><p>{selectedStudent.email}</p><span className={`pill status-pill signal-${statusClass[selectedStudent.status]}`}><span className="dot" />{selectedStudent.status}</span></div>
        <section className="drawer-section"><h3>Time in this session</h3>
          <div className="stacked-bar" role="img" aria-label={`Focused ${formatDuration(activityStats.focusedMs)}, away ${formatDuration(activityStats.awayMs)}, idle ${formatDuration(activityStats.idleMs)}`}>{([["active", activityStats.focusedMs], ["away", activityStats.awayMs], ["idle", activityStats.idleMs]] as const).map(([key, ms]) => <span key={key} className={`signal-${key} ${ms <= 0 ? "empty" : ""}`} style={{ flexGrow: Math.max(breakdownShare(ms), 0) }} />)}</div>
          <div className="pulse-legend">{([["Focused", "active"], ["Away", "away"], ["Idle or locked", "idle"]] as const).map(([label, key]) => <span key={key} className={`legend-item signal-${key}`}><span className="dot" />{label}</span>)}</div>
          <div className="stat-grid">{drawerStats.map(([label, value]) => <div key={label}><div className="number">{value}</div><p>{label}</p></div>)}</div>
          <p className="disclaimer"><Info /><span>These are activity estimates from Meet tab visibility and device idle signals. They do not measure attention.</span></p>
        </section>
        <section className="drawer-section"><h3>Activity counts</h3>{(["JOINED", "RETURNED", "AWAY", "IDLE", "LOCKED", "ACTIVE", "LEFT", "TABS_UPDATED"] as EventType[]).map(type => <div className="count-row" key={type}><span>{labelEvent(type)}</span><strong className="number">{activityStats.counts.get(type) ?? 0}</strong></div>)}</section>
        <section className="drawer-section"><h3>Recent activity <span className="muted">({selectedEvents.length}{events.filter(event => event.email === selectedStudent.email).length > 100 ? " most recent" : ""})</span></h3>{selectedEvents.length ? <ol className="timeline">{selectedEvents.slice(0, 100).map((event, index) => <li key={`${event.type}-${event.time}-${index}`}><time>{formatEventTime(event.time)}</time><span>{labelEvent(event.type)}{event.type === "TABS_UPDATED" && Number.isInteger(event.tabCount) ? ` · ${event.tabCount} open tabs` : ""}</span></li>)}</ol> : <p className="muted">No activity recorded for this student.</p>}</section>
      </div>}
    </dialog>
  </div>;
}
