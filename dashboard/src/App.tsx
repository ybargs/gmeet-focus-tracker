import { useEffect, useMemo, useState } from "react";
import { addDoc, collection, doc, onSnapshot, query, serverTimestamp, updateDoc, where } from "firebase/firestore";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { Check, Copy, Eye, ExternalLink, History, LogIn, LogOut, Moon, Pause, Play, Search, SlidersHorizontal, Square, Sun, Users, UserRoundX } from "lucide-react";
import { auth, db, googleProvider } from "./firebase";
import wordmarkLight from "../assets/seenta-wordmark-light.png";
import wordmarkDark from "../assets/seenta-wordmark-dark.png";

type EventType = "JOINED" | "RETURNED" | "AWAY" | "LEFT" | "IDLE" | "LOCKED" | "ACTIVE";
type TrackerEvent = { email?: string; student?: string; type: EventType; time: number; meetingCode?: string; sessionId?: string };
type ClassSession = { id: string; meetingCode: string; status: "active" | "paused"; startedAtMs: number; elapsedMs: number; pausedAtMs?: number };
type Status = "Active" | "Idle" | "Away" | "Left";
type Student = { name: string; email: string; status: Status; focusMs: number; lastEvent: string; lastTime: string };

const statusClass: Record<Status, string> = { Active: "active", Idle: "idle", Away: "away", Left: "left" };
const meetingCode = "hgd-rawq-yaz";
const labelEvent = (type: EventType) => ({ JOINED: "Joined the Google Meet", RETURNED: "Returned to Google Meet", AWAY: "Meet tab hidden", LEFT: "Left the meeting", IDLE: "No device input", LOCKED: "Screen locked", ACTIVE: "Active again" })[type] ?? type;
const formatClock = (seconds: number) => [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map(n => String(n).padStart(2, "0")).join(":");

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
    list.sort((a, b) => a.time - b.time);
    let inMeet = false, away = false, idle = false, joined = false, focusMs = 0, focusedSince: number | null = null, name = email;
    const settle = (time: number) => {
      const focused = inMeet && !away && !idle;
      if (focused && focusedSince === null) focusedSince = time;
      else if (!focused && focusedSince !== null) { focusMs += Math.max(0, time - focusedSince); focusedSince = null; }
    };
    for (const event of list) {
      name = event.student || name;
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
    if (focusedSince !== null) focusMs += Math.max(0, now - focusedSince);
    const last = list[list.length - 1];
    students.push({ name, email, status: !inMeet ? "Left" : away ? "Away" : idle ? "Idle" : "Active", focusMs, lastEvent: labelEvent(last.type), lastTime: new Date(last.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) });
  }
  return students.sort((a, b) => a.name.localeCompare(b.name));
}

function Metric({ icon: Icon, label, value, note, tone = "" }: { icon: typeof Users; label: string; value: string | number; note: string; tone?: string }) {
  return <article className="metric"><div><p className="eyebrow-label">{label}</p><strong>{value}</strong><small>{note}</small></div><span className={`metric-icon ${tone}`}><Icon size={19} /></span></article>;
}

export default function App() {
  const [user, setUser] = useState(auth.currentUser);
  const [events, setEvents] = useState<TrackerEvent[]>([]);
  const [loadError, setLoadError] = useState("");
  const [authError, setAuthError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [activeSession, setActiveSession] = useState<ClassSession | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const timerRunning = activeSession?.status === "active";
  const elapsedMs = activeSession ? activeSession.elapsedMs + (timerRunning ? Math.max(0, now - activeSession.startedAtMs) : 0) : 0;
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const [dark, setDark] = useState(() => localStorage.getItem("kinetic-theme") === "dark");
  const [scrollProgress, setScrollProgress] = useState(0);
  const [navPinned, setNavPinned] = useState(false);
  const [activeOnly, setActiveOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [meetingCodeCopied, setMeetingCodeCopied] = useState(false);

  useEffect(() => onAuthStateChanged(auth, setUser), []);
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); localStorage.setItem("kinetic-theme", dark ? "dark" : "light"); }, [dark]);
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      setScrollProgress(Math.min(y / 150, 1));
      setNavPinned(y > 24);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => { if (!user) { setActiveSession(null); return; }
    const activeQuery = query(collection(db, "sessions"), where("status", "in", ["active", "paused"]));
    return onSnapshot(activeQuery, snap => {
      const match = snap.docs.find(item => item.data().meetingCode === meetingCode);
      if (!match) { setActiveSession(null); return; }
      const data = match.data();
      setActiveSession({ id: match.id, meetingCode, status: data.status, startedAtMs: Number(data.startedAtMs ?? Date.now()), elapsedMs: Number(data.elapsedMs ?? 0), pausedAtMs: Number(data.pausedAtMs ?? 0) });
    }, error => { console.error("Could not load class session", error); setLoadError("Could not load the class session. Check Firestore rules."); });
  }, [user]);
  useEffect(() => {
    if (!user || !activeSession) { setEvents([]); return; }
    setLoadError("");
    const sessionEvents = query(collection(db, "events"), where("sessionId", "==", activeSession.id));
    return onSnapshot(sessionEvents, snap => setEvents(snap.docs.map(item => item.data() as TrackerEvent)), error => {
      console.error("Could not load session events", error);
      setLoadError(error.code === "permission-denied" ? "This Google account is not authorized to view this session." : "Could not load session activity. Check Firestore rules and try again.");
    });
  }, [user, activeSession?.id]);

  const students = useMemo(() => toStudents(events, activeSession?.status === "paused" ? (activeSession.pausedAtMs || now) : now), [events, now, activeSession?.status, activeSession?.pausedAtMs]);
  const visible = useMemo(() => students.filter(s => (!activeOnly || s.status === "Active") && `${s.name} ${s.email}`.toLowerCase().includes(search.trim().toLowerCase())), [students, activeOnly, search]);
  const present = students.filter(s => s.status !== "Left").length;
  const focused = students.filter(s => s.status === "Active").length;
  const attention = students.filter(s => s.status === "Away" || s.status === "Idle").length;
  const signIn = async () => { setAuthError(""); try { await signInWithPopup(auth, googleProvider); } catch (error) { setAuthError(error instanceof Error ? error.message : "Google sign-in failed."); } };
  const toggleTimer = async () => {
    if (!user) { setAuthError("Sign in with the teacher account to start a class session."); return; }
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
    try { await updateDoc(doc(db, "sessions", activeSession.id), { status: "ended", elapsedMs, endedAt: serverTimestamp() }); setActiveSession(null); }
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

  return <div className="app-shell">
    <header className={`topbar ${navPinned ? "scrolled" : ""}`}>
      <div className="brand"><img className="brand-wordmark brand-wordmark-light" src={wordmarkLight} alt="Seenta" /><img className="brand-wordmark brand-wordmark-dark" src={wordmarkDark} alt="Seenta" /><span className="brand-divider" /><span className="brand-caption">Class Activity Tracker</span></div>
      <nav className="top-actions"><a className="history-link" href="#activity"><History size={15}/> Session activity</a><button className="text-button" onClick={() => user ? signOut(auth) : void signIn()}>{user ? <LogOut size={16}/> : <LogIn size={16}/>} {user ? "Sign out" : "Sign in"}</button><button className="icon-button" onClick={() => setDark(v => !v)} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>{dark ? <Sun size={18}/> : <Moon size={18}/>}</button></nav>
    </header>
    <main id="top" className="page"><section className="session-head session-banner" style={{ opacity: 1 - scrollProgress, transform: `translate3d(0, ${-scrollProgress * 18}px, 0) scale(${1 - scrollProgress * 0.035})`, filter: `blur(${scrollProgress * 2}px)` }}>
        <div className="session-banner-copy"><div className="live-label">Online Class</div><h1>Systems Integration <br /> and Application
</h1><p className="session-meta">9:00 AM – 11:30 AM <span>·</span> BSIT 3-5</p></div>
        <aside className="meeting-card" aria-label="Google Meet and session timer">
          <div className="meeting-card-header"><div className="meeting-card-top"><span className={`meeting-live-dot ${activeSession ? "" : "session-inactive"}`} /> {activeSession ? (timerRunning ? "LIVE CLASS" : "SESSION PAUSED") : "SESSION READY"}</div><div className="meeting-card-timer"><div><small>ELAPSED</small><strong>{formatClock(elapsedSeconds)}</strong></div><div className="timer-controls"><button onClick={() => void toggleTimer()} disabled={sessionBusy} aria-label={timerRunning ? "Pause session tracking" : activeSession ? "Resume session tracking" : "Start class session"} title={timerRunning ? "Pause tracking" : activeSession ? "Resume tracking" : "Start session"}>{timerRunning ? <Pause size={17}/> : <Play size={17}/>}</button><button onClick={() => void stopTimer()} disabled={sessionBusy || !activeSession} aria-label="Stop class session" title="Stop session"><Square size={15}/></button></div></div></div>
          <div className="meeting-card-label">MEETING CODE</div><div className="meeting-code-row"><strong>{meetingCode}</strong><button className="copy-code-button" onClick={() => void copyMeetingCode()} aria-label={meetingCodeCopied ? "Meeting code copied" : "Copy meeting code"}>{meetingCodeCopied ? <Check size={18} /> : <Copy size={18} />}</button></div><a className="meeting-open-button" href={`https://meet.google.com/${meetingCode}`} target="_blank" rel="noreferrer">Open Google Meet <ExternalLink size={17}/></a></aside>
      </section>
      <section className="metrics"><Metric icon={Users} label="Attendance" value={`${present}/${students.length}`} note="Students checked in"/><Metric icon={Eye} label="Active Meet tabs" value={focused} note={students.length ? `${Math.round(focused / students.length * 100)}% of Meet tabs visible` : "Waiting for activity"} tone="green"/><Metric icon={UserRoundX} label="Needs attention" value={attention} note="Idle or away students" tone="gold"/></section>
      <section id="activity" className="activity-layout"><aside className="sidebar"><div className="panel legend"><h2>Status key</h2>{(["Active", "Idle", "Away", "Left"] as Status[]).map(status => <div className="legend-row" key={status}><span className={`status-dot ${statusClass[status]}`}/>{status}<span className="legend-count">{students.filter(s => s.status === status).length}</span></div>)}</div><button className={`filter-button ${activeOnly ? "selected" : ""}`} onClick={() => setActiveOnly(v => !v)} aria-pressed={activeOnly}><SlidersHorizontal size={16}/>{activeOnly ? "Show everyone" : "Show active tabs"}</button><div className="attention-note"><b>Active Meet tabs</b><p>{focused} participant{focused === 1 ? "" : "s"} currently have the Meet tab visible.</p></div></aside>
        <section className="roster"><div className="roster-heading"><div><h2>Student activity</h2><p>{activeSession ? "Live focus signals for this class session" : "Start the class session to begin tracking Meet focus."}</p></div><label className="search"><Search size={16}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search students" aria-label="Search students"/></label></div>
          {authError && <div className="notice error">{authError}</div>}{loadError && <div className="notice error">{loadError}</div>}
          <div className="table-wrap"><table><thead><tr><th>Student</th><th>Status</th><th>Focus duration</th><th>Last event</th></tr></thead><tbody>{!user ? <tr><td colSpan={4} className="empty">Sign in with your teacher Google account to view live activity.</td></tr> : visible.length === 0 ? <tr><td colSpan={4} className="empty">{events.length ? "No students match this view." : "No student activity recorded today."}</td></tr> : visible.map(student => <tr key={student.email}><td><b>{student.name}</b><small className="email">{student.email}</small></td><td><span className="status"><i className={`status-dot ${statusClass[student.status]}`}/>{student.status}</span></td><td><div className="focus-cell"><span className="progress"><i style={{ width: `${Math.min(100, students.length && activeSession ? student.focusMs / Math.max(1, elapsedMs) * 100 : 0)}%` }}/></span><b>{Math.round(student.focusMs / 60000)} min</b></div><small className="subtle">{student.status === "Active" ? "Meet tab visible" : student.status === "Away" ? "Meet tab hidden" : student.status === "Idle" ? "No device input" : "Not currently in Meet"}</small></td><td><b>{student.lastEvent}</b><small className="subtle">{student.lastTime}</small></td></tr>)}</tbody></table></div>
        </section>
      </section><footer> Seenta <span>·</span> Class activity dashboard</footer>
    </main>
  </div>;
}
