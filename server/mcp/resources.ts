import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../db/db.js';

/**
 * Exposes the generated `.spark/` artifacts as MCP resources, so a client can
 * read the contract set without a tool call — the README's Phase 3 ask.
 *
 * Deliberately the on-disk *generated* files (whatever `spark_generate` last
 * wrote), not the live database state `spark_contract` reads: if generation
 * has never run, `.spark/` doesn't exist yet and these list empty rather than
 * quietly falling back to the DB, which would blur the generated-vs-handwritten
 * directory boundary invariant 6 depends on.
 */

function projectRoot(projectId: string): string | null {
  const row = db().prepare('SELECT root_path FROM project WHERE id = ?')
    .get(projectId) as { root_path: string | null } | undefined;
  return row?.root_path ? resolve(process.cwd(), row.root_path) : null;
}

function allProjectIds(): string[] {
  return (db().prepare('SELECT id FROM project').all() as { id: string }[]).map((p) => p.id);
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    'spark-contract',
    new ResourceTemplate('spark://{projectId}/contracts/{+file}', {
      list: async () => ({
        resources: allProjectIds().flatMap((projectId) => {
          const root = projectRoot(projectId);
          const dir = root ? join(root, '.spark', 'contracts') : null;
          if (!dir || !existsSync(dir)) return [];
          return readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .map((file) => ({
              uri: `spark://${projectId}/contracts/${file}`,
              name: file,
              mimeType: 'application/json',
            }));
        }),
      }),
    }),
    { description: 'A generated contract version, as last written to .spark/contracts/.' },
    async (uri, variables) => {
      const root = projectRoot(String(variables.projectId));
      const path = root ? join(root, '.spark', 'contracts', String(variables.file)) : null;
      const text = path && existsSync(path) ? readFileSync(path, 'utf8') : '{}';
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
    },
  );

  server.registerResource(
    'spark-plan',
    new ResourceTemplate('spark://{projectId}/plan/latest', { list: undefined }),
    { description: 'The most recent plan revision, as last written to .spark/plan/.' },
    async (uri, variables) => {
      const root = projectRoot(String(variables.projectId));
      const dir = root ? join(root, '.spark', 'plan') : null;
      const latest = dir && existsSync(dir)
        ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort().at(-1)
        : undefined;
      const text = latest ? readFileSync(join(dir!, latest), 'utf8') : '';
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    },
  );
}
