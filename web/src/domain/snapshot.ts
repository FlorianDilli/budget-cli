import type { Cents } from './money';

export const SNAPSHOT_VERSION = 1;

/** One imported transaction. `hash` is the duplicate key (see import.ts). */
export interface Tx {
  hash: string;
  date: string;
  description: string;
  cents: Cents;
  account: string;
}

/** The decrypted local/backup payload. TOML texts are stored raw (Decision 16). */
export interface Snapshot {
  version: number;
  savedAt: string;
  settingsToml: string;
  financialsToml: string;
  transactions: Tx[];
}

export function emptySnapshot(savedAt: string): Snapshot {
  return { version: SNAPSHOT_VERSION, savedAt, settingsToml: '', financialsToml: '', transactions: [] };
}

export class SnapshotError extends Error {}

/** Validates a decrypted payload. Refuses unknown newer versions (Decision 11). */
export function parseSnapshot(json: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new SnapshotError('Data is not valid');
  }
  const s = raw as Partial<Snapshot>;
  if (!s || typeof s !== 'object') throw new SnapshotError('Data is not valid');
  if (typeof s.version !== 'number') throw new SnapshotError('Missing schema version');
  if (s.version > SNAPSHOT_VERSION) {
    throw new SnapshotError(`Unsupported data version ${s.version}; update the app`);
  }
  if (typeof s.settingsToml !== 'string' || typeof s.financialsToml !== 'string') {
    throw new SnapshotError('Missing TOML content');
  }
  if (!Array.isArray(s.transactions)) throw new SnapshotError('Missing transactions');
  for (const t of s.transactions) {
    if (
      !t || typeof t.hash !== 'string' || typeof t.date !== 'string' || typeof t.description !== 'string' ||
      typeof t.cents !== 'number' || !Number.isSafeInteger(t.cents) || typeof t.account !== 'string'
    ) {
      throw new SnapshotError('Invalid transaction record');
    }
  }
  return {
    version: s.version,
    savedAt: typeof s.savedAt === 'string' ? s.savedAt : '',
    settingsToml: s.settingsToml,
    financialsToml: s.financialsToml,
    transactions: s.transactions,
  };
}
