import { db } from '../db/db.js';

export interface ProjectRow {
  id: string;
  name: string;
  root_path: string | null;
  repo_url: string | null;
  created_at: string;
}

export function listProjects(): ProjectRow[] {
  return db().prepare('SELECT id, name, root_path, repo_url, created_at FROM project ORDER BY created_at DESC')
    .all() as ProjectRow[];
}

export type ProjectResolution =
  | { ok: true; project: ProjectRow }
  | { ok: false; message: string; projects: ProjectRow[] };

/**
 * Resolves a tool's `projectId` argument.
 *
 * Stdio MCP has no browser tab or session to default a project from the way
 * the UI does, so: an explicit id is validated against the database; an
 * omitted id resolves automatically only when exactly one project exists —
 * otherwise the caller gets the project list back and has to say which one.
 * That is a decision made in this tool layer rather than a new env var,
 * because it is a problem the tool layer can already solve without one.
 */
export function resolveProject(projectId?: string): ProjectResolution {
  const projects = listProjects();
  if (projectId) {
    const project = projects.find((p) => p.id === projectId);
    return project
      ? { ok: true, project }
      : { ok: false, message: `No project "${projectId}".`, projects };
  }
  if (projects.length === 1) return { ok: true, project: projects[0] };
  if (projects.length === 0) {
    return { ok: false, message: 'No projects exist yet — create one over the HTTP API first.', projects: [] };
  }
  return { ok: false, message: `${projects.length} projects exist — pass projectId to say which one.`, projects };
}
