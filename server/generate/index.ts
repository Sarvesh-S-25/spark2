import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { db, j } from '../db/db.js';
import { generates } from '../contracts/state.js';
import { zContractSpec, type ContractSpec, type ContractExample } from '../contracts/spec.js';
import { tsReactFetch, tsClientIndex } from './packs/tsReactFetch.js';
import { nodeExpress, nodeRoutesIndex } from './packs/nodeExpress.js';
import { pythonFastapi } from './packs/pythonFastapi.js';
import { toOpenApi } from './openapi.js';
import type { GenContract, GenFile, LanguagePack } from './pack.js';

export const PACKS: Record<string, LanguagePack> = {
  [tsReactFetch.id]: tsReactFetch,
  [nodeExpress.id]: nodeExpress,
  [pythonFastapi.id]: pythonFastapi,
};

export interface GenerateOptions {
  projectId: string;
  packs: string[];
  /** Draft contracts do not generate by default — they are not agreed yet. */
  includeDrafts?: boolean;
  /** Preview without touching the disk. */
  dryRun?: boolean;
}

export interface GenerateResult {
  root: string;
  written: { path: string; bytes: number }[];
  skipped: string[];
  contracts: number;
  message: string;
}

/** Loads every contract in a project in the shape the packs consume. */
export function loadGenContracts(projectId: string, includeDrafts = false): GenContract[] {
  const rows = db().prepare(`
    SELECT c.key, c.kind, cv.semver, cv.state, cv.spec_json, cv.examples_json, cv.spec_hash
    FROM contract c
    JOIN contract_version cv ON cv.contract_id = c.id AND cv.semver = c.current_version
    WHERE c.project_id = ?
    ORDER BY c.key`).all(projectId) as any[];

  return rows
    .filter((r) => generates(r.state) || (includeDrafts && r.state === 'draft'))
    .map((r) => {
      const parsed = zContractSpec.safeParse(j<ContractSpec>(r.spec_json, {} as ContractSpec));
      return {
        key: r.key,
        kind: r.kind,
        semver: r.semver,
        state: r.state,
        hash: r.spec_hash,
        spec: parsed.success ? parsed.data : (j<ContractSpec>(r.spec_json, {} as ContractSpec)),
        examples: j<ContractExample[]>(r.examples_json, []),
      };
    });
}

export function generate(opts: GenerateOptions): GenerateResult {
  const project = db().prepare('SELECT id, name, root_path FROM project WHERE id = ?')
    .get(opts.projectId) as { id: string; name: string; root_path: string | null } | undefined;
  if (!project) throw new Error('project not found');

  const root = resolve(process.cwd(), project.root_path || join('workspace', slug(project.name)));
  const contracts = loadGenContracts(opts.projectId, opts.includeDrafts);

  if (contracts.length === 0) {
    return {
      root, written: [], skipped: [], contracts: 0,
      message: 'Nothing generated: every contract is still a draft. Move contracts to proposed or locked first, or generate with drafts included.',
    };
  }

  const files: GenFile[] = [];
  for (const packId of opts.packs) {
    const pack = PACKS[packId];
    if (!pack) continue;
    files.push(...pack.emitRuntime());
    files.push(...pack.emitTypes(contracts));
    for (const c of contracts) {
      files.push(...pack.emitClient(c));
      files.push(...pack.emitMocks(c));
      files.push(...pack.emitServerStub(c));
      files.push(...pack.emitContractTest(c));
    }
    if (packId === tsReactFetch.id) files.push(tsClientIndex(contracts));
    if (packId === nodeExpress.id) files.push(nodeRoutesIndex(contracts));
  }

  files.push({
    path: 'openapi.json',
    content: JSON.stringify(toOpenApi(contracts, project.name), null, 2) + '\n',
  });

  files.push(...sparkDirFiles(opts.projectId, project.name, contracts));

  const written: GenerateResult['written'] = [];
  const skipped: string[] = [];

  if (!opts.dryRun) {
    for (const f of files) {
      const target = join(root, f.path);
      mkdirSync(dirname(target), { recursive: true });
      // Never clobber a file whose content is already identical — it keeps
      // file mtimes stable so editors and watchers stay quiet.
      if (existsSync(target) && readFileSync(target, 'utf8') === f.content) {
        skipped.push(f.path);
        continue;
      }
      writeFileSync(target, f.content, 'utf8');
      written.push({ path: f.path, bytes: Buffer.byteLength(f.content) });
    }
  }

  return {
    root,
    written: opts.dryRun ? files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content) })) : written,
    skipped,
    contracts: contracts.length,
    message: opts.dryRun
      ? `${files.length} files would be written to ${root}`
      : `${written.length} files written, ${skipped.length} already current`,
  };
}

/**
 * The `.spark/` directory — the repo *is* the sync channel between teammates.
 *
 * One file per module and per contract version, plus an append-friendly plan
 * folder. A single big manifest would conflict on every parallel edit, which is
 * precisely the pain this product claims to solve.
 */
function sparkDirFiles(projectId: string, projectName: string, contracts: GenContract[]): GenFile[] {
  const conn = db();
  const files: GenFile[] = [];

  const modules = conn.prepare('SELECT * FROM module WHERE project_id = ? ORDER BY slug').all(projectId) as any[];
  const wiring = conn.prepare(`
    SELECT mc.role, m.slug, c.key FROM module_contract mc
    JOIN module m ON m.id = mc.module_id
    JOIN contract c ON c.id = mc.contract_id
    WHERE m.project_id = ?`).all(projectId) as any[];

  files.push({
    path: '.spark/project.json',
    content: JSON.stringify({
      name: projectName,
      generatedAt: null, // deliberately omitted: a timestamp would churn the diff on every run
      lanes: ['frontend', 'backend', 'shared', 'infra'],
      moduleCount: modules.length,
      contractCount: contracts.length,
    }, null, 2) + '\n',
  });

  for (const m of modules) {
    files.push({
      path: `.spark/modules/${m.slug}.json`,
      content: JSON.stringify({
        slug: m.slug, name: m.name, lane: m.lane, kind: m.kind, summary: m.summary,
        responsibilities: j<string[]>(m.responsibilities_json, []),
        non_goals: j<string[]>(m.non_goals_json, []),
        files: j<string[]>(m.files_json, []),
        acceptance: j<string[]>(m.acceptance_json, []),
        est_size: m.est_size,
        provides: wiring.filter((w) => w.slug === m.slug && w.role === 'provides').map((w) => w.key),
        consumes: wiring.filter((w) => w.slug === m.slug && w.role === 'consumes').map((w) => w.key),
      }, null, 2) + '\n',
    });
  }

  for (const c of contracts) {
    files.push({
      path: `.spark/contracts/${c.key}@${c.semver}.json`,
      content: JSON.stringify({
        key: c.key, kind: c.kind, semver: c.semver, state: c.state,
        spec: c.spec, examples: c.examples, spec_hash: c.hash,
      }, null, 2) + '\n',
    });
  }

  const plans = conn.prepare('SELECT n, body_md FROM plan_revision WHERE project_id = ? ORDER BY n')
    .all(projectId) as any[];
  for (const p of plans) {
    files.push({
      path: `.spark/plan/${String(p.n).padStart(3, '0')}.md`,
      content: p.body_md.endsWith('\n') ? p.body_md : p.body_md + '\n',
    });
  }

  return files;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
