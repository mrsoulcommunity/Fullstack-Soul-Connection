// "Restore Previous Session" persistence -- UI-only state (active tab,
// server-list search/sort/collapsed groups), unrelated to connection state.
// Follows the same localStorage convention as src/finder/testEngine.js and
// src/components/ServerFinder.jsx (module-level key, try/catch wrapped).
const KEY = 'soul.session.v1';

export function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || null;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch { /* quota/private mode -- session just won't survive a restart */ }
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY);
  } catch { /* ignore */ }
}
