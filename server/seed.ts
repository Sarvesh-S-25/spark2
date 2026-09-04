/**
 * Seeds a demo project so the UI has something real in it before you have
 * written a brief of your own.
 *
 * It uses the live splitter — not canned rows — so what you see is exactly what
 * the pipeline produces. Run it with:  npm run seed
 */
import { db, uid, now, resetDb } from './db/db.js';
import { runSplit } from './splitter/index.js';
import { generate } from './generate/index.js';
import { runCheck } from './deps/check.js';
import { canTransition } from './contracts/state.js';
import { j } from './db/db.js';

const BRIEF = `
Build a web app that shows vehicles moving on a live map.

Users can see vehicle markers update in real time as the vehicles move, tap a
marker to see that vehicle's details, and pan and zoom the map by touch.
Vehicles report their own position to the system on a regular interval.
`.trim();

const reset = process.argv.includes('--reset');

if (reset) {
  console.log('[seed] wiping the database');
  resetDb();
}

const conn = db();

let project = conn.prepare(`SELECT * FROM project WHERE name = ?`).get('Live map tracker') as any;
if (!project) {
  const id = uid('prj');
  conn.prepare('INSERT INTO project (id, name, root_path, created_at) VALUES (?,?,?,?)')
    .run(id, 'Live map tracker', 'workspace/live-map-tracker', now());
  project = conn.prepare('SELECT * FROM project WHERE id = ?').get(id);
  console.log(`[seed] created project ${project.id}`);
} else {
  console.log(`[seed] reusing project ${project.id}`);
}

console.log('[seed] splitting the brief…');
const split = await runSplit({ projectId: project.id, brief: BRIEF, source: 'seed' });

console.log(`[seed]   ${split.capabilities.length} capabilities`);
console.log(`[seed]   ${split.seams.length} contracts`);
console.log(`[seed]   ${split.modules.length} modules`);
for (const p of split.passes) {
  console.log(`[seed]   pass ${p.pass}: ${p.provider}/${p.model}${p.cached ? ' (cached)' : ''} ${p.latencyMs}ms`);
}
if (split.fixes.length) {
  console.log('[seed]   repairs applied:');
  for (const f of split.fixes) console.log(`[seed]     · ${f}`);
}
if (split.issues.length) {
  console.log('[seed]   issues:');
  for (const i of split.issues) console.log(`[seed]     [${i.severity}] ${i.code}: ${i.message}`);
}

// Walk every contract draft → proposed → locked, so the demo starts at the
// interesting moment: contracts locked, both lanes unblocked.
console.log('[seed] proposing and locking contracts…');
const rows = conn.prepare(`
  SELECT cv.id, cv.state, cv.examples_json, c.id AS contract_id, c.key
  FROM contract c JOIN contract_version cv ON cv.contract_id = c.id AND cv.semver = c.current_version
  WHERE c.project_id = ?`).all(project.id) as any[];

let locked = 0;
for (const row of rows) {
  const wiring = conn.prepare('SELECT role FROM module_contract WHERE contract_id = ?').all(row.contract_id) as any[];
  const ctx = {
    examples: j<any[]>(row.examples_json, []),
    hasProvider: wiring.some((w) => w.role === 'provides'),
    consumerCount: wiring.filter((w) => w.role === 'consumes').length,
  };
  if (!canTransition('draft', 'proposed', ctx).ok) continue;
  conn.prepare(`UPDATE contract_version SET state = 'proposed' WHERE id = ?`).run(row.id);
  const lock = canTransition('proposed', 'locked', ctx);
  if (!lock.ok) {
    console.log(`[seed]   ${row.key} stays proposed — ${lock.reason}`);
    continue;
  }
  conn.prepare(`UPDATE contract_version SET state = 'locked', locked_at = ? WHERE id = ?`).run(now(), row.id);
  locked++;
}
console.log(`[seed]   ${locked} contracts locked`);

// One claim, so the board has something in progress.
const canvas = conn.prepare(`SELECT id FROM module WHERE project_id = ? AND slug = ?`)
  .get(project.id, 'fe.map-canvas') as any;
if (canvas) {
  conn.prepare(`INSERT OR REPLACE INTO claim (module_id, assignee, claimed_at, last_activity_at) VALUES (?,?,?,?)`)
    .run(canvas.id, 'you', now(), now());
}

console.log('[seed] generating code…');
const gen = generate({ projectId: project.id, packs: ['ts-react-fetch', 'node-express', 'python-fastapi'] });
console.log(`[seed]   ${gen.message}`);
console.log(`[seed]   output: ${gen.root}`);

console.log('[seed] running the dependency check…');
const check = runCheck(project.id, [1, 2, 3]);
console.log(`[seed]   ${check.counts.block} blocking · ${check.counts.warn} warnings · ${check.counts.info} info`);
for (const f of check.findings.slice(0, 8)) {
  console.log(`[seed]     [${f.severity}] ${f.code}: ${f.message}`);
}

console.log(`
[seed] done. Start the app and open the project:

  npm run dev        then visit http://localhost:5173
`);
