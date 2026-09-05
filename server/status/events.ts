import { db, uid, now } from '../db/db.js';

/**
 * `status_event` is append-only — this is the one place anything writes to it.
 * Pulled out of `registerApi()`'s closures so the MCP server's write tools can
 * record the same trail the HTTP API does, instead of growing their own copy.
 */
export function recordStatusEvent(moduleId: string, to: string, cause: string, actor: string): void {
  db().prepare('INSERT INTO status_event (id, module_id, to_status, cause, actor, at) VALUES (?,?,?,?,?,?)')
    .run(uid('ev'), moduleId, to, cause, actor, now());
}
