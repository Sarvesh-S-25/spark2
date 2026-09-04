import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, extname } from 'node:path';
import { db, uid, now, j } from '../db/db.js';
import { zContractSpec, type ContractSpec } from '../contracts/spec.js';
import { specHash } from '../contracts/build.js';
import { readBanner } from '../generate/pack.js';

/**
 * The dependency checker.
 *
 * Three levels, cheapest first. Every finding has a stable code and a fix hint,
 * because a checker that says "something is wrong" is a checker people turn off.
 *
 *   L1 graph   — pure SQL over the module/contract join. Milliseconds.
 *   L2 drift   — hash comparison between contract, generated consumer stub and
 *                generated provider stub. No parsing.
 *   L3 code    — does the repo actually match what the contract promised.
 *
 * L3 here is a text scan, not a parse. It catches the failure everyone actually
 * hits — the backend "finished" the route but at a different path — and it is
 * honest about its limits: it reports at `warn` where a parser would say `block`.
 * Swapping in tree-sitter is a change to this file only.
 */

export type Level = 1 | 2 | 3;

export interface Finding {
  severity: 'block' | 'warn' | 'info';
  code: string;
  level: Level;
  moduleId?: string | null;
  contractId?: string | null;
  subject: string;
  message: string;
  fixHint: string;
}

export interface CheckResult {
  checkRunId: string;
  root: string | null;
  levels: Level[];
  findings: Finding[];
  counts: { block: number; warn: number; info: number };
}

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs', '.vue', '.svelte']);

export function runCheck(projectId: string, levels: Level[] = [1, 2, 3]): CheckResult {
  const conn = db();
  const project = conn.prepare('SELECT id, name, root_path FROM project WHERE id = ?')
    .get(projectId) as { id: string; name: string; root_path: string | null } | undefined;
  if (!project) throw new Error('project not found');

  const root = project.root_path ? resolve(process.cwd(), project.root_path) : null;
  const findings: Finding[] = [];

  if (levels.includes(1)) findings.push(...level1(projectId));
  if (levels.includes(2)) findings.push(...level2(projectId, root));
  if (levels.includes(3)) findings.push(...level3(projectId, root));

  const runId = uid('chk');
  conn.transaction(() => {
    conn.prepare(`INSERT INTO check_run (id, project_id, levels, started_at, finished_at, summary_json)
                  VALUES (?,?,?,?,?,?)`)
      .run(runId, projectId, levels.join(','), now(), now(), JSON.stringify({ total: findings.length }));
    for (const f of findings) {
      conn.prepare(`INSERT INTO finding (id, check_run_id, severity, code, module_id, contract_id, message, fix_hint)
                    VALUES (?,?,?,?,?,?,?,?)`)
        .run(uid('fnd'), runId, f.severity, f.code, f.moduleId ?? null, f.contractId ?? null, f.message, f.fixHint);
    }
  })();

  return {
    checkRunId: runId,
    root,
    levels,
    findings,
    counts: {
      block: findings.filter((f) => f.severity === 'block').length,
      warn: findings.filter((f) => f.severity === 'warn').length,
      info: findings.filter((f) => f.severity === 'info').length,
    },
  };
}

// ── Level 1 · graph ──────────────────────────────────────────────────────────

function level1(projectId: string): Finding[] {
  const conn = db();
  const out: Finding[] = [];

  const contracts = conn.prepare('SELECT * FROM contract WHERE project_id = ?').all(projectId) as any[];
  const modules = conn.prepare('SELECT * FROM module WHERE project_id = ?').all(projectId) as any[];
  const wiring = conn.prepare(`
    SELECT mc.role, mc.module_id, mc.contract_id, m.slug, m.lane, c.key, c.kind
    FROM module_contract mc
    JOIN module m ON m.id = mc.module_id
    JOIN contract c ON c.id = mc.contract_id
    WHERE m.project_id = ?`).all(projectId) as any[];

  const specs = new Map<string, ContractSpec>();
  for (const row of conn.prepare(`
      SELECT cv.contract_id, cv.spec_json FROM contract_version cv
      JOIN contract c ON c.id = cv.contract_id
      WHERE c.project_id = ? AND cv.semver = c.current_version`).all(projectId) as any[]) {
    specs.set(row.contract_id, j<ContractSpec>(row.spec_json, {} as ContractSpec));
  }

  for (const c of contracts) {
    const provides = wiring.filter((w) => w.contract_id === c.id && w.role === 'provides');
    const consumes = wiring.filter((w) => w.contract_id === c.id && w.role === 'consumes');
    const direction = specs.get(c.id)?.direction ?? 'shared';

    if (provides.length === 0) {
      out.push({
        severity: 'block', code: 'ORPHAN_CONTRACT', level: 1, contractId: c.id, subject: c.key,
        message: `"${c.key}" is consumed by ${consumes.map((w) => w.slug).join(', ') || 'nothing'} but no module provides it`,
        fixHint: 'Every contract needs exactly one owner. Assign a providing module, or delete the contract.',
      });
    }
    if (consumes.length === 0 && provides.length > 0 && direction !== 'device_to_server') {
      out.push({
        severity: 'warn', code: 'DEAD_CONTRACT', level: 1, contractId: c.id, subject: c.key,
        message: `"${c.key}" is provided by ${provides[0].slug} but nothing consumes it`,
        fixHint: 'Either a consumer is missing, or this boundary is speculative. Speculative contracts cost real coordination — drop it until something needs it.',
      });
    }

    // Lane leak: a frontend module reaching for a server-internal boundary.
    for (const w of consumes) {
      if (w.lane === 'frontend' && direction === 'server_internal') {
        out.push({
          severity: 'block', code: 'LANE_LEAK', level: 1, contractId: c.id, moduleId: w.module_id,
          subject: `${w.slug} → ${c.key}`,
          message: `frontend module ${w.slug} consumes the server-internal contract "${c.key}"`,
          fixHint: 'Server internals are not a public surface. Add an http contract that exposes what the frontend actually needs.',
        });
      }
    }
  }

  // Unowned modules that are ready to be picked up.
  const claimed = new Set((conn.prepare('SELECT module_id FROM claim').all() as any[]).map((r) => r.module_id));
  for (const m of modules) {
    if (claimed.has(m.id)) continue;
    const consumes = wiring.filter((w) => w.module_id === m.id && w.role === 'consumes');
    if (consumes.length === 0) {
      out.push({
        severity: 'info', code: 'UNOWNED_MODULE', level: 1, moduleId: m.id, subject: m.slug,
        message: `${m.slug} depends on nothing and nobody has claimed it`,
        fixHint: 'This is free parallelism sitting on the table. Assign it.',
      });
    }
  }

  // Cycles over provider → consumer edges.
  const cycle = findCycle(modules, wiring);
  if (cycle) {
    out.push({
      severity: 'block', code: 'CYCLE', level: 1, subject: cycle.join(' → '),
      message: `circular dependency: ${cycle.join(' → ')}`,
      fixHint: 'SparkX will not break this for you — which side owns the boundary is a design decision. Invert one edge, or extract a module both depend on.',
    });
  }

  return out;
}

function findCycle(modules: any[], wiring: any[]): string[] | null {
  const providerOf = new Map<string, string>();
  for (const w of wiring) if (w.role === 'provides') providerOf.set(w.contract_id, w.slug);

  const edges = new Map<string, Set<string>>();
  for (const m of modules) edges.set(m.slug, new Set());
  for (const w of wiring) {
    if (w.role !== 'consumes') continue;
    const provider = providerOf.get(w.contract_id);
    if (provider && provider !== w.slug) edges.get(w.slug)?.add(provider);
  }

  const colour = new Map<string, number>();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    colour.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (colour.get(next) === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (!colour.has(next)) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    colour.set(node, 2);
    return null;
  };
  for (const m of modules) {
    if (!colour.has(m.slug)) {
      const found = visit(m.slug);
      if (found) return found;
    }
  }
  return null;
}

// ── Level 2 · drift ──────────────────────────────────────────────────────────

function level2(projectId: string, root: string | null): Finding[] {
  const conn = db();
  const out: Finding[] = [];

  const versions = conn.prepare(`
    SELECT c.id AS contract_id, c.key, cv.semver, cv.state, cv.spec_json, cv.spec_hash
    FROM contract c
    JOIN contract_version cv ON cv.contract_id = c.id AND cv.semver = c.current_version
    WHERE c.project_id = ?`).all(projectId) as any[];

  const hashByKey = new Map<string, string>();

  for (const v of versions) {
    hashByKey.set(v.key, v.spec_hash);

    // Was a locked spec edited outside SparkX?
    const parsed = zContractSpec.safeParse(j(v.spec_json, {}));
    if (parsed.success) {
      const recomputed = specHash(parsed.data);
      if (recomputed !== v.spec_hash && (v.state === 'locked' || v.state === 'deprecated')) {
        out.push({
          severity: 'block', code: 'CONTRACT_TAMPERED', level: 2, contractId: v.contract_id, subject: v.key,
          message: `locked contract "${v.key}@${v.semver}" no longer hashes to its recorded value`,
          fixHint: 'A locked contract changed without a change request. Restore it, or open a change request retroactively so consumers find out.',
        });
      }
    }

    // Multiple majors still in play past a migration window.
    const majors = new Set(
      (conn.prepare(`SELECT semver FROM contract_version WHERE contract_id = ? AND state IN ('locked','deprecated')`)
        .all(v.contract_id) as any[]).map((r) => String(r.semver).split('.')[0]),
    );
    if (majors.size > 1) {
      out.push({
        severity: 'warn', code: 'VERSION_SKEW', level: 2, contractId: v.contract_id, subject: v.key,
        message: `"${v.key}" has ${majors.size} major versions live at once (${[...majors].join(', ')})`,
        fixHint: 'Fine during a migration window, a problem after it. Move the last consumer over and deprecate the old major.',
      });
    }
  }

  if (!root || !existsSync(root)) return out;

  // Compare every generated file's banner against the current contract.
  for (const file of walk(root)) {
    const rel = relative(root, file);
    if (!rel.includes(`spark${sep()}`) && !rel.startsWith('.spark')) continue;
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch { continue; }

    const banner = readBanner(content);
    if (!banner) continue;

    if (banner.declared !== banner.actual) {
      out.push({
        severity: 'block', code: 'GENERATED_EDITED', level: 2, subject: rel,
        message: `${rel} was edited by hand after it was generated`,
        fixHint: 'Regeneration will erase this. Move the code out of the spark/ directory, then regenerate.',
      });
    }

    const m = /contract:\s+(\S+)@(\S+)/.exec(content);
    const specLine = /spec-hash:\s+(\S+)/.exec(content);
    if (m && specLine) {
      const current = hashByKey.get(m[1]);
      if (current && current !== specLine[1]) {
        out.push({
          severity: 'block', code: 'CONTRACT_DRIFT', level: 2, subject: rel,
          message: `${rel} was generated from an older version of "${m[1]}"`,
          fixHint: 'Regenerate. Until you do, one side of this boundary is building against a contract the other side has moved on from.',
        });
      }
    }
  }

  return out;
}

// ── Level 3 · code reality (text scan) ───────────────────────────────────────

function level3(projectId: string, root: string | null): Finding[] {
  const conn = db();
  const out: Finding[] = [];
  if (!root || !existsSync(root)) {
    return [{
      severity: 'info', code: 'NO_WORKSPACE', level: 3, subject: root ?? '(unset)',
      message: 'level 3 skipped — this project has no source directory on disk yet',
      fixHint: 'Generate the contracts first, or point the project at your repo in Settings.',
    }];
  }

  const contracts = conn.prepare(`
    SELECT c.id, c.key, c.kind, cv.spec_json FROM contract c
    JOIN contract_version cv ON cv.contract_id = c.id AND cv.semver = c.current_version
    WHERE c.project_id = ?`).all(projectId) as any[];

  const handwritten = walk(root).filter((f) => {
    const rel = relative(root, f);
    return SOURCE_EXT.has(extname(f))
      && !rel.includes('node_modules')
      && !rel.includes(`spark${sep()}`)
      && !rel.startsWith('.spark');
  });

  const corpus = handwritten.map((f) => ({ rel: relative(root, f), text: safeRead(f) }));
  const declaredPaths = new Set<string>();

  for (const c of contracts) {
    const spec = j<ContractSpec>(c.spec_json, {} as ContractSpec);
    if (c.kind !== 'http' && c.kind !== 'config') continue;
    const path = spec.transport?.path ?? '';
    if (!path) continue;
    declaredPaths.add(normalizePath(path));

    const literal = path.replace(/:[A-Za-z0-9_]+/g, '');
    const found = corpus.some((f) => f.text.includes(literal.replace(/\/$/, '')));
    if (!found) {
      out.push({
        severity: 'warn', code: 'MISSING_IMPL', level: 3, contractId: c.id, subject: c.key,
        message: `no handwritten file mentions "${path}" — "${c.key}" looks unimplemented`,
        fixHint: 'Implement the route and mount the generated router, or mark the module as still building.',
      });
    }
  }

  // Endpoints the code calls that no contract covers.
  const seen = new Set<string>();
  for (const file of corpus) {
    for (const match of file.text.matchAll(/['"`](\/api\/[A-Za-z0-9_\-/${}:.]*)['"`]/g)) {
      const raw = normalizePath(match[1]);
      if (declaredPaths.has(raw) || seen.has(raw)) continue;
      seen.add(raw);
      out.push({
        severity: 'warn', code: 'UNDECLARED_CALL', level: 3, subject: raw,
        message: `${file.rel} calls "${match[1]}", which no contract covers`,
        fixHint: 'This is a seam nobody wrote down — the most valuable kind of finding. Turn it into a contract before the two sides drift.',
      });
    }
  }

  // Stubs left behind in modules people have called done.
  const asserted = conn.prepare(
    `SELECT id, slug, files_json FROM module WHERE project_id = ? AND manual_status = 'completed'`,
  ).all(projectId) as any[];
  for (const m of asserted) {
    for (const rel of j<string[]>(m.files_json, [])) {
      const abs = join(root, rel);
      if (!existsSync(abs)) {
        out.push({
          severity: 'block', code: 'MISSING_FILE', level: 3, moduleId: m.id, subject: `${m.slug} · ${rel}`,
          message: `${m.slug} is marked completed but ${rel} does not exist`,
          fixHint: 'Either the file moved and the module record needs updating, or "completed" was optimistic.',
        });
        continue;
      }
      const text = safeRead(abs);
      if (/NotImplemented|TODO: implement|raise NotImplementedError/.test(text)) {
        out.push({
          severity: 'block', code: 'STUB_REMAINING', level: 3, moduleId: m.id, subject: `${m.slug} · ${rel}`,
          message: `${rel} still throws NotImplemented but ${m.slug} is marked completed`,
          fixHint: 'Finish the handler, or drop the completed assertion.',
        });
      }
    }
  }

  return out;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const sep = () => (process.platform === 'win32' ? '\\' : '/');

const normalizePath = (p: string) =>
  p.replace(/:[A-Za-z0-9_]+/g, ':x').replace(/\$\{[^}]*\}/g, ':x').replace(/\/+$/, '');

function safeRead(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv']);

function walk(dir: string, depth = 0): string[] {
  if (depth > 8) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch { continue; }
    if (st.isDirectory()) out.push(...walk(full, depth + 1));
    else out.push(full);
  }
  return out;
}
