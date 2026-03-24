import { Measurement } from './types';

const DB_NAME = 'geocompass-offline';
const DB_VERSION = 1;
const STORE_NAME = 'app-state';
const BACKUP_KEY = 'geocompass_backup_v2';
const LEGACY_MEASUREMENTS_KEY = 'geocompass_measurements';
const LEGACY_PROJECTS_KEY = 'geocompass_projects';

interface KeyValueRecord<T> {
  key: string;
  value: T;
}

export interface PersistedState {
  measurements: Measurement[];
  projects: string[];
  backupTimestamp: number | null;
  restoredFromBackup: boolean;
  storageMode: 'indexeddb' | 'backup' | 'legacy' | 'empty';
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function readRecord<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve((request.result as KeyValueRecord<T> | undefined)?.value);
  });
}

function writeRecord<T>(db: IDBDatabase, key: string, value: T): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ key, value } satisfies KeyValueRecord<T>);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function safeReadBackup() {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    return raw ? (JSON.parse(raw) as { savedAt: number; measurements: Measurement[]; projects: string[] }) : null;
  } catch {
    return null;
  }
}

function safeWriteBackup(measurements: Measurement[], projects: string[]) {
  try {
    localStorage.setItem(
      BACKUP_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        measurements,
        projects,
      }),
    );
  } catch {
    // Keep backup best-effort only.
  }
}

function readLegacyState() {
  try {
    const measurements = JSON.parse(localStorage.getItem(LEGACY_MEASUREMENTS_KEY) || '[]') as Measurement[];
    const projects = JSON.parse(localStorage.getItem(LEGACY_PROJECTS_KEY) || '["Default Project"]') as string[];
    return { measurements, projects };
  } catch {
    return { measurements: [] as Measurement[], projects: ['Default Project'] };
  }
}

export async function loadPersistedState(defaultProjects: string[]) {
  const backup = safeReadBackup();

  try {
    const db = await openDatabase();
    const measurements = (await readRecord<Measurement[]>(db, 'measurements')) || [];
    const projects = (await readRecord<string[]>(db, 'projects')) || [];

    if (measurements.length || projects.length) {
      return {
        measurements,
        projects: projects.length ? projects : defaultProjects,
        backupTimestamp: backup?.savedAt ?? null,
        restoredFromBackup: false,
        storageMode: 'indexeddb',
      } satisfies PersistedState;
    }

    if (backup) {
      await writeRecord(db, 'measurements', backup.measurements);
      await writeRecord(db, 'projects', backup.projects.length ? backup.projects : defaultProjects);
      return {
        measurements: backup.measurements,
        projects: backup.projects.length ? backup.projects : defaultProjects,
        backupTimestamp: backup.savedAt,
        restoredFromBackup: true,
        storageMode: 'backup',
      } satisfies PersistedState;
    }

    const legacy = readLegacyState();
    if (legacy.measurements.length || legacy.projects.length) {
      await writeRecord(db, 'measurements', legacy.measurements);
      await writeRecord(db, 'projects', legacy.projects.length ? legacy.projects : defaultProjects);
      safeWriteBackup(legacy.measurements, legacy.projects.length ? legacy.projects : defaultProjects);
      return {
        measurements: legacy.measurements,
        projects: legacy.projects.length ? legacy.projects : defaultProjects,
        backupTimestamp: null,
        restoredFromBackup: false,
        storageMode: 'legacy',
      } satisfies PersistedState;
    }

    return {
      measurements: [],
      projects: defaultProjects,
      backupTimestamp: backup?.savedAt ?? null,
      restoredFromBackup: false,
      storageMode: 'empty',
    } satisfies PersistedState;
  } catch {
    if (backup) {
      return {
        measurements: backup.measurements,
        projects: backup.projects.length ? backup.projects : defaultProjects,
        backupTimestamp: backup.savedAt,
        restoredFromBackup: true,
        storageMode: 'backup',
      } satisfies PersistedState;
    }

    const legacy = readLegacyState();
    return {
      measurements: legacy.measurements,
      projects: legacy.projects.length ? legacy.projects : defaultProjects,
      backupTimestamp: null,
      restoredFromBackup: false,
      storageMode: legacy.measurements.length || legacy.projects.length ? 'legacy' : 'empty',
    } satisfies PersistedState;
  }
}

export async function persistState(measurements: Measurement[], projects: string[]) {
  safeWriteBackup(measurements, projects);

  try {
    const db = await openDatabase();
    await writeRecord(db, 'measurements', measurements);
    await writeRecord(db, 'projects', projects);
    return true;
  } catch {
    return false;
  }
}
