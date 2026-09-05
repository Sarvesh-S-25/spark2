import type { FastifyInstance } from 'fastify';
import { db, uid, now, j } from './db/db.js';
import { providerReport } from './models/registry.js';
import { runSplit } from './splitter/index.js';
import { draftPlan } from './splitter/plan.js';
import { deriveAll, unblockRanking, criticalPath } from './status/derive.js';
import { recordStatusEvent } from './status/events.js';
import { generate, PACKS, loadGenContracts } from './generate/index.js';
import { toOpenApi } from './generate/openapi.js';
import { runCheck, type Level } from './deps/check.js';
import { zContractSpec, type ContractSpec, type ContractExample, type ContractState } from './contracts/spec.js';
import { specHash } from './contracts/build.js';
import { diffContracts } from './contracts/diff.js';
import { canTransition } from './contracts/state.js';
import { currentVersion, contractRows, changeRequestRows } from './contracts/rows.js';

/**
 * Every HTTP endpoint SparkX has.
 *
 * The UI is only one client of this API. The CLI and the VS Code extension in
 * the roadmap talk to exactly these endpoints — which is why the server exists
 * as a real HTTP surface in week one rather than as functions the UI imports.
 */
export async function registerApi(app: FastifyInstance): Promise<void> {
  const conn = db();

  // ── health & models ────────────────────────────────────────────────────────

  app.get('/api/health', async () => ({ ok: true, at: now() }));

  app.get('/api/models', async () => providerReport());

  app.get('/api/usage', async (req) => {
    const { projectId } = req.query as { projectId?: string };
    const where = projectId ? 'WHERE project_id = ?' : '';
    const args = projectId ? [projectId] : [];
    const totals = conn.prepare(`
      SELECT COUNT(*) AS runs, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
             SUM(cost_usd) AS cost_usd, SUM(cached) AS cached, SUM(repair_count) AS repairs,
             AVG(latency_ms) AS avg_latency
      FROM model_run ${where}`).get(...args);
    const recent = conn.prepare(`
      SELECT provider, model, purpose, tokens_in, tokens_out, cost_usd, latency_ms, ok, cached, repair_count, created_at
      FROM model_run ${where} ORDER BY created_at DESC LIMIT 25`).all(...args);
    return { totals, recent };
  });

  // ── projects ───────────────────────────────────────────────────────────────

  app.get('/api/projects', async () =>
    conn.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM module m WHERE m.project_id = p.id) AS module_count,
        (SELECT COUNT(*) FROM contract c WHERE c.project_id = p.id) AS contract_count
      FROM project p ORDER BY created_at DESC`).all());

  app.post('/api/projects', async (req, reply) => {
    const { name, rootPath } = req.body as { name?: string; rootPath?: string };
    if (!name?.trim()) return reply.code(400).send({ code: 'NAME_REQUIRED', message: 'A project needs a name.' });
    const id = uid('prj');
    const root = rootPath?.trim() || `workspace/${slugify(name)}`;
    conn.prepare('INSERT INTO project (id, name, root_path, created_at) VALUES (?,?,?,?)')
      .run(id, name.trim(), root, now());
    return conn.prepare('SELECT * FROM project WHERE id = ?').get(id);
  });

  app.patch('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { name, rootPath, repoUrl } = req.body as { name?: string; rootPath?: string; repoUrl?: string };
    if (name) conn.prepare('UPDATE project SET name = ? WHERE id = ?').run(name, id);
    if (rootPath !== undefined) conn.prepare('UPDATE project SET root_path = ? WHERE id = ?').run(rootPath, id);
    if (repoUrl !== undefined) conn.prepare('UPDATE project SET repo_url = ? WHERE id = ?').run(repoUrl, id);
    return conn.prepare('SELECT * FROM project WHERE id = ?').get(id);
  });

  app.delete('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    conn.prepare('DELETE FROM project WHERE id = ?').run(id);
    return { deleted: true };
  });

  /** Everything one screen needs about a project, in one round trip. */
  app.get('/api/projects/:id/overview', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = conn.prepare('SELECT * FROM project WHERE id = ?').get(id);
    if (!project) return reply.code(404).send({ code: 'NOT_FOUND', message: 'No such project.' });

    const plan = conn.prepare(
      'SELECT * FROM plan_revision WHERE project_id = ? ORDER BY n DESC LIMIT 1',
    ).get(id) as any;

    const lastCheck = conn.prepare(
      'SELECT * FROM check_run WHERE project_id = ? ORDER BY started_at DESC LIMIT 1',
    ).get(id) as any;

    return {
      project,
      plan: plan ? { ...plan, capabilities: j(plan.capabilities_json, []) } : null,
      planCount: (conn.prepare('SELECT COUNT(*) AS n FROM plan_revision WHERE project_id = ?').get(id) as any).n,
      modules: deriveAll(id),
      contracts: contractRows(id),
      unblockRanking: unblockRanking(id),
      criticalPath: criticalPath(id),
      changeRequests: changeRequestRows(id),
      lastCheck: lastCheck
        ? { ...lastCheck, findings: conn.prepare('SELECT * FROM finding WHERE check_run_id = ?').all(lastCheck.id) }
        : null,
      packs: Object.values(PACKS).map((p) => ({ id: p.id, label: p.label, lane: p.lane })),
    };
  });

  // ── plan & split ───────────────────────────────────────────────────────────

  app.post('/api/plan/draft', async (req, reply) => {
    const { idea, projectId } = req.body as { idea?: string; projectId?: string };
    if (!idea?.trim()) return reply.code(400).send({ code: 'IDEA_REQUIRED', message: 'Describe the idea first.' });
    return draftPlan({ idea, projectId });
  });

  app.post('/api/projects/:id/split', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { brief, source } = req.body as { brief?: string; source?: string };
    if (!brief?.trim() || brief.trim().length < 20) {
      return reply.code(400).send({
        code: 'BRIEF_TOO_SHORT',
        message: 'Give the splitter something to work with — a sentence or two about what the thing does.',
      });
    }
    return runSplit({ projectId: id, brief, source });
  });

  app.get('/api/projects/:id/plans', async (req) => {
    const { id } = req.params as { id: string };
    return conn.prepare('SELECT id, n, source, body_md, created_at FROM plan_revision WHERE project_id = ? ORDER BY n DESC')
      .all(id);
  });

  // ── modules ────────────────────────────────────────────────────────────────

  app.get('/api/projects/:id/modules', async (req) => deriveAll((req.params as any).id));

  app.post('/api/modules/:id/claim', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { assignee } = req.body as { assignee?: string };
    if (!assignee?.trim()) return reply.code(400).send({ code: 'ASSIGNEE_REQUIRED', message: 'Who is picking this up?' });
    conn.prepare(`INSERT INTO claim (module_id, assignee, claimed_at, last_activity_at) VALUES (?,?,?,?)
                  ON CONFLICT(module_id) DO UPDATE SET assignee = excluded.assignee, last_activity_at = excluded.last_activity_at`)
      .run(id, assignee.trim(), now(), now());
    recordStatusEvent(id, 'building', 'claimed', assignee.trim());
    return { ok: true };
  });

  app.delete('/api/modules/:id/claim', async (req) => {
    const { id } = req.params as { id: string };
    conn.prepare('DELETE FROM claim WHERE module_id = ?').run(id);
    return { ok: true };
  });

  /**
   * The manual status override.
   *
   * It exists because people need an escape hatch. It is recorded with the
   * actor's name and renders as a visibly different badge, so it can never be
   * used invisibly. Send status: null to hand the module back to derivation.
   */
  app.post('/api/modules/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const { status, actor } = req.body as { status?: string | null; actor?: string };
    conn.prepare('UPDATE module SET manual_status = ? WHERE id = ?').run(status ?? null, id);
    recordStatusEvent(id, status ?? 'derived', status ? 'asserted' : 'derived', actor ?? 'someone');
    return { ok: true };
  });

  app.patch('/api/modules/:id', async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown>;
    const map: Record<string, string> = {
      name: 'name', summary: 'summary', lane: 'lane', kind: 'kind', est_size: 'est_size',
    };
    for (const [key, col] of Object.entries(map)) {
      if (b[key] !== undefined) conn.prepare(`UPDATE module SET ${col} = ? WHERE id = ?`).run(b[key], id);
    }
    for (const [key, col] of Object.entries({
      responsibilities: 'responsibilities_json', non_goals: 'non_goals_json',
      files: 'files_json', acceptance: 'acceptance_json',
    })) {
      if (b[key] !== undefined) conn.prepare(`UPDATE module SET ${col} = ? WHERE id = ?`).run(JSON.stringify(b[key]), id);
    }
    return conn.prepare('SELECT * FROM module WHERE id = ?').get(id);
  });

  app.get('/api/modules/:id/events', async (req) =>
    conn.prepare('SELECT * FROM status_event WHERE module_id = ? ORDER BY at DESC').all((req.params as any).id));

  // ── contracts ──────────────────────────────────────────────────────────────

  app.get('/api/projects/:id/contracts', async (req) => contractRows((req.params as any).id));

  app.get('/api/contracts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = conn.prepare('SELECT * FROM contract WHERE id = ?').get(id) as any;
    if (!c) return reply.code(404).send({ code: 'NOT_FOUND', message: 'No such contract.' });
    const versions = conn.prepare('SELECT * FROM contract_version WHERE contract_id = ? ORDER BY created_at').all(id) as any[];
    return {
      ...c,
      versions: versions.map((v) => ({
        ...v, spec: j(v.spec_json, {}), examples: j(v.examples_json, []),
      })),
      wiring: conn.prepare(`
        SELECT mc.role, m.slug, m.lane, m.id AS module_id FROM module_contract mc
        JOIN module m ON m.id = mc.module_id WHERE mc.contract_id = ?`).all(id),
    };
  });

  /** Edit a draft in place. Anything past draft must go through a change request. */
  app.put('/api/contracts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { spec, examples } = req.body as { spec?: unknown; examples?: ContractExample[] };

    const c = conn.prepare('SELECT * FROM contract WHERE id = ?').get(id) as any;
    if (!c) return reply.code(404).send({ code: 'NOT_FOUND', message: 'No such contract.' });
    const cur = currentVersion(id);
    if (!cur) return reply.code(404).send({ code: 'NO_VERSION', message: 'This contract has no version.' });

    if (cur.state !== 'draft') {
      return reply.code(409).send({
        code: 'NOT_A_DRAFT',
        message: `This contract is ${cur.state}. Open a change request instead — people are building against it.`,
      });
    }

    const parsed = zContractSpec.safeParse(spec);
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'SPEC_INVALID',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }

    conn.prepare('UPDATE contract_version SET spec_json = ?, examples_json = ?, spec_hash = ? WHERE id = ?')
      .run(JSON.stringify(parsed.data), JSON.stringify(examples ?? []), specHash(parsed.data), cur.id);
    return { ok: true };
  });

  app.post('/api/contracts/:id/state', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { to } = req.body as { to: ContractState };
    const cur = currentVersion(id);
    if (!cur) return reply.code(404).send({ code: 'NO_VERSION', message: 'This contract has no version.' });

    const wiring = conn.prepare('SELECT role FROM module_contract WHERE contract_id = ?').all(id) as any[];
    const check = canTransition(cur.state as ContractState, to, {
      examples: j<ContractExample[]>(cur.examples_json, []),
      hasProvider: wiring.some((w) => w.role === 'provides'),
      consumerCount: wiring.filter((w) => w.role === 'consumes').length,
    });
    if (!check.ok) return reply.code(409).send({ code: 'ILLEGAL_TRANSITION', message: check.reason });

    conn.prepare('UPDATE contract_version SET state = ?, locked_at = ? WHERE id = ?')
      .run(to, to === 'locked' ? now() : cur.locked_at, cur.id);
    return { ok: true, state: to };
  });

  /** Bulk transition — "propose all drafts", "lock everything that is ready". */
  app.post('/api/projects/:id/contracts/bulk-state', async (req) => {
    const { id } = req.params as { id: string };
    const { from, to } = req.body as { from: ContractState; to: ContractState };
    const rows = contractRows(id).filter((r) => r.state === from);
    const moved: string[] = [];
    const refused: { key: string; reason: string }[] = [];

    for (const row of rows) {
      const cur = currentVersion(row.id);
      if (!cur) continue;
      const wiring = conn.prepare('SELECT role FROM module_contract WHERE contract_id = ?').all(row.id) as any[];
      const check = canTransition(from, to, {
        examples: j<ContractExample[]>(cur.examples_json, []),
        hasProvider: wiring.some((w) => w.role === 'provides'),
        consumerCount: wiring.filter((w) => w.role === 'consumes').length,
      });
      if (!check.ok) {
        refused.push({ key: row.key, reason: check.reason ?? 'refused' });
        continue;
      }
      conn.prepare('UPDATE contract_version SET state = ?, locked_at = ? WHERE id = ?')
        .run(to, to === 'locked' ? now() : cur.locked_at, cur.id);
      moved.push(row.key);
    }
    return { moved, refused };
  });

  // ── change requests: the governance layer ──────────────────────────────────

  /**
   * Propose a new version of a contract.
   *
   * The change class is computed from the schema diff, never declared. Additive
   * and widening changes apply immediately — nobody's code breaks, so nobody
   * should have to wait for a meeting. Breaking changes open a request that
   * every consumer must answer.
   */
  app.post('/api/contracts/:id/change-request', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { spec, examples, reason, actor } = req.body as {
      spec?: unknown; examples?: ContractExample[]; reason?: string; actor?: string;
    };
    if (!reason?.trim()) {
      return reply.code(400).send({ code: 'REASON_REQUIRED', message: 'Say why. Consumers will read this.' });
    }
    const cur = currentVersion(id);
    if (!cur) return reply.code(404).send({ code: 'NO_VERSION', message: 'This contract has no version.' });

    const parsed = zContractSpec.safeParse(spec);
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'SPEC_INVALID',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }

    const before = j<ContractSpec>(cur.spec_json, {} as ContractSpec);
    const diff = diffContracts(before, parsed.data, cur.semver);

    if (diff.reasons.length === 0) {
      return reply.code(400).send({ code: 'NO_CHANGE', message: 'That is identical to the current version.' });
    }

    if (diff.changeClass !== 'breaking') {
      const newId = uid('cv');
      conn.prepare(`INSERT INTO contract_version
        (id, contract_id, semver, state, spec_json, examples_json, spec_hash, created_by, created_at, locked_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(newId, id, diff.nextSemver, cur.state, JSON.stringify(parsed.data),
          JSON.stringify(examples ?? j(cur.examples_json, [])), specHash(parsed.data),
          actor ?? 'someone', now(), cur.state === 'locked' ? now() : null);
      conn.prepare('UPDATE contract SET current_version = ? WHERE id = ?').run(diff.nextSemver, id);
      return {
        applied: true, changeClass: diff.changeClass, semver: diff.nextSemver, reasons: diff.reasons,
        message: `${diff.changeClass} change applied as ${diff.nextSemver}. Consumers notified; nothing they wrote breaks.`,
      };
    }

    const crId = uid('cr');
    conn.prepare(`INSERT INTO change_request
      (id, contract_id, from_semver, to_semver, proposed_spec_json, reason, change_class, state, opened_by, opened_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(crId, id, cur.semver, diff.nextSemver, JSON.stringify(parsed.data), reason.trim(),
        'breaking', 'open', actor ?? 'someone', now());

    return {
      applied: false, changeRequestId: crId, changeClass: 'breaking',
      semver: diff.nextSemver, reasons: diff.reasons,
      message: 'Breaking. Every consumer has to answer before this lands. The current version keeps generating in the meantime.',
    };
  });

  app.get('/api/projects/:id/change-requests', async (req) => changeRequestRows((req.params as any).id));

  app.post('/api/change-requests/:id/ack', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { moduleId, decision, reason } = req.body as {
      moduleId?: string; decision?: 'ack' | 'object'; reason?: string;
    };
    if (!moduleId || !decision) {
      return reply.code(400).send({ code: 'FIELDS_REQUIRED', message: 'moduleId and decision are both required.' });
    }
    if (decision === 'object' && !reason?.trim()) {
      return reply.code(400).send({
        code: 'REASON_REQUIRED',
        message: 'An objection must propose an alternative or state a cost. "No" on its own is not a valid response.',
      });
    }
    conn.prepare(`INSERT INTO change_ack (change_request_id, module_id, decision, reason, at) VALUES (?,?,?,?,?)
                  ON CONFLICT(change_request_id, module_id) DO UPDATE
                  SET decision = excluded.decision, reason = excluded.reason, at = excluded.at`)
      .run(id, moduleId, decision, reason ?? null, now());
    return { ok: true };
  });

  /**
   * Land a breaking change.
   *
   * Needs every consumer to have acked — unless someone reaches for the break
   * glass, which works instantly and records exactly who did it and why. Fast,
   * but never quiet.
   */
  app.post('/api/change-requests/:id/apply', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { breakGlass, actor } = req.body as { breakGlass?: boolean; actor?: string };

    const cr = conn.prepare('SELECT * FROM change_request WHERE id = ?').get(id) as any;
    if (!cr) return reply.code(404).send({ code: 'NOT_FOUND', message: 'No such change request.' });
    if (cr.state !== 'open') return reply.code(409).send({ code: 'ALREADY_RESOLVED', message: `This request is ${cr.state}.` });

    const consumers = conn.prepare(
      `SELECT module_id FROM module_contract WHERE contract_id = ? AND role = 'consumes'`,
    ).all(cr.contract_id) as any[];
    const acks = conn.prepare('SELECT module_id, decision FROM change_ack WHERE change_request_id = ?')
      .all(id) as any[];

    const outstanding = consumers.filter((c) => !acks.some((a) => a.module_id === c.module_id && a.decision === 'ack'));

    if (outstanding.length > 0 && !breakGlass) {
      const slugs = outstanding.map((o) =>
        (conn.prepare('SELECT slug FROM module WHERE id = ?').get(o.module_id) as any)?.slug ?? o.module_id);
      return reply.code(409).send({
        code: 'AWAITING_ACK',
        message: `Still waiting on ${slugs.join(', ')}. Breaking changes never auto-ack — that is the difference between fair and careless.`,
        outstanding: slugs,
      });
    }

    const cur = currentVersion(cr.contract_id)!;
    const spec = j<ContractSpec>(cr.proposed_spec_json, {} as ContractSpec);

    conn.transaction(() => {
      // The old major is deprecated, not removed: both versions generate through
      // the migration window so nobody is hard-blocked.
      conn.prepare(`UPDATE contract_version SET state = 'deprecated' WHERE id = ?`).run(cur.id);
      conn.prepare(`INSERT INTO contract_version
        (id, contract_id, semver, state, spec_json, examples_json, spec_hash, created_by, created_at, locked_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(uid('cv'), cr.contract_id, cr.to_semver, 'locked', JSON.stringify(spec),
          cur.examples_json, specHash(spec), actor ?? 'someone', now(), now());
      conn.prepare('UPDATE contract SET current_version = ? WHERE id = ?').run(cr.to_semver, cr.contract_id);
      conn.prepare('UPDATE change_request SET state = ?, resolved_at = ?, break_glass = ? WHERE id = ?')
        .run('accepted', now(), breakGlass ? 1 : 0, id);
    })();

    return {
      ok: true,
      semver: cr.to_semver,
      breakGlass: Boolean(breakGlass),
      message: breakGlass
        ? `Forced through by ${actor ?? 'someone'}. Every consumer has been recorded as un-acked, and this project cannot be marked complete until each one is remediated.`
        : `${cr.to_semver} is locked. ${cur.semver} stays generating during the migration window.`,
    };
  });

  app.post('/api/change-requests/:id/withdraw', async (req) => {
    const { id } = req.params as { id: string };
    conn.prepare(`UPDATE change_request SET state = 'withdrawn', resolved_at = ? WHERE id = ?`).run(now(), id);
    return { ok: true };
  });

  // ── generation ─────────────────────────────────────────────────────────────

  app.post('/api/projects/:id/generate', async (req) => {
    const { id } = req.params as { id: string };
    const { packs, includeDrafts, dryRun } = req.body as {
      packs?: string[]; includeDrafts?: boolean; dryRun?: boolean;
    };
    return generate({
      projectId: id,
      packs: packs?.length ? packs : Object.keys(PACKS),
      includeDrafts,
      dryRun,
    });
  });

  app.get('/api/projects/:id/openapi', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = conn.prepare('SELECT name FROM project WHERE id = ?').get(id) as any;
    if (!project) return reply.code(404).send({ code: 'NOT_FOUND', message: 'No such project.' });
    return toOpenApi(loadGenContracts(id, true), project.name);
  });

  // ── dependency check ───────────────────────────────────────────────────────

  app.post('/api/projects/:id/check', async (req) => {
    const { id } = req.params as { id: string };
    const { levels } = req.body as { levels?: Level[] };
    return runCheck(id, levels?.length ? levels : [1, 2, 3]);
  });

  app.get('/api/projects/:id/checks', async (req) => {
    const { id } = req.params as { id: string };
    const runs = conn.prepare('SELECT * FROM check_run WHERE project_id = ? ORDER BY started_at DESC LIMIT 20')
      .all(id) as any[];
    return runs.map((r) => ({
      ...r,
      findings: conn.prepare('SELECT * FROM finding WHERE check_run_id = ?').all(r.id),
    }));
  });

}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
