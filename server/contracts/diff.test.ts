import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffContracts, bump, parseSemver } from './diff.js';
import type { ContractSpec } from './spec.js';

/**
 * `diffContracts` is the one place a change's class gets decided, so the tests
 * here are organized by what kind of edit produces which class — not by which
 * function is called. Getting one of these wrong means either an unannounced
 * break, or a change request nobody needed to write.
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
      properties: { id: { type: 'string' }, label: { type: 'string' } },
      required: ['id', 'label'],
    },
    errors: [],
    ...over,
  };
}

test('identical specs produce no reasons and stay additive', () => {
  const s = spec();
  const r = diffContracts(s, spec());
  assert.equal(r.changeClass, 'additive');
  assert.equal(r.reasons.length, 0);
});

test('a new optional output field is additive', () => {
  const before = spec();
  const after = spec({
    output: {
      type: 'object',
      properties: { id: { type: 'string' }, label: { type: 'string' }, note: { type: 'string' } },
      required: ['id', 'label'],
    },
  });
  const r = diffContracts(before, after);
  assert.equal(r.changeClass, 'additive');
  assert.ok(r.reasons.some((x) => x.message.includes('new output field "note"')));
});

test('an input field becoming optional is widening, not breaking', () => {
  const before = spec({
    input: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  });
  const after = spec({
    input: { type: 'object', properties: { q: { type: 'string' } }, required: [] },
  });
  const r = diffContracts(before, after);
  assert.equal(r.changeClass, 'widening');
});

test('a new required input field is breaking — existing callers do not send it', () => {
  const before = spec();
  const after = spec({
    input: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
  });
  const r = diffContracts(before, after);
  assert.equal(r.changeClass, 'breaking');
  assert.ok(r.reasons.some((x) => x.class === 'breaking' && x.message.includes('token')));
});

test('removing an output field is breaking even though nothing was added', () => {
  const before = spec();
  const after = spec({
    output: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  });
  const r = diffContracts(before, after);
  assert.equal(r.changeClass, 'breaking');
  assert.ok(r.reasons.some((x) => x.message.includes('output field "label" was removed')));
});

test('an output field changing type is breaking', () => {
  const before = spec();
  const after = spec({
    output: {
      type: 'object',
      properties: { id: { type: 'number' }, label: { type: 'string' } },
      required: ['id', 'label'],
    },
  });
  const r = diffContracts(before, after);
  assert.equal(r.changeClass, 'breaking');
});

test('switching between a single object and a list is breaking', () => {
  const before = spec();
  const after = spec({
    output: { type: 'array', items: spec().output },
  });
  const r = diffContracts(before, after);
  assert.equal(r.changeClass, 'breaking');
  assert.ok(r.reasons.some((x) => x.message.includes('single object and a list')));
});

test('a new error code is additive; removing one is breaking', () => {
  const before = spec({ errors: [{ code: 'NOT_FOUND', when: '', http: 404 }] });
  const widened = spec({
    errors: [
      { code: 'NOT_FOUND', when: '', http: 404 },
      { code: 'RATE_LIMITED', when: '', http: 429 },
    ],
  });
  assert.equal(diffContracts(before, widened).changeClass, 'additive');

  const narrowed = spec({ errors: [] });
  assert.equal(diffContracts(before, narrowed).changeClass, 'breaking');
});

test('changing transport method or path is breaking', () => {
  const before = spec();
  const after = spec({ transport: { method: 'POST', path: '/api/markers', symbol: '' } });
  assert.equal(diffContracts(before, after).changeClass, 'breaking');
});

test('breaking beats widening beats additive when reasons mix', () => {
  const before = spec({
    input: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  });
  const after = spec({
    input: { type: 'object', properties: { q: { type: 'string' } }, required: [] }, // widening
    output: {
      type: 'object',
      properties: { id: { type: 'string' }, label: { type: 'string' } },
      required: [], // breaking: "label" no longer always present
    },
  });
  assert.equal(diffContracts(before, after).changeClass, 'breaking');
});

test('parseSemver falls back to 1.0.0 on garbage input', () => {
  assert.deepEqual(parseSemver('not-a-version'), [1, 0, 0]);
  assert.deepEqual(parseSemver('2.10.3'), [2, 10, 3]);
});

test('bump: breaking always resets to the next major', () => {
  assert.equal(bump('1.4.7', 'breaking'), '2.0.0');
});

test('bump: widening or any additive change bumps minor', () => {
  assert.equal(bump('1.4.7', 'widening'), '1.5.0');
  assert.equal(bump('1.4.7', 'additive', true), '1.5.0');
});

test('bump: additive with no actual reasons only bumps patch', () => {
  assert.equal(bump('1.4.7', 'additive', false), '1.4.8');
});
