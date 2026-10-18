// Persistence. Two very different stores on purpose:
//   localStorage  — small, synchronous, survives reload. Trial metrics live here.
//   IndexedDB     — large, async. Only audio recordings, and only when opted in.
//
// Nothing ever leaves the browser. There is no save endpoint to configure.

const PREFIX = "saycheck:v1:";
const DB_NAME = "saycheck";
const DB_VERSION = 1;
const STORE_BLOBS = "blobs";

function keyFor(suiteId) {
  return PREFIX + suiteId;
}

export function loadState(suiteId) {
  try {
    const raw = localStorage.getItem(keyFor(suiteId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Persist state. Returns false when the quota is exhausted, which is a signal
 * to the UI to prompt for an export rather than silently losing data.
 */
export function saveState(suiteId, state) {
  try {
    localStorage.setItem(keyFor(suiteId), JSON.stringify(state));
    return true;
  } catch (err) {
    console.warn("saveState failed", err);
    return false;
  }
}

export function clearState(suiteId) {
  localStorage.removeItem(keyFor(suiteId));
}

export function listSessions() {
  const out = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(PREFIX)) continue;
    try {
      const state = JSON.parse(localStorage.getItem(key));
      out.push({
        suiteId: key.slice(PREFIX.length),
        sessionId: state.sessionId,
        startedAt: state.startedAt,
        trials: (state.trials || []).length,
        title: state.suiteTitle || state.suiteId,
      });
    } catch {
      /* ignore corrupt entries */
    }
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

/** Rough usage in KB, shown in the UI so people understand localStorage is finite. */
export function usageKb() {
  let bytes = 0;
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(PREFIX)) continue;
    bytes += (key.length + (localStorage.getItem(key) || "").length) * 2;
  }
  return Math.round(bytes / 1024);
}

// ------------------------------------------------------------------ recordings

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode) {
  return openDb().then((db) => db.transaction(STORE_BLOBS, mode).objectStore(STORE_BLOBS));
}

export async function putRecording(key, blob) {
  try {
    const store = await tx("readwrite");
    await new Promise((resolve, reject) => {
      const req = store.put(blob, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    return true;
  } catch (err) {
    console.warn("putRecording failed", err);
    return false;
  }
}

export async function getRecording(key) {
  try {
    const store = await tx("readonly");
    return await new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function deleteRecording(key) {
  try {
    const store = await tx("readwrite");
    await new Promise((resolve, reject) => {
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    /* best effort */
  }
}

export async function listRecordingKeys() {
  try {
    const store = await tx("readonly");
    return await new Promise((resolve, reject) => {
      const req = store.getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

/** Ask the browser to keep our data instead of evicting it under pressure. */
export async function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------- export

export function downloadJson(filename, data) {
  downloadBlob(
    filename,
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  );
}

export function downloadCsv(filename, csvText) {
  downloadBlob(filename, new Blob([csvText], { type: "text/csv;charset=utf-8" }));
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function timestampSlug(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}
