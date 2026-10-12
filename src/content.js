function sendEvent(type) {
  try {
    chrome.runtime.sendMessage({
      type,
      time: Date.now(),
      meetingCode: location.pathname.slice(1)
    });
  } catch (e) {
  }
}

let away = document.hidden || !document.hasFocus();

function check() {
  const nowAway = document.hidden || !document.hasFocus();
  if (nowAway !== away) {
    away = nowAway;
    sendEvent(away ? "AWAY" : "RETURNED");
  }
}

window.addEventListener("blur", check);
window.addEventListener("focus", check);
document.addEventListener("visibilitychange", check);
window.addEventListener("pagehide", () => sendEvent("LEFT"));

sendEvent("JOINED");