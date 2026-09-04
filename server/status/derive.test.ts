import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

/**
 * `deriveAll` is the one function that turns raw rows into the status a
 * person sees, so it needs a real (if temporary) database rather than mocks —
 * the whole point of the function is the SQL joins and the precedence order
 * between manual overrides, open change requests, blocking findings and
 * contract state. `SPARK_DB` is pointed at a scratch file before `db.js` (and
 * therefore `env.js`) is ever imported, since `env.js` reads `process.env`
 * once at module-evaluation time.
 */

const TEST_DB = './data/test-derive.db';
for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(TEST_DB + suffix, { force: true });
process.env.SPARK_DB = TEST_DB;

const { db } = await import('../db/db.js');
const { uid, now } = await import('../util.js');
const { deriveAll, unblockRanking, criticalPath } = await import('./derive.js');

const conn = db();
const PROJECT = uid('prj');

function insertModule(slug: string, over: Partial<{
  lane: string; kind: string; manual_status: string | null; files: string[];
}> = {}) {
  const id = uid('mod');
  conn.prepare(`INSERT INTO module (id, project_id, slug, name, lane, kind, summary,
      responsibilities_json, non_goals_json, files_json, acceptance_json, est_size,
      manual_status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, PROJECT, slug, slug, over.lane ?? 'backend', over.kind ?? 'service', '',
    '[]', '[]', JSON.stringify(over.files ?? []), '[]', 'S', over.manual_status ?? null, now(),
  );
  return id;
}

function insertContract(key: string, state: string, semver = '1.0.0') {
  const id = uid('con');
  conn.prepare(`INSERT INTO contract (id, project_id, key, kind, current_version, created_at)
    VALUES (?,?,?,?,?,?)`).run(id, PROJECT, key, 'http', semver, now());
  conn.prepare(`INSERT INTO contract_version
      (id, contract_id, semver, state, spec_json, examples_json, spec_hash, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(uid('cv'), id, semver, state, '{}', '[]', 'h', now());
  return id;
}

function wire(moduleId: string, contractId: string, role: 'provides' | 'consumes') {
  conn.prepare('INSERT INTO module_contract (module_id, contract_id, role) VALUES (?,?,?)')
    .run(moduleId, contractId, role);
}

before(() => {
  conn.prepare('INSERT INTO project (id, name, root_path, created_at) VALUES (?,?,?,?)')
    .run(PROJECT, 'test project', null, now());
});

after(() => {
  conn.close();
  for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(TEST_DB + suffix, { force: true });
});

test('a module that depends on nothing is ready', () => {
  const id = insertModule('be.standalone');
  const [m] = deriveAll(PROJECT).filter((x) => x.id === id);
  assert.equal(m.status, 'ready');
  assert.match(m.reason, /depends on nothing/);
});

test('a module waiting on a draft contract is planned, not ready', () => {
  const provider = insertModule('be.provider-draft');
  const consumer = insertModule('fe.consumer-draft');
  const c = insertContract('draft.thing', 'draft');
  wire(provider, c, 'provides');
  wire(consumer, c, 'consumes');

  const derived = deriveAll(PROJECT);
  const cm = derived.find((m) => m.id === consumer)!;
  assert.equal(cm.status, 'planned');
  assert.deepEqual(cm.waitingOn, ['draft.thing']);
});

test('locking the contract moves the consumer from planned toward ready', () => {
  const provider = insertModule('be.provider-locked');
  const consumer = insertModule('fe.consumer-locked');
  const c = insertContract('locked.thing', 'locked');
  wire(provider, c, 'provides');
  wire(consumer, c, 'consumes');

  const cm = deriveAll(PROJECT).find((m) => m.id === consumer)!;
  assert.equal(cm.waitingOn.length, 0);
  assert.equal(cm.status, 'ready');
});

test('a manual override wins and is reported as asserted', () => {
  const id = insertModule('be.overridden', { manual_status: 'completed' });
  const m = deriveAll(PROJECT).find((x) => x.id === id)!;
  assert.equal(m.status, 'completed');
  assert.equal(m.asserted, true);
  assert.match(m.reason, /asserted by a person/);
});

test('orphaned takes precedence over any other manual status', () => {
  const id = insertModule('be.orphan', { manual_status: 'orphaned' });
  const m = deriveAll(PROJECT).find((x) => x.id === id)!;
  assert.equal(m.status, 'orphaned');
  assert.equal(m.asserted, false, 'orphaned is not counted as an asserted override');
});

test('an open change request on a consumed contract blocks the module', () => {
  const provider = insertModule('be.provider-cr');
  const consumer = insertModule('fe.consumer-cr');
  const c = insertContract('cr.thing', 'locked');
  wire(provider, c, 'provides');
  wire(consumer, c, 'consumes');
  conn.prepare(`INSERT INTO change_request
      (id, contract_id, to_semver, proposed_spec_json, reason, change_class, state, opened_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(uid('cr'), c, '2.0.0', '{}', 'field rename', 'breaking', 'open', now());

  const cm = deriveAll(PROJECT).find((m) => m.id === consumer)!;
  assert.equal(cm.status, 'blocked');
  assert.match(cm.reason, /open change request/);
});

test('a blocking finding from the last check run blocks the module', () => {
  const id = insertModule('be.finding-target');
  const runId = uid('run');
  conn.prepare(`INSERT INTO check_run (id, project_id, levels, started_at) VALUES (?,?,?,?)`)
    .run(runId, PROJECT, '1', now());
  conn.prepare(`INSERT INTO finding (id, check_run_id, severity, code, module_id, message)
    VALUES (?,?,?,?,?,?)`).run(uid('find'), runId, 'block', 'CYCLE', id, 'circular dependency');

  const m = deriveAll(PROJECT).find((x) => x.id === id)!;
  assert.equal(m.status, 'blocked');
  assert.match(m.reason, /blocking finding/);
});

test('unblockRanking counts how many modules each unlocked contract is blocking', () => {
  const provider = insertModule('be.shared-provider');
  const c = insertContract('shared.thing', 'draft');
  wire(provider, c, 'provides');
  for (const slug of ['fe.dep-a', 'fe.dep-b']) {
    const consumer = insertModule(slug);
    wire(consumer, c, 'consumes');
  }

  const ranking = unblockRanking(PROJECT);
  const row = ranking.find((r) => r.key === 'shared.thing');
  assert.ok(row && row.blocks >= 2);
});

test('criticalPath returns an ordered chain ending at an unfinished module', () => {
  const upstream = insertModule('be.chain-a');
  const downstream = insertModule('be.chain-b');
  const c = insertContract('chain.thing', 'locked');
  wire(upstream, c, 'provides');
  wire(downstream, c, 'consumes');

  const path = criticalPath(PROJECT);
  assert.ok(path.includes('be.chain-b'));
  assert.ok(path.indexOf('be.chain-a') < path.indexOf('be.chain-b'));
});
