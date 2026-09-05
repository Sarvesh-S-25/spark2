import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db, j, now } from '../db/db.js';
import { runSplit } from '../splitter/index.js';
import { generate, PACKS } from '../generate/index.js';
import { canTransition } from '../contracts/state.js';
import { currentVersion } from '../contracts/rows.js';
import { recordStatusEvent } from '../status/events.js';
import type { ContractExample } from '../contracts/spec.js';
import { providerConfigured, providerForPass } from '../env.js';
import { resolveProject, type ProjectResolution } from './project.js';

/**
 * The write tools — each gated by an optional `confirm`. Called without it,
 * the tool performs no mutation and returns a preview of what it would do
 * plus "call again with confirm: true". Contract-lock especially is a
 * governance act that unblocks other people; it must never happen as a side
 * effect of an agent exploring.
 */

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function unresolved(res: Extract<ProjectResolution, { ok: false }>) {
  return text({ error: res.message, projects: res.projects.map((p) => ({ id: p.id, name: p.name })) });
}

export function registerWriteTools(server: McpServer): void {
  server.registerTool('spark_split', {
    title: 'Split a brief into modules and contracts',
    description: 'Runs the three-pass splitter against a brief. Without confirm:true this only validates the brief and warns that running it calls the configured model provider and may cost tokens — nothing runs. With confirm:true it actually splits.',
    inputSchema: {
      projectId: z.string().optional().describe('Project id. Omit when only one project exists.'),
      brief: z.string(),
      source: z.string().optional(),
      confirm: z.boolean().optional(),
    },
  }, async ({ projectId, brief, source, confirm }) => {
    const res = resolveProject(projectId);
    if (!res.ok) return unresolved(res);
    if (!brief?.trim() || brief.trim().length < 20) {
      return text({ error: 'Give the splitter something to work with — a sentence or two about what the thing does.' });
    }
    if (!confirm) {
      const providerB = providerForPass('B');
      return text({
        preview: true,
        message: `Not run yet. Splitting calls the configured provider (pass B → "${providerB}", `
          + `${providerConfigured(providerB) ? 'configured' : 'NOT configured — this will fail'}) and may cost tokens. `
          + 'Call again with confirm: true to actually split.',
        briefLength: brief.trim().length,
      });
    }
    return text(await runSplit({ projectId: res.project.id, brief, source }));
  });

  server.registerTool('spark_lock', {
    title: 'Lock a contract',
    description: 'Transitions one contract to locked — the signal every consumer waits on. Without confirm:true, previews whether the transition would succeed right now (an example exists, a provider is wired). With confirm:true, performs it.',
    inputSchema: { contractId: z.string(), confirm: z.boolean().optional() },
  }, async ({ contractId, confirm }) => {
    const conn = db();
    const cur = currentVersion(contractId);
    if (!cur) return text({ error: `No contract "${contractId}", or it has no version yet.` });
    const wiring = conn.prepare('SELECT role FROM module_contract WHERE contract_id = ?').all(contractId) as any[];
    const check = canTransition(cur.state, 'locked', {
      examples: j<ContractExample[]>(cur.examples_json, []),
      hasProvider: wiring.some((w) => w.role === 'provides'),
      consumerCount: wiring.filter((w) => w.role === 'consumes').length,
    });
    if (!confirm) {
      return text({
        preview: true,
        currentState: cur.state,
        wouldSucceed: check.ok,
        reason: check.ok ? 'ready to lock' : check.reason,
      });
    }
    if (!check.ok) return text({ error: check.reason });
    conn.prepare('UPDATE contract_version SET state = ?, locked_at = ? WHERE id = ?').run('locked', now(), cur.id);
    return text({ ok: true, state: 'locked' });
  });

  server.registerTool('spark_generate', {
    title: 'Generate code from locked contracts',
    description: 'Emits typed clients, mocks, route stubs and .spark/ for the given (or every) language pack. Without confirm:true this is a dry run — the file list and byte counts, nothing written. With confirm:true it writes to disk.',
    inputSchema: {
      projectId: z.string().optional().describe('Project id. Omit when only one project exists.'),
      packs: z.array(z.string()).optional().describe('Language pack ids. Defaults to every pack.'),
      includeDrafts: z.boolean().optional(),
      confirm: z.boolean().optional(),
    },
  }, async ({ projectId, packs, includeDrafts, confirm }) => {
    const res = resolveProject(projectId);
    if (!res.ok) return unresolved(res);
    return text(generate({
      projectId: res.project.id,
      packs: packs?.length ? packs : Object.keys(PACKS),
      includeDrafts,
      dryRun: !confirm,
    }));
  });

  server.registerTool('spark_claim', {
    title: 'Claim a module',
    description: 'Assigns a module to someone, which moves its derived status toward building. Without confirm:true, previews the claim. With confirm:true, records it.',
    inputSchema: { moduleId: z.string(), assignee: z.string(), confirm: z.boolean().optional() },
  }, async ({ moduleId, assignee, confirm }) => {
    if (!assignee?.trim()) return text({ error: 'Who is picking this up?' });
    const conn = db();
    const module = conn.prepare('SELECT id, slug FROM module WHERE id = ?').get(moduleId) as any;
    if (!module) return text({ error: `No module "${moduleId}".` });
    if (!confirm) return text({ preview: true, module: module.slug, assignee: assignee.trim() });
    conn.prepare(`INSERT INTO claim (module_id, assignee, claimed_at, last_activity_at) VALUES (?,?,?,?)
                  ON CONFLICT(module_id) DO UPDATE SET assignee = excluded.assignee, last_activity_at = excluded.last_activity_at`)
      .run(moduleId, assignee.trim(), now(), now());
    recordStatusEvent(moduleId, 'building', 'claimed', assignee.trim());
    return text({ ok: true });
  });
}
