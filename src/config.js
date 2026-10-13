// Google accounts allowed to open the professor dashboard.
// This is only a UI gate: keep it in sync with isProfessor() in firestore.rules,
// which is what actually stops other accounts from reading events.
export const PROFESSOR_EMAILS = [
  "draconic788@gmail.com",
  "renzkerbysajuelaofficial@gmail.com",
  "ajosejustingabriel@gmail.com"
];

export function isProfessorEmail(email) {
  return !!email && PROFESSOR_EMAILS.includes(email.toLowerCase());
}

// Google Meet room codes look like abc-defg-hij
export const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

// Returns the room code for a meet.google.com room URL, or null for the home page, lobby links, etc.
export function meetCodeFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== "meet.google.com") return null;
    const code = u.pathname.slice(1).replace(/\/+$/, "").toLowerCase();
    return MEET_CODE_RE.test(code) ? code : null;
  } catch {
    return null;
  }
}
