/** ブラウザ内（IndexedDB）への保存 */
export interface SavedMapInfo {
  id: string;
  title: string;
  updatedAt: number;
  /** 小さなプレビュー画像（data URL） */
  thumb: string;
}

export interface SavedMap extends SavedMapInfo {
  data: Uint8Array;
}

const DB_NAME = 'fantasy-atlas';
const STORE = 'maps';
export const AUTOSAVE_ID = 'autosave';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

export async function saveMap(map: SavedMap): Promise<void> {
  await tx('readwrite', (s) => s.put(map));
}

export async function loadMap(id: string): Promise<SavedMap | undefined> {
  return tx('readonly', (s) => s.get(id) as IDBRequest<SavedMap | undefined>);
}

export async function deleteMap(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}

export async function listMaps(): Promise<SavedMapInfo[]> {
  const all = await tx('readonly', (s) => s.getAll() as IDBRequest<SavedMap[]>);
  return all
    .map(({ id, title, updatedAt, thumb }) => ({ id, title, updatedAt, thumb }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function newMapId(): string {
  return 'map-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}
