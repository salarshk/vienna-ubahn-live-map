// IndexedDB-backed browser archive.
//
// localStorage is useful as a synchronous startup cache, but its small quota
// is not suitable for a growing event history. These helpers keep the full
// browser-local archive in IndexedDB and deliberately resolve to null when a
// browser, private context, or embedded WebView does not provide it.
const DB_NAME = 'vienna_rail_archive_v1';
const STORE_NAME = 'archives';
let dbPromise;

const supported = () => typeof indexedDB !== 'undefined';

const openDb = () => {
  if (!supported()) return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
};

const requestValue = (request) => new Promise((resolve) => {
  request.onsuccess = () => resolve(request.result ?? null);
  request.onerror = () => resolve(null);
});

export const readBrowserArchive = async (key) => {
  const db = await openDb();
  if (!db) return null;
  try {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const record = await requestValue(transaction.objectStore(STORE_NAME).get(key));
    return record?.value ?? null;
  } catch {
    return null;
  }
};

export const persistBrowserArchive = async (key, value) => {
  const db = await openDb();
  if (!db) return false;
  try {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put({ key, value, updatedAt: Date.now() });
    await new Promise((resolve) => {
      transaction.oncomplete = resolve;
      transaction.onerror = resolve;
      transaction.onabort = resolve;
    });
    return transaction.error == null;
  } catch {
    return false;
  }
};

export const deleteBrowserArchive = async (key) => {
  const db = await openDb();
  if (!db) return false;
  try {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(key);
    await new Promise((resolve) => {
      transaction.oncomplete = resolve;
      transaction.onerror = resolve;
      transaction.onabort = resolve;
    });
    return transaction.error == null;
  } catch {
    return false;
  }
};
