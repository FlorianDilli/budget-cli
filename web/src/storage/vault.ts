// One encrypted snapshot in IndexedDB (Decision 5). A single put is atomic.

const DB_NAME = 'moonli-budget';
const STORE = 'kv';
const KEY = 'vault';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('Storage write failed'));
      tx.onabort = () => reject(tx.error ?? new Error('Storage write aborted'));
    });
  } finally {
    db.close();
  }
}

export async function readVault(): Promise<string | null> {
  const v = await withStore<string | undefined>('readonly', (s) => s.get(KEY));
  return v ?? null;
}

export async function writeVault(envelopeText: string): Promise<void> {
  await withStore('readwrite', (s) => s.put(envelopeText, KEY));
}

export async function deleteVault(): Promise<void> {
  await withStore('readwrite', (s) => s.delete(KEY));
}
