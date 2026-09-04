import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSplit, type SplitInput } from './validate.js';
import type { Capability, Seam, SplitModule } from './schemas.js';

/**
 * One test per structural check `validateSplit` runs, plus a clean-split
 * baseline. Each check exists because a split can be confidently wrong in a
 * way that only surfaces once two people have built against it — these tests
 * pin down exactly which shape trips which code.
 */

function cap(id: string): Capability {
  return { id, text: `do the ${id} thing`, actor: 'user', source_quote: '' };
}

function seam(over: Partial<Seam> & { key: string }): Seam {
  return {
    kind: 'http', direction: 'client_to_server', summary: '', capability_ids: [],
    method: '', path: '', symbol: '', input: [], output: [], output_is_array: false, errors: [],
    ...over,
  };
}

function mod(over: Partial<SplitModule> & { slug: string; lane: SplitModule['lane'] }): SplitModule {
  return {
    name: over.slug, kind: 'service', summary: '', responsibilities: [], non_goals: [],
    provides: [], consumes: [], files: [], acceptance: [], est_size: 'S',
    ...over,
  };
}

function baseline(): SplitInput {
  return {
    capabilities: [cap('see-markers')],
    seams: [seam({ key: 'markers.list', capability_ids: ['see-markers'] })],
    modules: [
      mod({ slug: 'be.markers', lane: 'backend', kind: 'api_route', provides: ['markers.list'] }),
      mod({ slug: 'fe.map', lane: 'frontend', kind: 'ui_component', consumes: ['markers.list'] }),
    ],
  };
}

test('a clean split raises no issues', () => {
  assert.deepEqual(validateSplit(baseline()), []);
});

test('DUPLICATE_SLUG when two modules share a slug', () => {
  const s = baseline();
  s.modules.push(mod({ slug: 'be.markers', lane: 'backend' }));
  const issues = validateSplit(s);
  assert.ok(issues.some((i) => i.code === 'DUPLICATE_SLUG' && i.severity === 'block'));
});

test('DUPLICATE_FILE when two modules claim the same file', () => {
  const s = baseline();
  s.modules[0].files = ['server/markers.ts'];
  s.modules[1].files = ['server/markers.ts'];
  const issues = validateSplit(s);
  assert.ok(issues.some((i) => i.code === 'DUPLICATE_FILE'));
});

test('UNKNOWN_CONTRACT when a module consumes a key with no seam', () => {
  const s = baseline();
  s.modules[1].consumes = ['markers.nonexistent'];
  const issues = validateSplit(s);
  assert.ok(issues.some((i) => i.code === 'UNKNOWN_CONTRACT' && i.subject === 'markers.nonexistent'));
});

test('ORPHAN_CONTRACT when something consumes a real seam nobody provides', () => {
  const s = baseline();
  s.modules[0].provides = []; // nobody provides markers.list any more
  const issues = validateSplit(s);
  assert.ok(issues.some((i) => i.code === 'ORPHAN_CONTRACT' && i.subject === 'markers.list'));
  // and also NO_PROVIDER_MODULE from the seam-centric pass
  assert.ok(issues.some((i) => i.code === 'NO_PROVIDER_MODULE'));
});

test('DUPLICATE_PROVIDER when two modules both provide the same contract', () => {
  const s = baseline();
  s.modules.push(mod({ slug: 'be.markers-2', lane: 'backend', provides: ['markers.list'] }));
  const issues = validateSplit(s);
  assert.ok(issues.some((i) => i.code === 'DUPLICATE_PROVIDER'));
});

test('DEAD_CONTRACT (warn) when a provided seam has no consumer, unless device_to_server', () => {
  const s = baseline();
  s.modules[1].consumes = []; // nobody consumes markers.list any more
  const issues = validateSplit(s);
  const dead = issues.find((i) => i.code === 'DEAD_CONTRACT');
  assert.ok(dead && dead.severity === 'warn');

  const deviceReport = baseline();
  deviceReport.seams[0].direction = 'device_to_server';
  deviceReport.modules[1].consumes = [];
  assert.ok(!validateSplit(deviceReport).some((i) => i.code === 'DEAD_CONTRACT'));
});

test('LANE_IMPURITY when a frontend module has a backend kind', () => {
  const s = baseline();
  s.modules[1].kind = 'api_route';
  const issues = validateSplit(s);
  assert.ok(issues.some((i) => i.code === 'LANE_IMPURITY' && i.subject === 'fe.map'));
});

test('LANE_IMPURITY when a frontend module claims to provide an http seam', () => {
  const s = baseline();
  s.modules[1].provides = ['markers.list'];
  const issues = validateSplit(s);
  assert.ok(issues.some((i) => i.code === 'LANE_IMPURITY' && i.subject?.includes('fe.map')));
});

test('OVERSIZED_MODULE (warn) when a module is estimated large', () => {
  const s = baseline();
  s.modules[0].est_size = 'L';
  const issues = validateSplit(s);
  assert.ok(issues.some((i) => i.code === 'OVERSIZED_MODULE' && i.severity === 'warn'));
});

test('UNCOVERED_CAPABILITY (warn) when a capability has no working seam', () => {
  const s = baseline();
  s.capabilities.push(cap('never-built'));
  const issues = validateSplit(s);
  assert.ok(issues.some((i) => i.code === 'UNCOVERED_CAPABILITY' && i.subject === 'never-built'));
});

test('CYCLE when two modules depend on each other', () => {
  const s: SplitInput = {
    capabilities: [],
    seams: [seam({ key: 'a.thing' }), seam({ key: 'b.thing' })],
    modules: [
      mod({ slug: 'be.a', lane: 'backend', provides: ['a.thing'], consumes: ['b.thing'] }),
      mod({ slug: 'be.b', lane: 'backend', provides: ['b.thing'], consumes: ['a.thing'] }),
    ],
  };
  const issues = validateSplit(s);
  assert.ok(issues.some((i) => i.code === 'CYCLE'));
});
