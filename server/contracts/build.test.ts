import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specHash, compileSchema, buildExample, seamToSpec, exampleValue } from './build.js';
import type { ContractSpec } from './spec.js';
import type { Seam, Field } from '../splitter/schemas.js';

/**
 * `specHash` is the drift-detection anchor: two specs that mean the same thing
 * to a caller must hash the same, and two that don't must hash differently.
 * The one invariant that matters most (AGENTS.md #8): prose never enters the
 * hash, so fixing a typo in a description or summary is a zero-cost edit.
 */

function spec(over: Partial<ContractSpec> = {}): ContractSpec {
  return {
    key: 'markers.list',
    kind: 'http',
    direction: 'client_to_server',
    summary: 'list the markers',
    transport: { method: 'GET', path: '/api/markers', symbol: '' },
    input: { type: 'object', properties: {}, required: [] },
    output: {
      type: 'object',
      properties: { id: { type: 'string', description: 'the marker id' } },
      required: ['id'],
    },
    errors: [],
    ...over,
  };
}

test('specHash is stable across repeated calls on the same spec', () => {
  const s = spec();
  assert.equal(specHash(s), specHash(s));
  assert.equal(specHash(s), specHash(spec())); // structurally identical, fresh object
});

test('specHash ignores summary and field descriptions', () => {
  const a = spec();
  const b = spec({ summary: 'a completely different sentence about the same endpoint' });
  b.output.properties = { id: { type: 'string', description: 'a totally different description' } };
  assert.equal(specHash(a), specHash(b));
});

test('specHash changes when the input or output shape changes', () => {
  const a = spec();
  const b = spec({
    output: { type: 'object', properties: { id: { type: 'string' }, extra: { type: 'string' } }, required: ['id'] },
  });
  assert.notEqual(specHash(a), specHash(b));
});

test('specHash changes when transport changes but not when error order changes', () => {
  const a = spec({ transport: { method: 'GET', path: '/api/markers', symbol: '' } });
  const b = spec({ transport: { method: 'POST', path: '/api/markers', symbol: '' } });
  assert.notEqual(specHash(a), specHash(b));

  const c = spec({
    errors: [
      { code: 'NOT_FOUND', when: '', http: 404 },
      { code: 'BAD_INPUT', when: '', http: 400 },
    ],
  });
  const d = spec({
    errors: [
      { code: 'BAD_INPUT', when: '', http: 400 },
      { code: 'NOT_FOUND', when: '', http: 404 },
    ],
  });
  assert.equal(specHash(c), specHash(d), 'error codes are sorted before hashing, so order must not matter');
});

test('compileSchema maps the field vocabulary to JSON Schema and tracks required', () => {
  const fields: Field[] = [
    { name: 'id', type: 'id', required: true, description: '' },
    { name: 'tags', type: 'string[]', required: false, description: 'labels' },
  ];
  const schema = compileSchema(fields);
  assert.deepEqual(schema.required, ['id']);
  assert.deepEqual((schema.properties as any).tags, { type: 'array', items: { type: 'string' }, description: 'labels' });
});

test('exampleValue produces a plausible, deterministic value per field type', () => {
  const idField: Field = { name: 'userId', type: 'id', required: true, description: '' };
  assert.equal(exampleValue(idField, 0), exampleValue(idField, 0));
  assert.match(exampleValue(idField, 0) as string, /^use_\d+$/);
  assert.equal(typeof exampleValue({ name: 'ok', type: 'boolean', required: true, description: '' }, 1), 'boolean');
});

test('buildExample only includes optional input fields when the input list is short', () => {
  const manyFields: Field[] = Array.from({ length: 4 }, (_, i) => ({
    name: `f${i}`, type: 'string', required: false, description: '',
  }));
  const seam: Seam = {
    key: 'x', kind: 'function', direction: 'shared', summary: '', capability_ids: [],
    method: '', path: '', symbol: '', input: manyFields, output: [], output_is_array: false, errors: [],
  };
  const ex = buildExample(seam);
  assert.deepEqual(ex.input, {}); // all optional, and list is longer than 3 — dropped
});

test('seamToSpec fills in defaults for path and symbol', () => {
  const seam: Seam = {
    key: 'markers.detail', kind: 'http', direction: 'client_to_server', summary: '', capability_ids: [],
    method: '', path: '', symbol: '', input: [], output: [], output_is_array: false, errors: [],
  };
  const { spec: s } = seamToSpec(seam);
  assert.equal(s.transport.method, 'GET');
  assert.equal(s.transport.path, '/api/markers/detail');
});
