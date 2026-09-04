/**
 * The golden eval set.
 *
 * The splitter is the piece that has to be genuinely good, and it is the piece
 * that fails silently. This is how you find out whether a prompt change, or a
 * different model, made it better or worse — rather than reading one output and
 * deciding it "looks fine".
 *
 *   npm run eval                    · runs against your configured provider
 *   SPARK_PROVIDER=ollama npm run eval
 *   SPARK_CACHE=0 npm run eval      · required for the stability metric
 *
 * Half the briefs are ones you would actually be assigned; half are awkward on
 * purpose, because a splitter that only works on well-shaped input is a demo.
 */
import { db, uid, now } from '../db/db.js';
import { runSplit } from './index.js';

interface Case {
  id: string;
  brief: string;
  /** Contract keys or key fragments a correct split must produce. */
  expect: string[];
  /** Awkward cases: what the split should NOT do. */
  forbid?: { lane: 'frontend' | 'backend'; note: string }[];
}

const CASES: Case[] = [
  {
    id: 'live-map',
    brief: 'Build a web app that shows vehicles moving on a live map. Users can see markers update in real time, tap a marker for details, and pan and zoom by touch. Vehicles report their position to the system.',
    expect: ['markers', 'map', 'positions'],
  },
  {
    id: 'todo',
    brief: 'A shared to-do list. People can add tasks, mark them done, and see the list update when someone else changes it.',
    expect: ['items', 'list'],
  },
  {
    id: 'chat',
    brief: 'A team chat app with channels. Users read message history, send messages, and see new messages arrive without refreshing.',
    expect: ['messages'],
  },
  {
    id: 'auth-dashboard',
    brief: 'An internal dashboard. Staff sign in with email and password, then see charts of weekly signups and revenue for a date range they pick.',
    expect: ['auth', 'stats'],
  },
  {
    id: 'file-review',
    brief: 'A tool where people upload PDF contracts, search across them, and leave comments on specific documents.',
    expect: ['files', 'search'],
  },
  {
    id: 'shop',
    brief: 'A small online shop. Customers browse a product catalog, search it, add items to a basket, and pay at checkout.',
    expect: ['checkout', 'search'],
  },
  // ── awkward on purpose ─────────────────────────────────────────────────────
  {
    id: 'cli-only',
    brief: 'A command-line tool that reads a folder of CSV files, merges them, and writes one cleaned CSV out. No web interface at all.',
    expect: [],
    forbid: [{ lane: 'frontend', note: 'a CLI tool has no frontend lane to speak of' }],
  },
  {
    id: 'static-site',
    brief: 'A personal portfolio site. Static pages describing my projects, with no accounts, no database and no forms.',
    expect: [],
    forbid: [{ lane: 'backend', note: 'a static site needs no backend modules' }],
  },
  {
    id: 'third-party',
    brief: 'A weather widget for a website. It shows the forecast for the visitor\'s city by calling a public weather API. We store nothing.',
    expect: [],
  },
  {
    id: 'notifications',
    brief: 'Add alerts to an existing app: users get a notification when something they follow changes, and can see a list of past alerts.',
    expect: ['notifications'],
  },
];

const conn = db();
const results: any[] = [];

console.log(`\nRunning ${CASES.length} cases…\n`);

for (const c of CASES) {
  const projectId = uid('eval');
  conn.prepare('INSERT INTO project (id, name, root_path, created_at) VALUES (?,?,?,?)')
    .run(projectId, `eval:${c.id}`, null, now());

  const started = Date.now();
  let split;
  try {
    split = await runSplit({ projectId, brief: c.brief, source: 'eval' });
  } catch (e) {
    console.log(`  ${pad(c.id)} ERROR  ${(e as Error).message}`);
    conn.prepare('DELETE FROM project WHERE id = ?').run(projectId);
    continue;
  }

  const keys = split.seams.map((s) => s.key.toLowerCase());
  const found = c.expect.filter((want) => keys.some((k) => k.includes(want.toLowerCase())));
  const completeness = c.expect.length === 0 ? 1 : found.length / c.expect.length;

  // `runSplit` already ran `validateSplit` on a successful split, and on a
  // hard pass failure it returns a block-severity "Pass X failed: ..." entry
  // here instead of throwing — recomputing our own `validateSplit(split)`
  // on the (possibly empty) result would silently miss that failure entirely
  // and report a false "blocking 0", which is exactly the silent failure
  // this eval exists to catch.
  const issues = split.issues;
  const blocking = issues.filter((i) => i.severity === 'block');
  const laneImpurities = issues.filter((i) => i.code === 'LANE_IMPURITY').length;
  const orphans = issues.filter((i) => i.code === 'ORPHAN_CONTRACT' || i.code === 'NO_PROVIDER_MODULE').length;

  const forbidHits = (c.forbid ?? []).filter((f) =>
    split.modules.filter((m) => m.lane === f.lane).length > 2);

  results.push({
    id: c.id,
    completeness,
    closed: orphans === 0,
    laneImpurities,
    blocking: blocking.length,
    modules: split.modules.length,
    contracts: split.seams.length,
    forbidHits: forbidHits.length,
    ms: Date.now() - started,
    provider: split.passes[0]?.provider ?? '?',
  });

  const flag = blocking.length === 0 && completeness >= 0.85 && forbidHits.length === 0 ? 'ok  ' : 'FAIL';
  console.log(
    `  ${pad(c.id)} ${flag}  completeness ${pct(completeness)}  ` +
    `modules ${String(split.modules.length).padStart(2)}  contracts ${String(split.seams.length).padStart(2)}  ` +
    `blocking ${blocking.length}  ${split.passes[0]?.cached ? 'cached' : `${Date.now() - started}ms`}`,
  );
  for (const f of forbidHits) console.log(`       ↳ ${f.note}`);
  for (const b of blocking.slice(0, 3)) console.log(`       ↳ [${b.code}] ${b.message}`);

  conn.prepare('DELETE FROM project WHERE id = ?').run(projectId);
}

const n = results.length || 1;
const avg = (f: (r: any) => number) => results.reduce((s, r) => s + f(r), 0) / n;

console.log(`
────────────────────────────────────────────────────────────
  contract completeness   ${pct(avg((r) => r.completeness))}   target > 85%
  closure rate            ${pct(results.filter((r) => r.closed).length / n)}   target > 90%
  lane purity violations  ${results.reduce((s, r) => s + r.laneImpurities, 0)}        target 0
  scope violations        ${results.reduce((s, r) => s + r.forbidHits, 0)}        target 0
  median module count     ${median(results.map((r) => r.modules))}        target 8–20
  provider                ${results[0]?.provider ?? '?'}

  Stability is not measured here — run with SPARK_CACHE=0 twice and diff the
  module slugs. Unstable slugs at temperature 0 mean the prompt is under-specified,
  not that the model is bad.
────────────────────────────────────────────────────────────
`);

function pad(s: string) { return s.padEnd(16); }
function pct(x: number) { return `${Math.round(x * 100)}%`.padStart(4); }
function median(xs: number[]) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
