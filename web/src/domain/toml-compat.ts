/**
 * Lenient TOML parser: a TypeScript port of the reference `Toml11Parser`
 * (/tmp/kilo/reference.html, commit 7cc7622). It is only used as a fallback
 * when the strict `smol-toml` parser rejects a document, so that everything
 * the reference parser accepts is also accepted by the app.
 *
 * Semantics kept from the reference: duplicate keys overwrite, unquoted values
 * that are not numbers/booleans/inf/nan are returned as strings, trailing commas
 * in arrays and inline tables, multiline inline tables, 0x/0o/0b and underscore
 * numbers, bare and quoted/dotted keys, comments, CRLF line endings, and its
 * escape handling.
 *
 * Deliberately not ported: the `_line` metadata the reference attaches to
 * table-array entries and inline tables (it would leak into the data, e.g. as a
 * category name), and the `sections`/`keyCount` bookkeeping used only by the
 * reference UI. No DOM dependencies.
 */

export type CompatResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; line: number; col: number; message: string };

type Table = Record<string, unknown>;

class CompatError extends Error {
  constructor(message: string, readonly line: number, readonly col: number) {
    super(message);
  }
}

const NUMBER_RE = /^[+-]?(0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|[0-9_]+(\.[0-9_]+)?([eE][+-]?[0-9_]+)?)$/;

function isObject(v: unknown): v is Table {
  return v !== null && typeof v === 'object';
}

/** Own-property read, so keys such as `__proto__` cannot reach the prototype chain. */
function own(o: Table, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}

/** Own-property write that also works for the key `__proto__`. */
function put(o: Table, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
}

class Parser {
  private pos = 0;
  private line = 1;
  private col = 1;
  private readonly root: Table = {};
  private currentObj: Table = this.root;

  constructor(private readonly src: string) {}

  private peek(): string {
    return this.src[this.pos] || '';
  }

  private peekAhead(n = 1): string {
    return this.src.substr(this.pos, n);
  }

  private next(): string {
    const c = this.src[this.pos];
    this.pos++;
    if (c === '\n') {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return c;
  }

  private eof(): boolean {
    return this.pos >= this.src.length;
  }

  private error(msg: string): CompatError {
    return new CompatError(msg, this.line, this.col);
  }

  private skipWhitespace(allowNewlines = false): void {
    while (!this.eof()) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r') this.next();
      else if (allowNewlines && c === '\n') this.next();
      else break;
    }
  }

  private skipWhitespaceAndComments(allowNewlines = false): void {
    while (!this.eof()) {
      this.skipWhitespace(allowNewlines);
      if (this.peek() === '#') {
        while (!this.eof() && this.peek() !== '\n') this.next();
        if (allowNewlines && this.peek() === '\n') this.next();
      } else if (allowNewlines && this.peek() === '\n') {
        this.next();
      } else {
        break;
      }
    }
  }

  parse(): Table {
    while (!this.eof()) {
      this.skipWhitespace(false);
      if (this.eof()) break;

      const c = this.peek();

      if (c === '\n') {
        this.next();
        continue;
      }
      if (c === '\r') {
        this.next();
        if (this.peek() === '\n') this.next();
        continue;
      }
      if (c === '#') {
        while (!this.eof() && this.peek() !== '\n') this.next();
        continue;
      }
      if (this.peekAhead(2) === '[[') {
        this.parseTableArrayHeader();
        continue;
      }
      if (c === '[') {
        this.parseTableHeader();
        continue;
      }
      this.parseKeyValuePair();
    }
    return this.root;
  }

  private parseTableHeader(): void {
    this.next();
    this.skipWhitespace(false);
    const path = this.parseKeyPath(']');
    this.skipWhitespace(false);
    if (this.peek() !== ']') throw this.error("Expected ']' closing table header");
    this.next();
    this.ensureLineEnd();

    let target = this.root;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      const child = own(target, k);
      if (!isObject(child) || Array.isArray(child)) put(target, k, {});
      target = own(target, k) as Table;
    }
    const lastKey = path[path.length - 1];
    const last = own(target, lastKey);
    if (!isObject(last) || Array.isArray(last)) put(target, lastKey, {});
    this.currentObj = own(target, lastKey) as Table;
  }

  private parseTableArrayHeader(): void {
    this.next();
    this.next();
    this.skipWhitespace(false);
    const path = this.parseKeyPath(']]');
    this.skipWhitespace(false);
    if (this.peekAhead(2) !== ']]') throw this.error("Expected ']]' closing table array header");
    this.next();
    this.next();
    this.ensureLineEnd();

    let target = this.root;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      if (!isObject(own(target, k))) put(target, k, {});
      target = own(target, k) as Table;
    }
    const lastKey = path[path.length - 1];
    if (!Array.isArray(own(target, lastKey))) put(target, lastKey, []);
    const newEntry: Table = {};
    (own(target, lastKey) as unknown[]).push(newEntry);
    this.currentObj = newEntry;
  }

  private parseKeyValuePair(): void {
    const keyPath = this.parseKeyPath('=');
    this.skipWhitespace(false);
    if (this.peek() !== '=') throw this.error("Expected '=' after key");
    this.next();
    this.skipWhitespace(false);

    const val = this.parseValue();
    this.ensureLineEnd();

    let target = this.currentObj;
    for (let i = 0; i < keyPath.length - 1; i++) {
      const k = keyPath[i];
      if (!isObject(own(target, k))) put(target, k, {});
      target = own(target, k) as Table;
    }
    put(target, keyPath[keyPath.length - 1], val);
  }

  private parseKeyPath(untilChar: string): string[] {
    const parts: string[] = [];
    while (!this.eof()) {
      this.skipWhitespace(false);
      const c = this.peek();
      let key = '';

      if (c === '"') {
        key = this.parseBasicString(false) as string;
      } else if (c === "'") {
        key = this.parseLiteralString(false) as string;
      } else {
        while (!this.eof()) {
          const ch = this.peek();
          if (ch === '.' || ch === '=' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ']' || ch === untilChar) {
            break;
          }
          key += this.next();
        }
      }

      if (!key && parts.length === 0) throw this.error('Expected key name');
      parts.push(key);

      this.skipWhitespace(false);
      if (this.peek() === '.') {
        this.next();
        continue;
      }
      break;
    }
    return parts;
  }

  private parseValue(): unknown {
    this.skipWhitespace(false);
    const c = this.peek();

    if (c === '"') {
      if (this.peekAhead(3) === '"""') return this.parseBasicString(true);
      return this.parseBasicString(false);
    }
    if (c === "'") {
      if (this.peekAhead(3) === "'''") return this.parseLiteralString(true);
      return this.parseLiteralString(false);
    }
    if (c === '[') return this.parseArray();
    if (c === '{') return this.parseInlineTable();

    if (this.peekAhead(4) === 'true' && this.isWordBoundary(4)) {
      this.pos += 4;
      this.col += 4;
      return true;
    }
    if (this.peekAhead(5) === 'false' && this.isWordBoundary(5)) {
      this.pos += 5;
      this.col += 5;
      return false;
    }

    const rawLiteral = this.readUntilDelimiter();
    const lower = rawLiteral.toLowerCase();
    if (lower === 'inf' || lower === '+inf') return Infinity;
    if (lower === '-inf') return -Infinity;
    if (lower === 'nan' || lower === '+nan' || lower === '-nan') return NaN;

    if (NUMBER_RE.test(rawLiteral)) {
      const clean = rawLiteral.replace(/_/g, '');
      if (/^[+-]?0x/.test(clean)) return parseInt(clean, 16);
      if (/^[+-]?0o/.test(clean)) return parseInt(clean.replace('0o', ''), 8);
      if (/^[+-]?0b/.test(clean)) return parseInt(clean.replace('0b', ''), 2);
      return Number(clean);
    }

    return rawLiteral;
  }

  private parseBasicString(isMulti: boolean): string {
    let res = '';
    if (isMulti) {
      this.next();
      this.next();
      this.next();
      if (this.peek() === '\n') this.next();
      else if (this.peekAhead(2) === '\r\n') {
        this.next();
        this.next();
      }

      while (!this.eof()) {
        if (this.peekAhead(3) === '"""') {
          this.next();
          this.next();
          this.next();
          return res;
        }
        const c = this.next();
        if (c === '\\') {
          if (this.peek() === '\n' || this.peekAhead(2) === '\r\n') {
            this.skipWhitespaceAndComments(true);
            continue;
          }
          res += this.parseEscapeSequence();
        } else {
          res += c;
        }
      }
      throw this.error('Unclosed multiline basic string');
    }

    this.next();
    while (!this.eof()) {
      const c = this.next();
      if (c === '"') return res;
      if (c === '\n' || c === '\r') throw this.error('Newlines not allowed in single-line basic string');
      if (c === '\\') res += this.parseEscapeSequence();
      else res += c;
    }
    throw this.error('Unclosed basic string');
  }

  private parseLiteralString(isMulti: boolean): string {
    let res = '';
    if (isMulti) {
      this.next();
      this.next();
      this.next();
      if (this.peek() === '\n') this.next();
      else if (this.peekAhead(2) === '\r\n') {
        this.next();
        this.next();
      }

      while (!this.eof()) {
        if (this.peekAhead(3) === "'''") {
          this.next();
          this.next();
          this.next();
          return res;
        }
        res += this.next();
      }
      throw this.error('Unclosed multiline literal string');
    }

    this.next();
    while (!this.eof()) {
      const c = this.next();
      if (c === "'") return res;
      if (c === '\n' || c === '\r') throw this.error('Newlines not allowed in single-line literal string');
      res += c;
    }
    throw this.error('Unclosed literal string');
  }

  private parseEscapeSequence(): string {
    const esc = this.next();
    switch (esc) {
      case 'b': return '\b';
      case 't': return '\t';
      case 'n': return '\n';
      case 'f': return '\f';
      case 'r': return '\r';
      case '"': return '"';
      case '\\': return '\\';
      default: return esc;
    }
  }

  private parseArray(): unknown[] {
    this.next();
    const arr: unknown[] = [];
    while (!this.eof()) {
      this.skipWhitespaceAndComments(true);
      if (this.peek() === ']') {
        this.next();
        return arr;
      }

      arr.push(this.parseValue());

      this.skipWhitespaceAndComments(true);
      if (this.peek() === ',') {
        this.next();
        this.skipWhitespaceAndComments(true);
        if (this.peek() === ']') {
          this.next();
          return arr;
        }
      } else if (this.peek() === ']') {
        this.next();
        return arr;
      } else {
        throw this.error("Expected ',' or ']' in array");
      }
    }
    throw this.error('Unclosed array');
  }

  private parseInlineTable(): Table {
    this.next();
    const tbl: Table = {};

    while (!this.eof()) {
      this.skipWhitespaceAndComments(true);
      if (this.peek() === '}') {
        this.next();
        return tbl;
      }

      const keyPath = this.parseKeyPath('=');
      this.skipWhitespace(false);
      if (this.peek() !== '=') throw this.error("Expected '=' in inline table");
      this.next();
      this.skipWhitespaceAndComments(true);

      const val = this.parseValue();

      let target = tbl;
      for (let i = 0; i < keyPath.length - 1; i++) {
        const k = keyPath[i];
        if (!isObject(own(target, k))) put(target, k, {});
        target = own(target, k) as Table;
      }
      put(target, keyPath[keyPath.length - 1], val);

      this.skipWhitespaceAndComments(true);
      if (this.peek() === ',') {
        this.next();
        this.skipWhitespaceAndComments(true);
        if (this.peek() === '}') {
          this.next();
          return tbl;
        }
      } else if (this.peek() === '}') {
        this.next();
        return tbl;
      } else {
        throw this.error("Expected ',' or '}' in inline table");
      }
    }
    throw this.error('Unclosed inline table');
  }

  private readUntilDelimiter(): string {
    let val = '';
    while (!this.eof()) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === ',' || c === ']' || c === '}' || c === '#') break;
      val += this.next();
    }
    return val.trim();
  }

  private isWordBoundary(offset: number): boolean {
    const charAfter = this.src[this.pos + offset];
    return !charAfter || /[ \t\r\n,\]}#]/.test(charAfter);
  }

  private ensureLineEnd(): void {
    this.skipWhitespace(false);
    if (this.peek() === '#') {
      while (!this.eof() && this.peek() !== '\n') this.next();
    }
    if (!this.eof() && this.peek() !== '\n' && this.peek() !== '\r') {
      throw this.error('Unexpected content after expression on the same line');
    }
  }
}

/** Parses text with the reference Toml11Parser semantics. Never throws. */
export function parseTomlCompat(text: string): CompatResult {
  try {
    return { ok: true, value: new Parser(text).parse() };
  } catch (err) {
    if (err instanceof CompatError) return { ok: false, line: err.line, col: err.col, message: err.message };
    return { ok: false, line: 1, col: 1, message: err instanceof Error ? err.message : 'Invalid TOML' };
  }
}
