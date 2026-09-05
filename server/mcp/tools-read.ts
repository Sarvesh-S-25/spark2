import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db, j } from '../db/db.js';
import { deriveAll, unblockRanking, criticalPath, nextActions } from '../status/derive.js';
import { contractRows, changeRequestRows } from '../contracts/rows.js';
import { runCheck, type Level } from '../deps/check.js';
import { listProjects, resolveProject, type ProjectResolution } from './project.js';

/**
 * The read tools — free to call, no `confirm` gate. Each one calls the exact
 * same core function `server/api.ts` calls for the matching screen; nothing
 * here is reimplemented per the README's Phase 3 rule.
 */

const projectIdParam = {
  projectId: z.string().optional().describe('Project id. Omit when only one project exists.'),
};

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function unresolved(res: Extract<ProjectResolution, { ok: false }>) {
  return text({ error: res.message, projects: res.projects.map((p) => ({ id: p.id, name: p.name })) });
}

export function registerReadTools(server: McpServer): void {
  server.registerTool('spark_projects', {
    title: 'List projects',
    description: 'Every SparkX project — id, name, module and contract counts.',
  }, async () => text(listProjects().map((p) => ({
    ...p,
    module_count: (db().prepare('SELECT COUNT(*) AS n FROM module WHERE project_id = ?').get(p.id) as any).n,
    contract_count: (db().prepare('SELECT COUNT(*) AS n FROM contract WHERE project_id = ?').get(p.id) as any).n,
  }))));

  server.registerTool('spark_overview', {
    title: 'Project overview',
    description: 'Modules, contracts, change requests, unblock ranking, critical path and the last check run for a project — everything the Overview screen shows, in one call.',
    inputSchema: projectIdParam,
  }, async ({ projectId }) => {
    const res = resolveProject(projectId);
    if (!res.ok) return unresolved(res);
    const id = res.project.id;
    const conn = db();
    const lastCheck = conn.prepare(
      'SELECT * FROM check_run WHERE project_id = ? ORDER BY started_at DESC LIMIT 1',
    ).get(id) as any;
    return text({
      project: res.project,
      modules: deriveAll(id),
      contracts: contractRows(id),
      unblockRanking: unblockRanking(id),
      criticalPath: criticalPath(id),
      changeRequests: changeRequestRows(id),
      lastCheck: lastCheck
        ? { ...lastCheck, findings: conn.prepare('SELECT * FROM finding WHERE check_run_id = ?').all(lastCheck.id) }
        : null,
    });
  });

  server.registerTool('spark_modules', {
    title: 'List modules',
    description: 'The module roster for a project, optionally filtered to one derived status.',
    inputSchema: {
      ...projectIdParam,
      status: z.enum(['planned', 'ready', 'building', 'blocked', 'contract_met', 'completed', 'orphaned'])
        .optional().describe('Filter to modules currently in this derived status.'),
    },
  }, async ({ projectId, status }) => {
    const res = resolveProject(projectId);
    if (!res.ok) return unresolved(res);
    const modules = deriveAll(res.project.id);
    return text(status ? modules.filter((m) => m.status === status) : modules);
  });

  server.registerTool('spark_contract', {
    title: 'Read one contract',
    description: 'A single contract: every version with its spec and examples, plus wiring — who provides it, who consumes it.',
    inputSchema: { contractId: z.string() },
  }, async ({ contractId }) => {
    const conn = db();
    const c = conn.prepare('SELECT * FROM contract WHERE id = ?').get(contractId) as any;
    if (!c) return text({ error: `No contract "${contractId}".` });
    const versions = conn.prepare(
      'SELECT * FROM contract_version WHERE contract_id = ? ORDER BY created_at',
    ).all(contractId) as any[];
    return text({
      ...c,
      versions: versions.map((v) => ({ ...v, spec: j(v.spec_json, {}), examples: j(v.examples_json, []) })),
      wiring: conn.prepare(`
        SELECT mc.role, m.slug, m.lane, m.id AS module_id FROM module_contract mc
        JOIN module m ON m.id = mc.module_id WHERE mc.contract_id = ?`).all(contractId),
    });
  });

  server.registerTool('spark_check', {
    title: 'Run the dependency checker',
    description: 'Runs the three-level dependency check (graph, drift, code reality) and returns its findings. Records a check run, but changes no contract or module state — safe to call anytime.',
    inputSchema: {
      ...projectIdParam,
      levels: z.array(z.union([z.literal(1), z.literal(2), z.literal(3)]))
        .optional().describe('Which check levels to run. Defaults to all three.'),
    },
  }, async ({ projectId, levels }) => {
    const res = resolveProject(projectId);
    if (!res.ok) return unresolved(res);
    return text(runCheck(res.project.id, (levels as Level[] | undefined) ?? [1, 2, 3]));
  });

  server.registerTool('spark_next', {
    title: 'What can I start now',
    description: 'The important one: which modules are startable right now, which unlocked contract would unblock the most modules if locked next, and the critical path.',
    inputSchema: projectIdParam,
  }, async ({ projectId }) => {
    const res = resolveProject(projectId);
    if (!res.ok) return unresolved(res);
    return text(nextActions(res.project.id));
  });
}
