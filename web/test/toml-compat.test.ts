import { describe, expect, it } from 'vitest';
import { parseFinancials, parseSettings } from '../src/domain/config';
import { parseTomlCompat } from '../src/domain/toml-compat';
import { findTableLines, parseToml } from '../src/domain/toml';

function ok(text: string): Record<string, unknown> {
  const r = parseToml(text);
  if (!r.ok) throw new Error(`expected ok, got line ${r.line}: ${r.message}`);
  return r.value;
}

describe('parseToml fallback to reference-compatible parsing', () => {
  it('accepts unquoted bare values as strings', () => {
    expect(ok('kind = monthly\n')).toEqual({ kind: 'monthly' });
  });

  it('accepts unquoted date-like values through parseFinancials', () => {
    const text = `[[recurring_transactions]]
description = "Gym"
amount = -20
start_date = 2024-02-start
`;
    const r = parseFinancials(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.recurring).toHaveLength(1);
      expect(r.value.recurring[0].start).toBe('2024-02-01');
    }
  });

  it('accepts trailing commas in arrays and inline tables', () => {
    expect(ok('a = [1, 2, 3,]\n')).toEqual({ a: [1, 2, 3] });
    expect(ok('t = { x = 1, y = "b", }\n')).toEqual({ t: { x: 1, y: 'b' } });
  });

  it('accepts multiline inline tables', () => {
    const text = `t = {
  x = 1, # comment
  y = 2
}
`;
    expect(ok(text)).toEqual({ t: { x: 1, y: 2 } });
  });

  it('keeps the last value for duplicate keys', () => {
    expect(ok('a = 1\na = 2\n')).toEqual({ a: 2 });
  });

  it('parses 0x, 0o, 0b and underscore numbers', () => {
    expect(ok('h = 0xFF\no = 0o17\nb = 0b101\nu = 1_000\n')).toEqual({ h: 255, o: 15, b: 5, u: 1000 });
    expect(ok('h = 0xFF_FF\n')).toEqual({ h: 65535 });
  });

  it('parses inf and nan', () => {
    const r = ok('a = inf\nb = -inf\nc = nan\n');
    expect(r.a).toBe(Infinity);
    expect(r.b).toBe(-Infinity);
    expect(Number.isNaN(r.c)).toBe(true);
  });

  it('parses quoted and dotted keys and table arrays', () => {
    const text = `"quoted key" = 1
a."b c" = 2
[[items]]
n = 1
[[items]]
n = 2
`;
    expect(ok(text)).toEqual({ 'quoted key': 1, a: { 'b c': 2 }, items: [{ n: 1 }, { n: 2 }] });
  });

  it('accepts CRLF line endings and comments', () => {
    expect(ok('# head\r\na = 1 # tail\r\nb = "x"\r\n')).toEqual({ a: 1, b: 'x' });
  });

  it('does not leak reference metadata into the value', () => {
    const r = ok('t = { x = 1 }\n[[items]]\nn = 1\n');
    expect(Object.keys(r.t as object)).toEqual(['x']);
    expect(Object.keys((r.items as object[])[0])).toEqual(['n']);
  });

  it('accepts unquoted table headers that strict TOML rejects, and locates them', () => {
    const text = `[importer.formats]
name = "a"
[[recurring_transactions]]
description = "x"
[my/odd@header]
k = 1
[[recurring_transactions]]
description = "y"
`;
    expect(parseToml(text).ok).toBe(true);
    expect(findTableLines(text, 'recurring_transactions')).toEqual([3, 7]);
    expect(findTableLines(text, 'my/odd@header')).toEqual([5]);
  });

  it('keeps strict TOML results when smol-toml accepts the text', () => {
    const r = ok('d = 1979-05-27\nn = 1\n');
    expect(r.d).toBeInstanceOf(Date);
    expect(r.n).toBe(1);
    // Compat returns a string for the same date, so the strict result is what callers see.
    expect(parseTomlCompat('d = 1979-05-27\n')).toEqual({ ok: true, value: { d: '1979-05-27' } });
  });

  it('still rejects genuinely broken input with the strict error', () => {
    expect(parseToml('a = "unclosed\n').ok).toBe(false);
    expect(parseToml('a = = 1\n').ok).toBe(false);
    expect(parseToml('a = [1, 2\n').ok).toBe(false);
    expect(parseToml('[table\n').ok).toBe(false);
  });

  it('reports the strict-TOML line and column for rejected input', () => {
    const r = parseToml('ok = 1\nbad = [1, 2\n');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.line).toBeGreaterThan(0);
      expect(r.col).toBeGreaterThan(0);
      expect(r.message.length).toBeGreaterThan(0);
    }
  });

  it('compat parser reports line and column for broken input', () => {
    expect(parseTomlCompat('a = "unclosed\n')).toMatchObject({ ok: false });
    expect(parseTomlCompat('a = = 1\n')).toMatchObject({ ok: false, line: 1 });
    expect(parseTomlCompat('a = [1, 2\n')).toMatchObject({ ok: false });
  });

  it('keeps settings validation working with compat-only input', () => {
    const r = parseSettings('[user]\ncurrency_symbol = EUR\n');
    expect(r.ok).toBe(true);
  });

  it('treats __proto__ as an ordinary key', () => {
    const r = parseTomlCompat('"__proto__" = "y"\nb = 1 \nc = z\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(r.value, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).y).toBeUndefined();
  });
});
