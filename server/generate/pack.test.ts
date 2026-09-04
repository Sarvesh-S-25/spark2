import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  banner, readBanner, unwrapArray, tsScalar, pyScalar, fieldsOf, safeKey, pathParts,
} from './pack.js';

/**
 * `banner`/`readBanner` are the entire mechanism behind GENERATED_EDITED
 * (AGENTS.md #7): the hash a file declares must match the hash of its own
 * body, and only its own body — a change to the banner text itself must not
 * register as a handwritten edit.
 */

test('readBanner recovers a hash that matches what banner declared', () => {
  const body = 'export function list() {\n  return [];\n}\n';
  const file = banner('//', { contract: 'markers.list', semver: '1.0.0' }, body);
  const recovered = readBanner(file);
  assert.ok(recovered);
  assert.equal(recovered!.declared, recovered!.actual);
});

test('a handwritten edit to the body changes the actual hash but not the declared one', () => {
  const body = 'export const x = 1;\n';
  const file = banner('//', { contract: 'app.config' }, body);
  const edited = file + '\nexport const y = 2;\n';
  const recovered = readBanner(edited)!;
  assert.notEqual(recovered.declared, recovered.actual);
});

test('banner works with the # comment style too, and round-trips identically', () => {
  const body = 'def handler():\n    return {}\n';
  const file = banner('#', { contract: 'markers.detail', specHash: 'abc123' }, body);
  const recovered = readBanner(file)!;
  assert.equal(recovered.declared, recovered.actual);
  assert.ok(file.includes('# spec-hash: abc123'));
});

test('unwrapArray reports whether the schema is a list and unwraps to the item schema', () => {
  const obj = { type: 'object', properties: { id: { type: 'string' } } };
  assert.deepEqual(unwrapArray(obj), { inner: obj, isArray: false });
  const arr = { type: 'array', items: obj };
  assert.deepEqual(unwrapArray(arr), { inner: obj, isArray: true });
});

test('tsScalar and pyScalar map JSON Schema primitives to each language', () => {
  assert.equal(tsScalar({ type: 'number' }), 'number');
  assert.equal(tsScalar({ type: 'array', items: { type: 'string' } }), 'string[]');
  assert.equal(tsScalar({ type: 'object' }), 'Record<string, unknown>');
  assert.equal(pyScalar({ type: 'integer' }), 'int');
  assert.equal(pyScalar({ type: 'array', items: { type: 'number' } }), 'List[float]');
});

test('fieldsOf reads required off the schema and unwraps arrays first', () => {
  const schema = {
    type: 'array',
    items: {
      type: 'object',
      properties: { id: { type: 'string' }, note: { type: 'string' } },
      required: ['id'],
    },
  };
  const fields = fieldsOf(schema);
  assert.equal(fields.length, 2);
  assert.deepEqual(fields.find((f) => f.name === 'id')?.required, true);
  assert.deepEqual(fields.find((f) => f.name === 'note')?.required, false);
});

test('safeKey quotes property names that are not valid identifiers', () => {
  assert.equal(safeKey('id'), 'id');
  assert.equal(safeKey('user-id'), '"user-id"');
});

test('pathParts extracts :params and builds a template literal', () => {
  const { params, template } = pathParts('/api/markers/:id/notes/:noteId');
  assert.deepEqual(params, ['id', 'noteId']);
  assert.equal(template, '/api/markers/${encodeURIComponent(String(args.id))}/notes/${encodeURIComponent(String(args.noteId))}');
});
