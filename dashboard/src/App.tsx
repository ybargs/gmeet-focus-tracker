import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { Activity, Eye, History, LogIn, LogOut, Moon, Pause, Play, Search, SlidersHorizontal, Square, Sun, Users, UserRoundX } from "lucide-react";
import { auth, db, googleProvider } from "./firebase";
import seentaLogo from "../assets/seenta-logo.png";

type EventType = "JOINED" | "RETURNED" | "AWAY" | "LEFT" | "IDLE" | "LOCKED" | "ACTIVE";
type TrackerEvent = { email?: string; student?: string; type: EventType; time: number; meetingCode?: string };
type Status = "Active" | "Idle" | "Away" | "Left";
type Student = { name: string; email: string; status: Status; focusMs: number; switches: number; lastEvent: string; lastTime: string };

const statusClass: Record<Status, string> = { Active: "active", Idle: "idle", Away: "away", Left: "left" };
const labelEvent = (type: EventType) => ({ JOINED: "Joined the Google Meet", RETURNED: "Returned to Google Meet", AWAY: "Switched tab", LEFT: "Left the meeting", IDLE: "No activity", LOCKED: "Screen locked", ACTIVE: "Active again" })[type] ?? type;
const formatClock = (seconds: number) => [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map(n => String(n).padStart(2, "0")).join(":");
type SessionTimerState = { elapsedSeconds: number; startedAt: number | null };
const loadSessionTimer = (): SessionTimerState => {
  try {
    const saved = localStorage.getItem("kinetic-session-timer");
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<SessionTimerState>;
      if (typeof parsed.elapsedSeconds === "number" && Number.isFinite(parsed.elapsedSeconds) && parsed.elapsedSeconds >= 0 &&
          (parsed.startedAt === null || (typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt)))) {
        return { elapsedSeconds: parsed.elapsedSeconds, startedAt: parsed.startedAt ?? null };
      }
    }
  } catch {}
  return { elapsedSeconds: 0, startedAt: null };
};

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
    let inMeet = false, away = false, idle = false, joined = false, switches = 0, focusMs = 0, focusedSince: number | null = null, name = email;
    const settle = (time: number) => {
      const focused = inMeet && !away && !idle;
      if (focused && focusedSince === null) focusedSince = time;
      else if (!focused && focusedSince !== null) { focusMs += Math.max(0, time - focusedSince); focusedSince = null; }
    };
    for (const event of list) {
      name = event.student || name;
      switch (event.type) {
        case "JOINED": case "RETURNED": inMeet = true; away = false; joined = true; if (event.type === "JOINED") idle = false; break;
        case "AWAY": inMeet = true; away = true; switches++; joined = true; break;
        case "LEFT": inMeet = false; away = false; break;
        case "IDLE": case "LOCKED": idle = true; break;
        case "ACTIVE": idle = false; break;
      }
      settle(event.time);
    }
    if (!joined) continue;
    if (focusedSince !== null) focusMs += Math.max(0, now - focusedSince);
    const last = list[list.length - 1];
    students.push({ name, email, status: !inMeet ? "Left" : away ? "Away" : idle ? "Idle" : "Active", focusMs, switches, lastEvent: labelEvent(last.type), lastTime: new Date(last.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) });
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
  const [timerState, setTimerState] = useState<SessionTimerState>(loadSessionTimer);
  const [timerNow, setTimerNow] = useState(Date.now());
  const timerRunning = timerState.startedAt !== null;
  const elapsedSeconds = timerState.elapsedSeconds + (timerState.startedAt === null ? 0 : Math.floor((timerNow - timerState.startedAt) / 1000));
  const [dark, setDark] = useState(() => localStorage.getItem("kinetic-theme") === "dark");
  const [scrollProgress, setScrollProgress] = useState(0);
  const [navPinned, setNavPinned] = useState(false);
  const [switchersOnly, setSwitchersOnly] = useState(false);
  const [search, setSearch] = useState("");

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
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(id); }, []);
  useEffect(() => { localStorage.setItem("kinetic-session-timer", JSON.stringify(timerState)); }, [timerState]);
  useEffect(() => {
    if (timerState.startedAt === null) return;
    const refreshTimer = () => setTimerNow(Date.now());
    refreshTimer();
    const id = window.setInterval(refreshTimer, 1000);
    window.addEventListener("focus", refreshTimer);
    document.addEventListener("visibilitychange", refreshTimer);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", refreshTimer);
      document.removeEventListener("visibilitychange", refreshTimer);
    };
  }, [timerState.startedAt]);
  useEffect(() => {
    if (!user) { setEvents([]); return; }
    setLoadError("");
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const todayEvents = query(collection(db, "events"), where("time", ">=", start.getTime()), orderBy("time", "asc"));
    return onSnapshot(todayEvents, snap => setEvents(snap.docs.map(doc => doc.data() as TrackerEvent)), error => {
      console.error("Could not load live events", error);
      setLoadError(error.code === "permission-denied" ? "This Google account is not authorized to view the dashboard." : "Could not load activity. Check the Firestore index/rules and try again.");
    });
  }, [user]);

  const students = useMemo(() => toStudents(events, now), [events, now]);
  const visible = useMemo(() => students.filter(s => (!switchersOnly || s.switches >= 3) && `${s.name} ${s.email}`.toLowerCase().includes(search.trim().toLowerCase())), [students, switchersOnly, search]);
  const present = students.filter(s => s.status !== "Left").length;
  const focused = students.filter(s => s.status === "Active").length;
  const attention = students.filter(s => s.status === "Away" || s.status === "Idle").length;
  const signIn = async () => { setAuthError(""); try { await signInWithPopup(auth, googleProvider); } catch (error) { setAuthError(error instanceof Error ? error.message : "Google sign-in failed."); } };
  const toggleTimer = () => setTimerState(current => current.startedAt === null
    ? { ...current, startedAt: Date.now() }
    : { elapsedSeconds: current.elapsedSeconds + Math.floor((Date.now() - current.startedAt) / 1000), startedAt: null });
  const stopTimer = () => setTimerState({ elapsedSeconds: 0, startedAt: null });

  return <div className="app-shell">
    <header className={`topbar ${navPinned ? "scrolled" : ""}`}>
      <div className="brand"><img className="brand-logo" src={seentaLogo} alt="SEENTA" /><span className="brand-divider" /><span className="brand-caption">Class Monitor</span></div>
      <nav className="top-actions"><a className="history-link" href="#activity"><History size={15}/> Session activity</a><button className="text-button" onClick={() => user ? signOut(auth) : void signIn()}>{user ? <LogOut size={16}/> : <LogIn size={16}/>} {user ? "Sign out" : "Sign in"}</button><button className="icon-button" onClick={() => setDark(v => !v)} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>{dark ? <Sun size={18}/> : <Moon size={18}/>}</button></nav>
    </header>
    <main id="top" className="page"><section className="session-head session-banner" style={{ opacity: 1 - scrollProgress, transform: `translate3d(0, ${-scrollProgress * 18}px, 0) scale(${1 - scrollProgress * 0.035})`, filter: `blur(${scrollProgress * 2}px)` }}>
        <div><div className="live-label"><i/> LIVE CLASS <span>/</span> BSIT 3-5</div><h1>INTE 301: Systems Integration and Application</h1><p className="session-meta">9:00 AM – 11:30 AM <span>·</span> Google Meet <b>imi-ssy-ouo</b></p></div>
      </section>
      <section className="session-controls-panel" aria-label="Session timer">
        <div className="session-controls-copy"><small>SESSION CONTROLS</small><strong>Session elapsed</strong><span>Track time for the current class.</span></div>
        <div className="timer"><div><small>ELAPSED TIME</small><strong>{formatClock(elapsedSeconds)}</strong></div><div className="timer-controls"><button onClick={toggleTimer} aria-label={timerRunning ? "Pause timer" : "Start timer"} title={timerRunning ? "Pause" : "Start"}>{timerRunning ? <Pause size={15}/> : <Play size={15}/>}</button><button onClick={stopTimer} aria-label="Stop timer" title="Stop"><Square size={14}/></button></div></div>
      </section>
      <section className="metrics"><Metric icon={Users} label="Attendance" value={`${present}/${students.length}`} note="Students checked in"/><Metric icon={Eye} label="Focused now" value={focused} note={students.length ? `${Math.round(focused / students.length * 100)}% of students` : "Waiting for activity"} tone="green"/><Metric icon={UserRoundX} label="Needs attention" value={attention} note="Idle or away students" tone="gold"/></section>
      <section id="activity" className="activity-layout"><aside className="sidebar"><div className="panel legend"><h2>Status key</h2>{(["Active", "Idle", "Away", "Left"] as Status[]).map(status => <div className="legend-row" key={status}><span className={`status-dot ${statusClass[status]}`}/>{status}<span className="legend-count">{students.filter(s => s.status === status).length}</span></div>)}</div><button className={`filter-button ${switchersOnly ? "selected" : ""}`} onClick={() => setSwitchersOnly(v => !v)} aria-pressed={switchersOnly}><SlidersHorizontal size={16}/>{switchersOnly ? "Show everyone" : "Show switchers"}</button><div className="attention-note"><b>Attention</b><p>{students.filter(s => s.switches >= 3).length} students switched tabs three or more times.</p></div></aside>
        <section className="roster"><div className="roster-heading"><div><h2>Student activity</h2><p>Live focus signals from today’s session</p></div><label className="search"><Search size={16}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search students" aria-label="Search students"/></label></div>
          {authError && <div className="notice error">{authError}</div>}{loadError && <div className="notice error">{loadError}</div>}
          <div className="table-wrap"><table><thead><tr><th>Student</th><th>Status</th><th>Focus duration</th><th>Last event</th></tr></thead><tbody>{!user ? <tr><td colSpan={4} className="empty">Sign in with your teacher Google account to view live activity.</td></tr> : visible.length === 0 ? <tr><td colSpan={4} className="empty">{events.length ? "No students match this view." : "No student activity recorded today."}</td></tr> : visible.map(student => <tr key={student.email}><td><b>{student.name}</b><small className="email">{student.email}</small></td><td><span className="status"><i className={`status-dot ${statusClass[student.status]}`}/>{student.status}</span></td><td><div className="focus-cell"><span className="progress"><i style={{ width: `${Math.min(100, students.length ? student.focusMs / Math.max(1, now - new Date().setHours(0,0,0,0)) * 100 : 0)}%` }}/></span><b>{Math.round(student.focusMs / 60000)} min</b></div><small className="subtle">{student.switches} tab switch{student.switches === 1 ? "" : "es"}</small></td><td><b>{student.lastEvent}</b><small className="subtle">{student.lastTime}</small></td></tr>)}</tbody></table></div>
        </section>
      </section><footer><Activity size={14}/> PUP iSEENTA <span>·</span> Class activity dashboard</footer>
    </main>
  </div>;
}
