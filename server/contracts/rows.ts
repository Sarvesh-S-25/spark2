import { db, j } from '../db/db.js';

/**
 * Read-side contract queries shared by the HTTP API and the MCP server.
 *
 * These used to be closures inside `registerApi()` — fine while the API was
 * the only caller, but the MCP server needs the exact same rows without
 * booting Fastify. Per the one rule in README's Phase 3 section ("no logic is
 * reimplemented"), they live here instead of being copy-pasted.
 */

/** The row a contract's *current* version resolves to, or undefined if none. */
export function currentVersion(contractId: string): any {
  return db().prepare(`
    SELECT cv.* FROM contract_version cv
    JOIN contract c ON c.id = cv.contract_id AND c.current_version = cv.semver
    WHERE cv.contract_id = ?`).get(contractId);
}

/** Every contract in a project, with its current spec, examples and wiring. */
export function contractRows(projectId: string) {
  const conn = db();
  return conn.prepare(`
    SELECT c.id, c.key, c.kind, c.current_version AS semver, cv.state, cv.spec_json, cv.examples_json, cv.spec_hash,
      (SELECT m.slug FROM module_contract mc JOIN module m ON m.id = mc.module_id
        WHERE mc.contract_id = c.id AND mc.role = 'provides') AS provider,
      (SELECT COUNT(*) FROM module_contract mc WHERE mc.contract_id = c.id AND mc.role = 'consumes') AS consumer_count
    FROM contract c
    LEFT JOIN contract_version cv ON cv.contract_id = c.id AND cv.semver = c.current_version
    WHERE c.project_id = ? ORDER BY c.kind, c.key`).all(projectId).map((r: any) => ({
    ...r,
    spec: j(r.spec_json, {}),
    examples: j(r.examples_json, []),
    consumers: conn.prepare(`
      SELECT m.slug, m.lane, m.id FROM module_contract mc JOIN module m ON m.id = mc.module_id
      WHERE mc.contract_id = ? AND mc.role = 'consumes'`).all(r.id),
  }));
}

/** Every change request in a project, with its acks and consumers. */
export function changeRequestRows(projectId: string) {
  const conn = db();
  return conn.prepare(`
    SELECT cr.*, c.key FROM change_request cr
    JOIN contract c ON c.id = cr.contract_id
    WHERE c.project_id = ? ORDER BY cr.opened_at DESC`).all(projectId).map((r: any) => ({
    ...r,
    proposedSpec: j(r.proposed_spec_json, {}),
    acks: conn.prepare(`
      SELECT ca.*, m.slug FROM change_ack ca JOIN module m ON m.id = ca.module_id
      WHERE ca.change_request_id = ?`).all(r.id),
    consumers: conn.prepare(`
      SELECT m.id, m.slug FROM module_contract mc JOIN module m ON m.id = mc.module_id
      WHERE mc.contract_id = ? AND mc.role = 'consumes'`).all(r.contract_id),
  }));
}
