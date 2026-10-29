import { parse } from 'smol-toml';
import { parseTomlCompat } from './toml-compat';

export type TomlResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; line: number; col: number; message: string };

/**
 * Parses TOML text. Strict TOML 1.0 (smol-toml) is tried first; the lenient
 * reference-compatible parser is used only when smol-toml rejects the text.
 * If both reject it, the smol-toml error is reported.
 */
export function parseToml(text: string): TomlResult {
  try {
    return { ok: true, value: parse(text) as Record<string, unknown> };
  } catch (err) {
    const e = err as { line?: number; column?: number; col?: number; message?: string };
    const compat = parseTomlCompat(text);
    if (compat.ok) return compat;
    const message = (e.message ?? 'Invalid TOML').split('\n')[0];
    return {
      ok: false,
      line: e.line ?? 1,
      col: e.column ?? e.col ?? 1,
      message,
    };
  }
}

/** Parses one table header line: strict TOML first, then the compat parser. */
function parseHeaderLine(line: string): unknown {
  try {
    return parse(line);
  } catch (err) {
    const compat = parseTomlCompat(line);
    if (compat.ok) return compat.value;
    throw err;
  }
}

/** 1-based line numbers of every table header `[name]` or `[[name]]`, in order. */
export function findTableLines(text: string, name: string): number[] {
  const out: number[] = [];
  let quote: '"' | "'" | '"""' | "'''" | null = null;
  let depth = 0;
  text.split('\n').forEach((line, i) => {
    if (!quote && depth === 0 && /^[ \t]*\[/.test(line)) {
      try {
        let node: unknown = parseHeaderLine(line);
        const path: string[] = [];
        while (node && typeof node === 'object' && !Array.isArray(node)) {
          const keys = Object.keys(node);
          if (keys.length !== 1) break;
          path.push(keys[0]);
          node = (node as Record<string, unknown>)[keys[0]];
          if (Array.isArray(node) && node.length === 1) node = node[0];
        }
        if (path.length === name.split('.').length && path.every((key, j) => key === name.split('.')[j])) out.push(i + 1);
        return;
      } catch {
        // Not a complete header; continue scanning the value's lexical state.
      }
    }
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (quote) {
        if (quote[0] === '"' && c === '\\') { j++; continue; }
        if (line.startsWith(quote, j)) {
          j += quote.length - 1;
          if (quote.length === 3) {
            for (let extra = 0; extra < 2 && line[j + 1] === quote[0]; extra++) j++;
          }
          quote = null;
        }
      } else if (c === '#') break;
      else if (c === '"' || c === "'") {
        quote = line.startsWith(c.repeat(3), j) ? c.repeat(3) as '"""' | "'''" : c;
        j += quote.length - 1;
      } else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
    }
  });
  return out;
}
