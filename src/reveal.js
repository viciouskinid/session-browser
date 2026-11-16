'use strict';
// Viewing a saved password. The password is shown only after the operating system has just verified the person (a fresh check
// every time, not the "unlocked for a while" window that filling uses), and only to the app's own panel, for a few seconds.
// Pure: the system checks are passed in, so every case can be tested without Windows or a window.
//   Windows -> Windows Hello (PIN, fingerprint, face, or the account password as Windows' own fallback)
//   macOS   -> Touch ID
//   others  -> refused: there is no system check to ask, and a click on a dialog inside the app would not prove who is there.
// If the check cannot run, the answer is NO (it fails closed).
const SHOW_SECONDS = 15;
const WINDOW_MS = 60 * 1000, MAX_PER_WINDOW = 6;   // a script that somehow reached this call could not harvest the vault quickly

function limiter(now = Date.now) {
  let stamps = [];
  return () => { const t = now(); stamps = stamps.filter(x => t - x < WINDOW_MS); if (stamps.length >= MAX_PER_WINDOW) return false; stamps.push(t); return true; };
}

// deps: { platform, helloVerify(message) -> {ok,status}, helloDescribe(status), touchId(message) -> Promise (rejects when refused), canTouchId() }
async function authorize(deps, message = 'Show a saved password') {
  const platform = deps.platform;
  if (platform === 'win32') {
    const r = await deps.helloVerify(message);
    return r && r.ok ? { ok: true, method: 'hello' } : { ok: false, error: deps.helloDescribe(r && r.status) };
  }
  if (platform === 'darwin') {
    if (!deps.canTouchId()) return { ok: false, error: 'Touch ID is not available on this Mac, so saved passwords cannot be shown.' };
    try { await deps.touchId(message); return { ok: true, method: 'touchid' }; } catch { return { ok: false, error: 'Touch ID did not verify you.' }; }
  }
  return { ok: false, error: 'Showing a saved password needs Windows Hello or Touch ID, and this computer has neither.' };
}

module.exports = { authorize, limiter, SHOW_SECONDS, MAX_PER_WINDOW, WINDOW_MS };
