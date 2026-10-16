import { GoogleAuthProvider, signInWithCredential, signOut } from "firebase/auth/web-extension";
import { auth, GOOGLE_WEB_CLIENT_ID } from "./firebase";

// chrome.identity.getAuthToken only works in real Chrome. navigator.brave isn't exposed
// to service workers, so prefer UA brands: Chrome always lists a "Google Chrome" brand
// while Edge, Brave and other Chromium browsers don't.
const brands = navigator.userAgentData?.brands?.map(b => b.brand) ?? null;
const isRealChrome = brands ? brands.includes("Google Chrome") : !(typeof navigator !== "undefined" && navigator.brave);

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out")), ms))
  ]);
}

// chrome.identity.getAuthToken uses the Google account signed into Chrome.
// Only Google Chrome supports it; Brave, Edge and other Chromium browsers don't.
async function tokenFromChromeIdentity(interactive) {
  if (!isRealChrome || !chrome.identity?.getAuthToken) return null;
  try {
    const request = chrome.identity.getAuthToken({ interactive });
    // Interactive Google account prompts can remain open while the user picks
    // an account. Timing out here would start the web fallback while Chrome's
    // own auth request is still active, which can wedge the sign-in flow.
    const result = interactive ? await request : await withTimeout(request, 5000);
    return result?.token || null;
  } catch (e) {
    console.warn("[Meet Focus Tracker] getAuthToken failed, trying web auth flow:", e?.message || e);
    return null;
  }
}

// Works in any Chromium browser. Needs a "Web application" OAuth client whose
// redirect URI is chrome.identity.getRedirectURL() (see SETUP-GUIDE.md).
async function tokenFromWebAuthFlow(interactive) {
  if (!GOOGLE_WEB_CLIENT_ID) {
    if (!interactive) return null;
    throw new Error("Account selection needs GOOGLE_WEB_CLIENT_ID in src/firebase.js. Follow the web OAuth client steps in SETUP-GUIDE.md.");
  }

  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: GOOGLE_WEB_CLIENT_ID,
    response_type: "token",
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: "openid email profile",
    state
  });
  if (interactive) params.set("prompt", "select_account");

  try {
    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      interactive
    });
    const result = new URLSearchParams(new URL(responseUrl).hash.slice(1));
    if (result.get("error")) throw new Error(`Google sign-in failed: ${result.get("error")}`);
    if (result.get("state") !== state) throw new Error("Google sign-in failed: state mismatch.");
    return result.get("access_token");
  } catch (e) {
    if (!interactive) return null;
    throw e;
  }
}

// Signs into Firebase with a Google access token. Throws if interactive sign-in fails;
// returns null if a silent (non-interactive) sign-in isn't possible.
export async function signInWithGoogle({ interactive, forceAccountSelection = false }) {
  // An interactive sign-in can take longer than the service worker's ~30 s idle
  // lifetime; if it dies mid-flow the popup's sendMessage just fails. Periodic API
  // calls keep the worker alive until the flow resolves.
  let keepAlive = null;
  if (interactive) {
    keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 15000);
  }
  try {
    const token = forceAccountSelection
      ? await tokenFromWebAuthFlow(interactive)
      : (await tokenFromChromeIdentity(interactive)) || (await tokenFromWebAuthFlow(interactive));
    if (!token) {
      if (interactive) throw new Error("Google sign-in was cancelled.");
      return null;
    }
    const { user } = await signInWithCredential(auth, GoogleAuthProvider.credential(null, token));
    return user;
  } finally {
    if (keepAlive) clearInterval(keepAlive);
  }
}

export async function signOutGoogle() {
  await signOut(auth);
  try {
    await chrome.identity.clearAllCachedAuthTokens?.();
  } catch {
    // Not supported outside Chrome; nothing cached there anyway
  }
}
