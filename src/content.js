function sendEvent(type) {
  try {
    chrome.runtime.sendMessage({
      eventId: crypto.randomUUID(),
      type,
      time: Date.now(),
      meetingCode: location.pathname.slice(1)
    });
  } catch {}
}

// Visibility reflects whether this Meet tab is hidden. Window focus alone can
// change during screen sharing or when the student uses another monitor.
let away = document.visibilityState === "hidden";

function checkVisibility() {
  const nowAway = document.visibilityState === "hidden";
  if (nowAway !== away) {
    away = nowAway;
    sendEvent(away ? "AWAY" : "RETURNED");
  }
}

document.addEventListener("visibilitychange", checkVisibility);
window.addEventListener("pagehide", () => sendEvent("LEFT"));
sendEvent("JOINED");
