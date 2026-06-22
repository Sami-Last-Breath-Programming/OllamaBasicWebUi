const KEY = 'claude_chat_sessions';
const DB_NAME = 'claude_images';
const DB_STORE = 'images';
let _db = null;

// ── IndexedDB setup ──
function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(DB_STORE, { keyPath: 'key' });
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

export async function saveImage(key, data) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put({ key, data });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { console.warn('ImageDB save error:', e); }
}

export async function loadImage(key) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result?.data || '');
      req.onerror = () => resolve('');
    });
  } catch { return ''; }
}

export async function deleteImages(keys) {
  try {
    const db = await openDB();
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore(DB_STORE);
    keys.forEach(k => store.delete(k));
  } catch (e) { console.warn('ImageDB delete error:', e); }
}

// ── localStorage for sessions (no image data) ──
function stripImagesForStorage(sessions) {
  const stripped = {};
  for (const [sid, session] of Object.entries(sessions)) {
    stripped[sid] = {
      ...session,
      messages: (session.messages || []).map(msg => ({
        ...msg,
        files: (msg.files || []).map(f =>
          f.type === 'image'
            ? { name: f.name, type: 'image', mimeType: f.mimeType, data: '', dbKey: f.dbKey || '' }
            : f
        )
      }))
    };
  }
  return stripped;
}

export function saveSessions(sessions) {
  try {
    localStorage.setItem(KEY, JSON.stringify(stripImagesForStorage(sessions)));
  } catch (e) {
    // Storage quota exceeded — prune oldest sessions until it fits
    console.warn('Storage full, pruning oldest sessions...');
    const ids = Object.keys(sessions).sort((a, b) => a - b); // oldest first
    while (ids.length > 1) {
      const oldest = ids.shift();
      delete sessions[oldest];
      try {
        localStorage.setItem(KEY, JSON.stringify(stripImagesForStorage(sessions)));
        return; // success
      } catch {}
    }
    console.error('Could not save sessions even after pruning.');
  }
}

export function loadSessions() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

export function deleteSession(id, sessions) {
  // Collect image keys to delete from IndexedDB
  const session = sessions[id];
  if (session) {
    const keys = [];
    for (const msg of session.messages || []) {
      for (const f of msg.files || []) {
        if (f.type === 'image' && f.dbKey) keys.push(f.dbKey);
      }
    }
    if (keys.length) deleteImages(keys);
  }
  delete sessions[id];
  saveSessions(sessions);
}

// ── Restore image data from IndexedDB into sessions ──
export async function restoreImageData(sessions) {
  for (const session of Object.values(sessions)) {
    for (const msg of session.messages || []) {
      for (const f of msg.files || []) {
        if (f.type === 'image' && f.dbKey) {
          f.data = await loadImage(f.dbKey);
        }
      }
    }
  }
  return sessions;
}