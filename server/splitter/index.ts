import { db, uid, now, j } from '../db/db.js';
import { runPass } from '../models/harness.js';
import {
  zPassA, zPassB, zPassC,
  PASS_A_JSON_SCHEMA, PASS_B_JSON_SCHEMA, PASS_C_JSON_SCHEMA,
  type Capability, type Seam, type SplitModule,
} from './schemas.js';
import {
  PASS_A_SYSTEM, PASS_B_SYSTEM, PASS_C_SYSTEM,
  passAUser, passBUser, passCUser,
} from './prompts.js';
import { validateSplit, type SplitIssue } from './validate.js';
import { seamToSpec, specHash } from '../contracts/build.js';

export interface SplitResult {
  ok: boolean;
  planRevisionId: string | null;
  capabilities: Capability[];
  seams: Seam[];
  modules: SplitModule[];
  issues: SplitIssue[];
  fixes: string[];
  passes: { pass: string; provider: string; model: string; ok: boolean; cached: boolean; repairs: number; latencyMs: number; costUsd: number; errors: string[] }[];
  totalCostUsd: number;
  totalLatencyMs: number;
}

/**
 * Brief in, module graph out.
 *
 * The three passes run in order because each needs the last one's output. What
 * happens either side of them is the part that makes the result trustworthy:
 * `validateSplit` reports the truth about what the model produced, and
 * `normalize` then mechanically repairs the subset of problems that have one
 * obvious correct fix, recording each repair so nothing happens silently.
 */
export async function runSplit(opts: {
  projectId: string;
  brief: string;
  source?: string;
}): Promise<SplitResult> {
  const { projectId, brief } = opts;
  const passes: SplitResult['passes'] = [];
  const record = (pass: string, r: { ok: boolean; errors: string[]; meta: any }) =>
    passes.push({
      pass, ok: r.ok, errors: r.errors,
      provider: r.meta.provider, model: r.meta.model, cached: r.meta.cached,
      repairs: r.meta.repairs, latencyMs: r.meta.latencyMs, costUsd: r.meta.costUsd,
    });

  const empty = (issues: SplitIssue[]): SplitResult => ({
    ok: false, planRevisionId: null, capabilities: [], seams: [], modules: [],
    issues, fixes: [], passes,
    totalCostUsd: passes.reduce((n, p) => n + p.costUsd, 0),
    totalLatencyMs: passes.reduce((n, p) => n + p.latencyMs, 0),
  });

  // ── Pass A ─────────────────────────────────────────────────────────────────
  const a = await runPass({
    pass: 'A', purpose: 'pass:A', projectId,
    system: PASS_A_SYSTEM, user: passAUser(brief),
    schema: PASS_A_JSON_SCHEMA, schemaName: 'pass_a', zod: zPassA,
    context: { brief },
  });
  record('A · capabilities', a);
  if (!a.ok || !a.data) {
    return empty([{
      code: 'UNKNOWN_CONTRACT', severity: 'block',
      message: `Pass A failed: ${a.errors.join('; ') || 'no response'}`,
      fixHint: 'Check the provider in Settings. With no key configured, set SPARK_PROVIDER=fake to use the offline planner.',
    }]);
  }
  const capabilities = a.data.capabilities;

  // ── Pass B ─────────────────────────────────────────────────────────────────
  const b = await runPass({
    pass: 'B', purpose: 'pass:B', projectId,
    system: PASS_B_SYSTEM, user: passBUser(brief, capabilities),
    schema: PASS_B_JSON_SCHEMA, schemaName: 'pass_b', zod: zPassB,
    context: { brief, capabilities },
  });
  record('B · seams', b);
  if (!b.ok || !b.data) {
    return empty([{
      code: 'UNKNOWN_CONTRACT', severity: 'block',
      message: `Pass B failed: ${b.errors.join('; ') || 'no response'}`,
      fixHint: 'Pass B is the hard one. If you are on a small local model, route just this pass to a cloud key with SPARK_PROVIDER_PASS_B.',
    }]);
  }
  const seams = dedupeBy(b.data.seams, (s) => s.key);

  // ── Pass C ─────────────────────────────────────────────────────────────────
  const c = await runPass({
    pass: 'C', purpose: 'pass:C', projectId,
    system: PASS_C_SYSTEM, user: passCUser(brief, capabilities, seams),
    schema: PASS_C_JSON_SCHEMA, schemaName: 'pass_c', zod: zPassC,
    context: { brief, capabilities, seams },
  });
  record('C · modules', c);
  if (!c.ok || !c.data) {
    return empty([{
      code: 'UNKNOWN_CONTRACT', severity: 'block',
      message: `Pass C failed: ${c.errors.join('; ') || 'no response'}`,
      fixHint: 'The seams survived — you can still edit them by hand and assign modules yourself.',
    }]);
  }

  // Report the truth first, repair second.
  const rawModules = c.data.modules;
  const issues = validateSplit({ capabilities, seams, modules: rawModules });
  const { modules, fixes } = normalize(rawModules, seams);

  const planRevisionId = persist({ projectId, brief, source: opts.source ?? 'pasted', capabilities, seams, modules });

  return {
    ok: !issues.some((i) => i.severity === 'block'),
    planRevisionId, capabilities, seams, modules, issues, fixes, passes,
    totalCostUsd: passes.reduce((n, p) => n + p.costUsd, 0),
    totalLatencyMs: passes.reduce((n, p) => n + p.latencyMs, 0),
  };
}

function dedupeBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    const k = key(it);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Mechanical repairs, each one recorded.
 *
 * Only fixes with exactly one correct answer live here. Anything requiring a
 * judgement call — breaking a dependency cycle, deciding which of two modules
 * should own a boundary — is left as a reported issue for a person.
 */
function normalize(modules: SplitModule[], seams: Seam[]): { modules: SplitModule[]; fixes: string[] } {
  const fixes: string[] = [];
  const keys = new Set(seams.map((s) => s.key));
  const lanePrefix: Record<string, string> = { frontend: 'fe', backend: 'be', shared: 'sh', infra: 'infra' };

  const bySlug = new Map<string, SplitModule>();
  const claimedProvider = new Map<string, string>();
  const out: SplitModule[] = [];

  for (const m of modules) {
    // Slug hygiene: lane-prefixed, unique.
    let slug = m.slug.trim().toLowerCase().replace(/\s+/g, '-');
    const prefix = lanePrefix[m.lane];
    if (!slug.startsWith(prefix + '.')) {
      const fixed = `${prefix}.${slug.replace(/^(fe|be|sh|infra)\./, '')}`;
      fixes.push(`renamed ${m.slug} → ${fixed} (slugs are lane-prefixed)`);
      slug = fixed;
    }
    if (bySlug.has(slug)) {
      const merged = `${slug}-2`;
      fixes.push(`renamed duplicate slug ${slug} → ${merged}`);
      slug = merged;
    }

    const provides: string[] = [];
    for (const key of dedupeBy(m.provides, (k) => k)) {
      if (!keys.has(key)) {
        fixes.push(`dropped "${key}" from ${slug}.provides — no such seam`);
        continue;
      }
      const already = claimedProvider.get(key);
      if (already) {
        fixes.push(`dropped "${key}" from ${slug}.provides — ${already} already provides it`);
        continue;
      }
      claimedProvider.set(key, slug);
      provides.push(key);
    }

    const consumes: string[] = [];
    for (const key of dedupeBy(m.consumes, (k) => k)) {
      if (!keys.has(key)) {
        fixes.push(`dropped "${key}" from ${slug}.consumes — no such seam`);
        continue;
      }
      if (provides.includes(key)) continue; // a module does not consume itself
      consumes.push(key);
    }

    const fixed: SplitModule = { ...m, slug, provides, consumes };
    bySlug.set(slug, fixed);
    out.push(fixed);
  }

  return { modules: out, fixes };
}

// ── persistence ──────────────────────────────────────────────────────────────

/**
 * Writes a split into the database.
 *
 * Two rules a re-split must obey, both implemented here:
 *   • A locked contract version is never touched. A new plan revision can
 *     propose changes but cannot silently rewrite something people are already
 *     building against.
 *   • A module that someone has claimed is never deleted. It is marked orphaned
 *     for a human to decide about.
 */
function persist(x: {
  projectId: string;
  brief: string;
  source: string;
  capabilities: Capability[];
  seams: Seam[];
  modules: SplitModule[];
}): string {
  const conn = db();
  const at = now();

  return conn.transaction(() => {
    const lastN = (conn.prepare('SELECT MAX(n) AS n FROM plan_revision WHERE project_id = ?')
      .get(x.projectId) as { n: number | null }).n ?? 0;
    const planId = uid('plan');
    conn.prepare(`INSERT INTO plan_revision (id, project_id, n, source, body_md, capabilities_json, created_at)
                  VALUES (?,?,?,?,?,?,?)`)
      .run(planId, x.projectId, lastN + 1, x.source, x.brief, JSON.stringify(x.capabilities), at);

    // ── modules: upsert by slug ──────────────────────────────────────────────
    const existing = conn.prepare('SELECT id, slug FROM module WHERE project_id = ?')
      .all(x.projectId) as { id: string; slug: string }[];
    const idBySlug = new Map(existing.map((r) => [r.slug, r.id]));
    const keepSlugs = new Set(x.modules.map((m) => m.slug));

    for (const m of x.modules) {
      const id = idBySlug.get(m.slug) ?? uid('mod');
      if (idBySlug.has(m.slug)) {
        conn.prepare(`UPDATE module SET plan_revision_id=?, name=?, lane=?, kind=?, summary=?,
          responsibilities_json=?, non_goals_json=?, files_json=?, acceptance_json=?, est_size=?
          WHERE id=?`).run(
          planId, m.name, m.lane, m.kind, m.summary,
          JSON.stringify(m.responsibilities), JSON.stringify(m.non_goals),
          JSON.stringify(m.files), JSON.stringify(m.acceptance), m.est_size, id,
        );
      } else {
        conn.prepare(`INSERT INTO module (id, project_id, plan_revision_id, slug, name, lane, kind,
          summary, responsibilities_json, non_goals_json, files_json, acceptance_json, est_size, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id, x.projectId, planId, m.slug, m.name, m.lane, m.kind, m.summary,
          JSON.stringify(m.responsibilities), JSON.stringify(m.non_goals),
          JSON.stringify(m.files), JSON.stringify(m.acceptance), m.est_size, at,
        );
        idBySlug.set(m.slug, id);
      }
    }

    // Modules that vanished: delete only if nobody has claimed them.
    for (const row of existing) {
      if (keepSlugs.has(row.slug)) continue;
      const claimed = conn.prepare('SELECT 1 FROM claim WHERE module_id = ?').get(row.id);
      if (claimed) {
        conn.prepare('UPDATE module SET manual_status = ? WHERE id = ?').run('orphaned', row.id);
      } else {
        conn.prepare('DELETE FROM module WHERE id = ?').run(row.id);
      }
    }

    // ── contracts ────────────────────────────────────────────────────────────
    for (const seam of x.seams) {
      const { spec, examples } = seamToSpec(seam);
      const hash = specHash(spec);

      let row = conn.prepare('SELECT id, current_version FROM contract WHERE project_id = ? AND key = ?')
        .get(x.projectId, seam.key) as { id: string; current_version: string | null } | undefined;

      if (!row) {
        const cid = uid('con');
        conn.prepare(`INSERT INTO contract (id, project_id, key, kind, current_version, created_at)
                      VALUES (?,?,?,?,?,?)`)
          .run(cid, x.projectId, seam.key, seam.kind, '1.0.0', at);
        conn.prepare(`INSERT INTO contract_version
            (id, contract_id, semver, state, spec_json, examples_json, spec_hash, created_by, created_at)
            VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(uid('cv'), cid, '1.0.0', 'draft', JSON.stringify(spec), JSON.stringify(examples), hash, 'splitter', at);
        row = { id: cid, current_version: '1.0.0' };
      } else {
        // Never overwrite a version that is locked or beyond — people are
        // building against it. Only a draft is safe to refresh in place.
        const cur = conn.prepare(
          'SELECT id, state FROM contract_version WHERE contract_id = ? AND semver = ?',
        ).get(row.id, row.current_version) as { id: string; state: string } | undefined;
        if (cur && cur.state === 'draft') {
          conn.prepare('UPDATE contract_version SET spec_json=?, examples_json=?, spec_hash=? WHERE id=?')
            .run(JSON.stringify(spec), JSON.stringify(examples), hash, cur.id);
        }
      }

      // ── wiring ─────────────────────────────────────────────────────────────
      conn.prepare('DELETE FROM module_contract WHERE contract_id = ?').run(row.id);
      const provider = x.modules.find((m) => m.provides.includes(seam.key));
      if (provider) {
        const mid = idBySlug.get(provider.slug)!;
        conn.prepare('INSERT INTO module_contract (module_id, contract_id, role) VALUES (?,?,?)')
          .run(mid, row.id, 'provides');
        conn.prepare('UPDATE contract SET owner_module_id = ? WHERE id = ?').run(mid, row.id);
      }
      for (const m of x.modules.filter((m) => m.consumes.includes(seam.key))) {
        conn.prepare('INSERT OR IGNORE INTO module_contract (module_id, contract_id, role) VALUES (?,?,?)')
          .run(idBySlug.get(m.slug)!, row.id, 'consumes');
      }
    }

    return planId;
  })();
}

/** Reads a stored split back out in the same shape `runSplit` returns. */
export function loadSplit(projectId: string) {
  const conn = db();
  const modules = conn.prepare('SELECT * FROM module WHERE project_id = ? ORDER BY lane, slug')
    .all(projectId) as any[];
  const contracts = conn.prepare('SELECT * FROM contract WHERE project_id = ? ORDER BY key')
    .all(projectId) as any[];
  const wiring = conn.prepare(`
    SELECT mc.role, m.slug, c.key FROM module_contract mc
    JOIN module m ON m.id = mc.module_id
    JOIN contract c ON c.id = mc.contract_id
    WHERE m.project_id = ?`).all(projectId) as { role: string; slug: string; key: string }[];

  return {
    modules: modules.map((m) => ({
      ...m,
      responsibilities: j<string[]>(m.responsibilities_json, []),
      non_goals: j<string[]>(m.non_goals_json, []),
      files: j<string[]>(m.files_json, []),
      acceptance: j<string[]>(m.acceptance_json, []),
      provides: wiring.filter((w) => w.slug === m.slug && w.role === 'provides').map((w) => w.key),
      consumes: wiring.filter((w) => w.slug === m.slug && w.role === 'consumes').map((w) => w.key),
    })),
    contracts,
    wiring,
  };
}
