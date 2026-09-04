import { randomUUID, createHash } from 'node:crypto';

/**
 * Small helpers with no dependencies at all.
 *
 * These live away from the database layer on purpose: the contract format, the
 * hashing and the generators must not drag SQLite in behind them. That keeps
 * the whole contract half of the codebase testable — and reusable by a future
 * CLI — without opening a database file.
 */

export const uid = (prefix: string): string => `${prefix}_${randomUUID().slice(0, 12)}`;

export const now = (): string => new Date().toISOString();

export const sha256 = (input: string): string =>
  'sha256:' + createHash('sha256').update(input).digest('hex');

/** JSON.parse that never throws — returns the fallback on bad or null input. */
export function j<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Stable stringify: object keys sorted recursively.
 *
 * Contract hashes must not change just because a field moved in the JSON, so
 * every hash in SparkX is taken over this rather than raw JSON.stringify.
 */
export function stable(value: unknown): string {
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((acc: any, k) => {
        acc[k] = walk(v[k]);
        return acc;
      }, {});
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

// ── name casing ──────────────────────────────────────────────────────────────
// Every generated symbol name goes through one of these, so a contract key
// always produces the same identifier in every language pack.

export const pascal = (s: string): string =>
  s.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
    .replace(/^(.)/, (c) => c.toUpperCase());

export const camel = (s: string): string => {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

export const snake = (s: string): string =>
  s.replace(/[.\-\s]+/g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
