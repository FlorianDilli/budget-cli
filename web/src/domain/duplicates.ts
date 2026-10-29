import type { Cents } from './money';
import type { NormalizedRow } from './csv';
import type { Tx } from './snapshot';

/** Python's repr(float(...)) for a cent amount, so hashes match the CLI's. */
export function pyFloatRepr(cents: Cents): string {
  const x = cents / 100;
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of "date-description-amount-occurrence" (crypto.py:127-132). */
export function transactionHash(date: string, description: string, cents: Cents, occurrence: number): Promise<string> {
  return sha256Hex(`${date}-${description}-${pyFloatRepr(cents)}-${occurrence}`);
}

export interface Classified {
  fresh: Tx[];
  duplicates: number;
}

/**
 * Occurrence is counted per file for identical (date, description, amount), so
 * identical lines in one file are both kept, and re-importing the same file adds
 * nothing (Decision 10).
 */
export async function classifyRows(rows: NormalizedRow[], accountName: string, existing: Set<string>): Promise<Classified> {
  const counts = new Map<string, number>();
  const fresh: Tx[] = [];
  let duplicates = 0;
  for (const row of rows) {
    const key = `${row.date}\u0000${row.description}\u0000${row.cents}`;
    const occurrence = counts.get(key) ?? 0;
    counts.set(key, occurrence + 1);
    const hash = await transactionHash(row.date, row.description, row.cents, occurrence);
    if (existing.has(hash)) {
      duplicates++;
      continue;
    }
    existing.add(hash);
    fresh.push({ hash, date: row.date, description: row.description, cents: row.cents, account: accountName });
  }
  return { fresh, duplicates };
}
