import { useEffect, useMemo, useState } from "react";
import { addDoc, collection, doc, onSnapshot, query, serverTimestamp, updateDoc, where } from "firebase/firestore";
import { onAuthStateChanged, signOut } from "firebase/auth/web-extension";
import { signInWithPopup as webSignInWithPopup } from "firebase/auth";
import { Check, Clock, Copy, Eye, ExternalLink, History, LogIn, LogOut, Moon, PanelsTopLeft, Pause, Pencil, Play, Search, SlidersHorizontal, Square, Sun, Users, UserRoundX, Video, X } from "lucide-react";
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

function Metric({ icon: Icon, label, value, note, tone = "" }: { icon: typeof Users; label: string; value: string | number; note: string; tone?: string }) {
  return <div className="figure"><span className={`figure-icon ${tone}`}><Icon size={17} /></span><div><strong>{value}</strong><span className="figure-label">{label}</span><small>{note}</small></div></div>;
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
  const sessionState = activeSession ? (timerRunning ? "live" : "paused") : "ready";
  const sessionStateLabel = activeSession ? (timerRunning ? "Live" : "Paused") : "Ready";

  return <div className="app-shell">
    <header className={`topbar ${navPinned ? "scrolled" : ""}`}>
      <div className="brand"><img className="brand-wordmark brand-wordmark-light" src={wordmarkLight} alt="Seenta" /><img className="brand-wordmark brand-wordmark-dark" src={wordmarkDark} alt="Seenta" /><span className="brand-divider" /><span className="brand-caption">Class activity tracker</span></div>
      <nav className="top-actions"><a className="history-link" href="#activity"><History size={15}/> Session activity</a><button className="text-button" onClick={() => user ? signOut(auth) : void signIn()}>{user ? <LogOut size={16}/> : <LogIn size={16}/>} {user ? "Sign out" : "Sign in"}</button><button className="icon-button" onClick={() => setDark(v => !v)} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>{dark ? <Sun size={18}/> : <Moon size={18}/>}</button></nav>
    </header>
    <main id="top" className="page">
      <section className="session" aria-label="Class session">
        <div className="session-info">
          <span className="course-chip"><Video size={14} /> INTE 301</span>
          <h1>Systems Integration and Application</h1>
          <p className="session-meta"><span><Clock size={16} /> 9:00 AM to 11:30 AM</span><span><Users size={16} /> BSIT 3-5</span></p>
        </div>
        <aside className="session-panel" aria-label="Google Meet link and controls">
          <div className="timer-block">
            <span className={`state-chip ${sessionState}`}><i />{sessionStateLabel}</span>
            <strong className="timer">{formatClock(elapsedSeconds)}</strong>
          </div>
          <div className="timer-controls">
            <button className="control primary" onClick={() => void toggleTimer()} disabled={sessionBusy || !ownsActiveSession} aria-label={timerRunning ? "Pause session tracking" : activeSession ? "Resume session tracking" : "Start class session"} title={timerRunning ? "Pause tracking" : activeSession ? "Resume tracking" : "Start session"}>{timerRunning ? <Pause size={18}/> : <Play size={18}/>}</button>
            <button className="control" onClick={() => void stopTimer()} disabled={sessionBusy || !activeSession || !ownsActiveSession} aria-label="Stop class session" title="Stop session"><Square size={16}/></button>
          </div>
          <div className="code-block">
            <small>Meeting code</small>
            {meetingCode && !editingLink ? <div className="code-box"><strong>{meetingCode}</strong>
              {!activeSession && <button className="code-icon" onClick={() => { setMeetingLinkDraft(`https://meet.google.com/${meetingCode}`); setEditingLink(true); }} aria-label="Change meeting link" title="Change meeting link"><Pencil size={16}/></button>}
              <button className="code-icon" onClick={() => void copyMeetingCode()} aria-label={meetingCodeCopied ? "Meeting code copied" : "Copy meeting code"} title={meetingCodeCopied ? "Copied" : "Copy meeting code"}>{meetingCodeCopied ? <Check size={17}/> : <Copy size={17}/>}</button></div>
            : <div className="code-box code-edit"><input value={meetingLinkDraft} onChange={event => setMeetingLinkDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") saveMeetingLink(); }} placeholder="Paste test Meet link or code" aria-label="Test Google Meet link" disabled={Boolean(activeSession)} /><button className="code-save" onClick={saveMeetingLink} disabled={Boolean(activeSession)}>Set link</button></div>}
            {meetingLinkError && <small className="code-error">{meetingLinkError}</small>}
          </div>
          <a className={`open-meet ${meetingCode ? "" : "disabled"}`} href={meetingCode ? `https://meet.google.com/${meetingCode}` : undefined} aria-disabled={!meetingCode} onClick={event => { if (!meetingCode) event.preventDefault(); }} target="_blank" rel="noreferrer">Open Google Meet <ExternalLink size={16}/></a>
        </aside>
      </section>

      <section className="pulse" aria-label="Class pulse">
        <div className="pulse-head">
          <div><h2>Class pulse</h2><p>{activeSession ? "Where every student is right now" : "Start the class session to see live status."}</p></div>
          <div className="pulse-figures"><Metric icon={Users} label="Attendance" value={`${present}/${students.length}`} note="Students checked in"/><Metric icon={Eye} label="Focused now" value={focusedNow} note={students.length ? "Meet visible, device active" : "Waiting for activity"} tone="green"/><Metric icon={UserRoundX} label="Needs attention" value={attention} note="Idle, away or not detected" tone="gold"/></div>
        </div>
        <div className="pulse-bar" role="img" aria-label={statusCounts.map(item => `${item.count} ${item.status}`).join(", ")}>{statusCounts.filter(item => item.count > 0).map(item => <i key={item.status} className={`seg ${statusClass[item.status]}`} style={{ flexGrow: item.count }} />)}</div>
        <ul className="pulse-legend">{statusCounts.map(item => <li key={item.status}><span className={`status-dot ${statusClass[item.status]}`}/>{item.status}<strong>{item.count}</strong></li>)}</ul>
      </section>

      <section id="activity" className="roster" aria-label="Student activity">
        <div className="roster-heading">
          <div><h2>Student activity</h2><p>{activeSession ? "Live focus signals for this class session" : "Start the class session to begin tracking Meet focus."}</p></div>
          <div className="roster-tools">
            <label className="search"><Search size={18}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search students" aria-label="Search students"/></label>
            <button className={`filter-button ${awayOnly ? "selected" : ""}`} onClick={() => setAwayOnly(v => !v)} aria-pressed={awayOnly} title="Filter students whose Meet tab is hidden or in another tab"><SlidersHorizontal size={16}/>{awayOnly ? "Show everyone" : "Show switchers"}</button>
          </div>
        </div>
        {authError && <div className="notice error">{authError}</div>}{loadError && <div className="notice error">{loadError}</div>}{activeSession && !ownsActiveSession && <div className="notice">This session is controlled by a different professor.</div>}
        <div className="table-wrap"><table><thead><tr><th scope="col">Student</th><th scope="col">Status</th><th scope="col">Focus time</th><th scope="col">Last event</th></tr></thead><tbody>{!user ? <tr><td colSpan={4} className="empty">Sign in with your teacher Google account to view live activity.</td></tr> : visible.length === 0 ? <tr><td colSpan={4} className="empty">{events.length ? "No students match this view." : "No student activity recorded today."}</td></tr> : visible.map(student => <tr key={student.email} className={attentionStatuses.has(student.status) ? `attn row-${statusClass[student.status]}` : ""}><td><div className="student-cell"><span className="avatar" aria-hidden="true">{initials(student.name)}</span><div><button type="button" className="student-detail-link" onClick={() => setSelectedStudentEmail(student.email)} aria-label={`View activity details for ${student.name}`}>{student.name}</button><small className="email">{student.email}</small></div></div></td><td><span className="status"><i className={`status-dot ${statusClass[student.status]}`}/>{student.status}</span></td><td><div className="focus-cell"><span className="progress"><i style={{ width: `${Math.min(100, students.length && activeSession ? student.focusMs / Math.max(1, elapsedMs) * 100 : 0)}%` }}/></span><b>{Math.round(student.focusMs / 60000)} min</b></div><div className="tab-chip" aria-label={`${student.tabCount ?? "Unknown"} open browser tabs`}><PanelsTopLeft size={14}/><span>{student.tabCount ?? "—"} {student.tabCount === 1 ? "tab" : "tabs"}</span></div></td><td><b>{student.lastEvent}</b><small className="subtle">{student.lastTime}</small></td></tr>)}</tbody></table></div>
        <p className="roster-foot">{totalOpenTabs} open tab{totalOpenTabs === 1 ? "" : "s"} reported across {studentsWithTabCounts} student browser{studentsWithTabCounts === 1 ? "" : "s"}.</p>
      </section>
      <footer>Seenta <span>·</span> Class activity dashboard</footer>
    </main>
    <dialog ref={detailDialog} className="student-detail-dialog" aria-labelledby="student-detail-title" onClose={() => setSelectedStudentEmail(null)} onClick={event => { if (event.target === event.currentTarget) detailDialog.current?.close(); }}>
      {selectedStudent && activityStats && <>
        <header className="detail-dialog-header"><div className="detail-identity"><span className="avatar large" aria-hidden="true">{initials(selectedStudent.name)}</span><div><h2 id="student-detail-title">{selectedStudent.name}</h2><p className="detail-email">{selectedStudent.email}</p></div></div><button type="button" className="detail-close" onClick={() => detailDialog.current?.close()} aria-label="Close student details"><X size={19}/></button></header>
        <div className="detail-body">
          <p className="detail-current-status"><span className={`status-dot ${statusClass[selectedStudent.status]}`}/>{selectedStudent.status} in this session</p>
          <section className="detail-section"><h3>Time in Meet</h3>
            <div className="breakdown" role="img" aria-label={`Focused ${formatDuration(activityStats.focusedMs)}, away ${formatDuration(activityStats.awayMs)}, idle ${formatDuration(activityStats.idleMs)}`}><i className="active" style={{ flexGrow: Math.max(breakdownShare(activityStats.focusedMs), 0) }}/><i className="away" style={{ flexGrow: Math.max(breakdownShare(activityStats.awayMs), 0) }}/><i className="idle" style={{ flexGrow: Math.max(breakdownShare(activityStats.idleMs), 0) }}/></div>
            <ul className="breakdown-legend"><li><span className="status-dot active"/>Focused <strong>{formatDuration(activityStats.focusedMs)}</strong></li><li><span className="status-dot away"/>Away <strong>{formatDuration(activityStats.awayMs)}</strong></li><li><span className="status-dot idle"/>Idle or locked <strong>{formatDuration(activityStats.idleMs)}</strong></li></ul>
          </section>
          <div className="detail-stat-grid">
            <article><span>Tab switches</span><strong>{activityStats.switches}</strong></article>
            <article><span>Estimated focused</span><strong>{formatDuration(activityStats.focusedMs)}</strong></article>
            <article><span>Focus share</span><strong>{activityStats.focusPercent}%</strong></article>
            <article><span>Time in Meet</span><strong>{formatDuration(activityStats.meetingMs)}</strong></article>
            <article><span>Away from Meet</span><strong>{formatDuration(activityStats.awayMs)}</strong></article>
            <article><span>Idle or locked</span><strong>{formatDuration(activityStats.idleMs)}</strong></article>
          </div>
          <p className="detail-disclaimer">These are activity estimates based on Meet tab visibility and device idle signals; they do not measure attention.</p>
          <section className="detail-section"><h3>Activity counts</h3><ul className="detail-count-list">{(["JOINED", "RETURNED", "AWAY", "IDLE", "LOCKED", "ACTIVE", "LEFT", "TABS_UPDATED"] as EventType[]).map(type => <li key={type}><span>{labelEvent(type)}</span><strong>{activityStats.counts.get(type) ?? 0}</strong></li>)}</ul></section>
          <section className="detail-section"><h3>Recent activity <span>({selectedEvents.length}{events.filter(event => event.email === selectedStudent.email).length > 100 ? " most recent" : ""})</span></h3>{selectedEvents.length ? <ol className="detail-timeline">{selectedEvents.slice(0, 100).map((event, index) => <li key={`${event.type}-${event.time}-${index}`}><time>{formatEventTime(event.time)}</time><span>{labelEvent(event.type)}{event.type === "TABS_UPDATED" && Number.isInteger(event.tabCount) ? ` · ${event.tabCount} open tabs` : ""}</span></li>)}</ol> : <p className="detail-empty">No activity recorded for this student.</p>}</section>
        </div>
      </>}
    </dialog>
  </div>;
}
