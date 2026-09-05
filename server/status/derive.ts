import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { db, j } from '../db/db.js';
import { unblocks } from '../contracts/state.js';
import type { ContractState } from '../contracts/spec.js';

/**
 * Status derivation.
 *
 * The design decision that makes the board worth looking at: status is computed
 * from evidence, not typed in by whoever feels optimistic today. A person can
 * still force a status — they will need to — but the override renders as a
 * visibly different "asserted" badge and is recorded with their name against it.
 *
 * What counts as evidence today:
 *   • the state of every contract the module consumes and provides
 *   • whether the module's declared files exist on disk
 *   • open change requests touching its contracts
 *   • blocking findings from the last dependency check
 *
 * What does not count yet: running the contract tests. That is Phase 4 work and
 * is called out in HOW_TO_RUN.md rather than quietly faked here.
 */

export type ModuleStatus =
  | 'planned' | 'ready' | 'building' | 'blocked' | 'contract_met' | 'completed' | 'orphaned';

export interface DerivedModule {
  id: string;
  slug: string;
  name: string;
  lane: string;
  kind: string;
  summary: string;
  est_size: string;
  files: string[];
  acceptance: string[];
  responsibilities: string[];
  non_goals: string[];
  provides: string[];
  consumes: string[];
  waitingOn: string[];
  status: ModuleStatus;
  asserted: boolean;
  reason: string;
  assignee: string | null;
  filesPresent: number;
  filesTotal: number;
}

export function deriveAll(projectId: string): DerivedModule[] {
  const conn = db();

  const project = conn.prepare('SELECT root_path FROM project WHERE id = ?')
    .get(projectId) as { root_path: string | null } | undefined;
  const root = project?.root_path ? resolve(process.cwd(), project.root_path) : null;

  const modules = conn.prepare('SELECT * FROM module WHERE project_id = ? ORDER BY lane, slug')
    .all(projectId) as any[];

  const wiring = conn.prepare(`
    SELECT mc.role, mc.module_id, c.id AS contract_id, c.key, c.current_version
    FROM module_contract mc
    JOIN contract c ON c.id = mc.contract_id
    WHERE c.project_id = ?`).all(projectId) as any[];

  const versionState = new Map<string, ContractState>();
  for (const v of conn.prepare(`
      SELECT cv.contract_id, cv.semver, cv.state FROM contract_version cv
      JOIN contract c ON c.id = cv.contract_id WHERE c.project_id = ?`).all(projectId) as any[]) {
    versionState.set(`${v.contract_id}@${v.semver}`, v.state as ContractState);
  }

  const openCr = new Set(
    (conn.prepare(`SELECT cr.contract_id FROM change_request cr
       JOIN contract c ON c.id = cr.contract_id
       WHERE c.project_id = ? AND cr.state = 'open'`).all(projectId) as any[])
      .map((r) => r.contract_id as string),
  );

  const lastRun = conn.prepare(
    'SELECT id FROM check_run WHERE project_id = ? ORDER BY started_at DESC LIMIT 1',
  ).get(projectId) as { id: string } | undefined;

  const blockingByModule = new Set<string>();
  if (lastRun) {
    for (const f of conn.prepare(
      `SELECT module_id FROM finding WHERE check_run_id = ? AND severity = 'block' AND module_id IS NOT NULL`,
    ).all(lastRun.id) as any[]) {
      blockingByModule.add(f.module_id);
    }
  }

  const claims = new Map<string, string>();
  for (const c of conn.prepare('SELECT module_id, assignee FROM claim').all() as any[]) {
    claims.set(c.module_id, c.assignee);
  }

  return modules.map((m) => {
    const mine = wiring.filter((w) => w.module_id === m.id);
    const consumes = mine.filter((w) => w.role === 'consumes');
    const provides = mine.filter((w) => w.role === 'provides');

    const stateOf = (w: any) => versionState.get(`${w.contract_id}@${w.current_version}`) ?? 'draft';
    const waitingOn = consumes.filter((w) => !unblocks(stateOf(w))).map((w) => w.key as string);

    const files = j<string[]>(m.files_json, []);
    const filesPresent = root ? files.filter((f) => existsSync(join(root, f))).length : 0;
    const assignee = claims.get(m.id) ?? null;

    const touchedByCr = [...consumes, ...provides].some((w) => openCr.has(w.contract_id));
    const hasBlockingFinding = blockingByModule.has(m.id);

    let status: ModuleStatus;
    let reason: string;

    if (m.manual_status === 'orphaned') {
      status = 'orphaned';
      reason = 'this module is no longer in the current plan, but somebody has claimed it';
    } else if (m.manual_status) {
      status = m.manual_status as ModuleStatus;
      reason = 'asserted by a person, not derived from evidence';
    } else if (touchedByCr || hasBlockingFinding) {
      status = 'blocked';
      reason = touchedByCr
        ? 'a contract this module uses has an open change request'
        : 'the last dependency check raised a blocking finding against it';
    } else if (waitingOn.length > 0) {
      status = 'planned';
      reason = `waiting for ${waitingOn.join(', ')} to lock`;
    } else if (files.length > 0 && filesPresent === files.length && provides.length > 0) {
      status = 'contract_met';
      reason = 'every declared file exists and its contracts are locked';
    } else if (assignee) {
      status = 'building';
      reason = `claimed by ${assignee}`;
    } else {
      status = 'ready';
      reason = consumes.length === 0
        ? 'depends on nothing — startable immediately'
        : 'everything it consumes is locked';
    }

    return {
      id: m.id, slug: m.slug, name: m.name, lane: m.lane, kind: m.kind,
      summary: m.summary ?? '', est_size: m.est_size ?? 'M',
      files,
      acceptance: j<string[]>(m.acceptance_json, []),
      responsibilities: j<string[]>(m.responsibilities_json, []),
      non_goals: j<string[]>(m.non_goals_json, []),
      provides: provides.map((w) => w.key as string),
      consumes: consumes.map((w) => w.key as string),
      waitingOn, status, asserted: Boolean(m.manual_status) && m.manual_status !== 'orphaned',
      reason, assignee, filesPresent, filesTotal: files.length,
    };
  });
}

/**
 * The "lock this next" ranking: which unlocked contract, once locked, would move
 * the most modules into Ready.
 */
export function unblockRanking(projectId: string) {
  const derived = deriveAll(projectId);
  const counts = new Map<string, number>();
  for (const m of derived) {
    for (const key of m.waitingOn) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, blocks]) => ({ key, blocks }))
    .sort((a, b) => b.blocks - a.blocks);
}

export interface NextActions {
  /** Modules startable right now — depend on nothing unlocked. */
  ready: DerivedModule[];
  /** Unlocked contracts ranked by how many modules they'd unblock, most first. */
  lockNext: { key: string; blocks: number }[];
  /** The longest chain of dependent, unfinished modules. */
  criticalPath: string[];
}

/**
 * "What can I start right now, what should be locked next, what's on the
 * critical path" — the one call `spark_next` exists to make possible. Composes
 * the three functions above; no new derivation logic lives here.
 */
export function nextActions(projectId: string): NextActions {
  return {
    ready: deriveAll(projectId).filter((m) => m.status === 'ready'),
    lockNext: unblockRanking(projectId).slice(0, 5),
    criticalPath: criticalPath(projectId),
  };
}

/** Longest chain of dependent, not-yet-finished modules. */
export function criticalPath(projectId: string): string[] {
  const derived = deriveAll(projectId);
  const bySlug = new Map(derived.map((m) => [m.slug, m]));
  const providerOf = new Map<string, string>();
  for (const m of derived) for (const key of m.provides) providerOf.set(key, m.slug);

  const done = (m: DerivedModule) => m.status === 'completed' || m.status === 'contract_met';
  const memo = new Map<string, string[]>();

  const walk = (slug: string, seen: Set<string>): string[] => {
    if (memo.has(slug)) return memo.get(slug)!;
    if (seen.has(slug)) return [];
    seen.add(slug);
    const m = bySlug.get(slug);
    if (!m || done(m)) return [];
    let best: string[] = [];
    for (const key of m.consumes) {
      const dep = providerOf.get(key);
      if (!dep) continue;
      const chain = walk(dep, new Set(seen));
      if (chain.length > best.length) best = chain;
    }
    const path = [...best, slug];
    memo.set(slug, path);
    return path;
  };

  let longest: string[] = [];
  for (const m of derived) {
    const p = walk(m.slug, new Set());
    if (p.length > longest.length) longest = p;
  }
  return longest;
}
