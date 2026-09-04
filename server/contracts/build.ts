import { sha256, stable, pascal, camel } from '../util.js';
import type { Field, Seam } from '../splitter/schemas.js';
import type { ContractSpec, ContractExample } from './spec.js';

/**
 * Building and hashing contracts.
 *
 * Kept apart from ./spec.ts so nothing here depends on zod or on the database:
 * the code that turns a seam into a contract, and a contract into a hash, is
 * plain functions over plain objects. That is what lets the generators, the
 * drift checker and a future CLI all use it without booting an app.
 */

/**
 * The hash a contract is identified by for drift detection.
 *
 * Deliberately excludes `summary` and every `description` — a typo fix in prose
 * must not invalidate everyone's generated code. It covers exactly the parts
 * that change how code must be written.
 */
export function specHash(spec: ContractSpec): string {
  const material = {
    key: spec.key,
    kind: spec.kind,
    transport: spec.transport,
    input: stripDescriptions(spec.input),
    output: stripDescriptions(spec.output),
    errors: spec.errors.map((e) => ({ code: e.code, http: e.http })).sort((a, b) => a.code.localeCompare(b.code)),
  };
  return sha256(stable(material));
}

function stripDescriptions(node: any): any {
  if (Array.isArray(node)) return node.map(stripDescriptions);
  if (!node || typeof node !== 'object') return node;
  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'description') continue;
    out[k] = stripDescriptions(v);
  }
  return out;
}

// ── Field vocabulary → JSON Schema ───────────────────────────────────────────

const TYPE_MAP: Record<string, Record<string, unknown>> = {
  string: { type: 'string' },
  number: { type: 'number' },
  boolean: { type: 'boolean' },
  datetime: { type: 'string', format: 'date-time' },
  id: { type: 'string' },
  'string[]': { type: 'array', items: { type: 'string' } },
  'number[]': { type: 'array', items: { type: 'number' } },
  object: { type: 'object' },
  'object[]': { type: 'array', items: { type: 'object' } },
};

/** Turns the model's flat field table into a real JSON Schema object. */
export function compileSchema(fields: Field[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of fields) {
    const base = TYPE_MAP[f.type] ?? { type: 'string' };
    properties[f.name] = f.description ? { ...base, description: f.description } : { ...base };
    if (f.required) required.push(f.name);
  }
  return { type: 'object', properties, required };
}

/** Wraps an object schema in an array when the seam returns a list. */
export function maybeArray(schema: Record<string, unknown>, isArray: boolean) {
  return isArray ? { type: 'array', items: schema } : schema;
}

// ── Deterministic examples ───────────────────────────────────────────────────

/**
 * Examples are mandatory for a contract to lock, because the same example is
 * the frontend's mock, the backend's test fixture and the human's readability
 * check. Rather than asking a model to invent valid ones (it gets the shape
 * wrong often enough to matter), SparkX derives them from the field types.
 * A person can then edit them into something more realistic.
 */
export function exampleValue(f: Field, seed = 0): unknown {
  const n = (seed % 5) + 1;
  switch (f.type) {
    case 'number': return Number((12.9 + n / 100).toFixed(4));
    case 'boolean': return n % 2 === 1;
    case 'datetime': return '2026-01-01T09:0' + n + ':00.000Z';
    case 'id': return `${f.name.replace(/[^a-z]/gi, '').slice(0, 3).toLowerCase() || 'id'}_${100 + n}`;
    case 'string[]': return [`${f.name}-a`, `${f.name}-b`];
    case 'number[]': return [n, n + 1, n + 2, n + 3];
    case 'object': return {};
    case 'object[]': return [{}];
    default: return `${f.name}-${n}`;
  }
}

export function buildExample(seam: Seam): ContractExample {
  const obj = (fields: Field[]) =>
    fields.reduce<Record<string, unknown>>((acc, f, i) => {
      acc[f.name] = exampleValue(f, i);
      return acc;
    }, {});

  const out = obj(seam.output);
  return {
    input: obj(seam.input.filter((f) => f.required || seam.input.length <= 3)),
    output: seam.output_is_array ? [out] : out,
  };
}

/** Assembles a storable spec from a Pass B seam. */
export function seamToSpec(seam: Seam): { spec: ContractSpec; examples: ContractExample[] } {
  const spec: ContractSpec = {
    key: seam.key,
    kind: seam.kind,
    direction: seam.direction,
    summary: seam.summary,
    transport: {
      method: seam.kind === 'http' ? (seam.method || 'GET').toUpperCase() : '',
      path: seam.kind === 'http' ? (seam.path || `/api/${seam.key.replace(/\./g, '/')}`) : '',
      symbol: seam.symbol || defaultSymbol(seam.key, seam.kind),
    },
    input: compileSchema(seam.input),
    output: maybeArray(compileSchema(seam.output), seam.output_is_array) as Record<string, unknown>,
    errors: seam.errors,
  };
  return { spec, examples: [buildExample(seam)] };
}

function defaultSymbol(key: string, kind: string): string {
  const parts = key.split('.');
  if (kind === 'type') return pascal(parts[parts.length - 1]);
  if (kind === 'config') return key.replace(/\./g, '_').toUpperCase();
  if (kind === 'event') return key;
  return camel(parts[parts.length - 1] + '_' + (parts[0] ?? ''));
}
