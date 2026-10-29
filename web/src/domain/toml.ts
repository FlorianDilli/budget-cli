import { parse } from 'smol-toml';

export type TomlResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; line: number; col: number; message: string };

/** Parses TOML 1.0 text. Errors carry the 1-based line and column. */
export function parseToml(text: string): TomlResult {
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: parse(text) as Record<string, unknown> };
  } catch (err) {
    const e = err as { line?: number; column?: number; col?: number; message?: string };
    const message = (e.message ?? 'Invalid TOML').split('\n')[0];
    return {
      ok: false,
      line: e.line ?? 1,
      col: e.column ?? e.col ?? 1,
      message,
    };
  }
}

/** 1-based line numbers of every table header `[name]` or `[[name]]`, in order. */
export function findTableLines(text: string, name: string): number[] {
  const lines = text.split('\n');
  const re = new RegExp(`^\\s*\\[\\[?\\s*${name.replace(/\./g, '\\.')}\\s*\\]\\]?\\s*(#.*)?$`);
  const out: number[] = [];
  lines.forEach((l, i) => {
    if (re.test(l)) out.push(i + 1);
  });
  return out;
}
