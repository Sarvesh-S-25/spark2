#!/usr/bin/env node
/**
 * Pre-flight checks — zero dependencies, runs before `npm install` ever has.
 *
 * `npm run check` is the real type check, but it needs the whole dependency tree
 * installed. This catches the subset of failures that need nothing at all, which
 * happens to be the subset that breaks a first run:
 *
 *   · a relative import that points at no file
 *   · a named import the target module does not export
 *   · a package.json script pointing at a file that is not there
 *   · an env var read by the code but absent from .env.example
 *   · malformed JSON
 *
 * It is not a substitute for tsc. It is what you run when tsc cannot run yet.
 *
 *   npm run preflight
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.git', 'dist', 'dist-ui', 'data', 'workspace', '.claude', '.gemini']);

const problems = [];
const note = (kind, msg) => problems.push(`${kind.padEnd(12)} ${msg}`);

// ── collect sources ──────────────────────────────────────────────────────────

const sources = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(name)) sources.push(full);
  }
})(ROOT);

// ── 1 & 2. imports resolve, and the names exist ──────────────────────────────

const exportCache = new Map();

function namedExports(file) {
  if (exportCache.has(file)) return exportCache.get(file);
  const src = readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z0-9_$]+)/gm)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      if (t[0]) names.add((t[1] || t[0]).trim());
    }
  }
  if (/^\s*export\s+\*/m.test(src)) names.add('*');
  exportCache.set(file, names);
  return names;
}

let importCount = 0;

for (const file of sources) {
  // Blank out template literals first. The generator packs contain import
  // statements *inside* backticks — that is the code being generated, not an
  // import of the pack itself, and scanning it is pure noise.
  const src = readFileSync(file, 'utf8')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, (m) => "'" + ' '.repeat(Math.max(0, m.length - 2)) + "'");

  const re = /import\s+(?:type\s+)?(?:([A-Za-z0-9_$]+)\s*,?\s*)?(?:\{([^}]*)\}\s*)?(?:\*\s+as\s+[A-Za-z0-9_$]+\s*)?from\s*['"](\.[^'"]+)['"]/g;

  for (const m of src.matchAll(re)) {
    const [, , named, spec] = m;
    importCount++;
    const base = resolve(dirname(file), spec.replace(/\.js$/, ''));
    const target = ['.ts', '.tsx', '/index.ts', '/index.tsx', '']
      .map((e) => base + e)
      .find((p) => existsSync(p) && statSync(p).isFile());

    if (!target) {
      note('UNRESOLVED', `${relative(ROOT, file)} imports "${spec}", which is not a file`);
      continue;
    }
    if (!named) continue;

    const have = namedExports(target);
    if (have.has('*')) continue;
    for (const raw of named.split(',')) {
      const n = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (n && !have.has(n)) {
        note('NO EXPORT', `${relative(ROOT, file)} imports { ${n} } from "${spec}" — ${relative(ROOT, target)} does not export it`);
      }
    }
  }
}

// ── 3. package.json scripts point at files that exist ────────────────────────

let pkg = null;
try {
  pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
} catch (e) {
  note('BAD JSON', `package.json — ${e.message}`);
}

if (pkg) {
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    for (const m of String(cmd).matchAll(/(?:tsx|node)\s+([A-Za-z0-9_./-]+\.(?:ts|mjs|cjs|js))/g)) {
      if (!existsSync(join(ROOT, m[1]))) {
        note('NO SCRIPT', `npm run ${name} runs "${m[1]}", which does not exist`);
      }
    }
  }
}

// ── 4. every env var the code reads is documented ────────────────────────────

const envFile = join(ROOT, 'server', 'env.ts');
const example = join(ROOT, '.env.example');
if (existsSync(envFile) && existsSync(example)) {
  const documented = new Set(
    readFileSync(example, 'utf8')
      .split('\n')
      .map((l) => l.replace(/^#\s*/, '').match(/^([A-Z0-9_]+)\s*=/))
      .filter(Boolean)
      .map((m) => m[1]),
  );
  const read = new Set(
    [...readFileSync(envFile, 'utf8').matchAll(/(?:str|num|provider)\(\s*'([A-Z0-9_]+)'/g)].map((m) => m[1]),
  );
  for (const key of read) {
    if (!documented.has(key)) {
      note('UNDOCUMENTED', `server/env.ts reads ${key}, but .env.example never mentions it`);
    }
  }
}

// ── 5. JSON files parse ──────────────────────────────────────────────────────

(function jsonWalk(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) jsonWalk(full);
    else if (name.endsWith('.json')) {
      try {
        JSON.parse(readFileSync(full, 'utf8'));
      } catch (e) {
        note('BAD JSON', `${relative(ROOT, full)} — ${e.message}`);
      }
    }
  }
})(ROOT);

// ── report ───────────────────────────────────────────────────────────────────

console.log(`\n  ${sources.length} source files · ${importCount} relative imports checked\n`);

if (problems.length === 0) {
  console.log('  preflight clean\n');
  console.log('  This does not replace `npm run check` — install the dependencies and');
  console.log('  run that before trusting anything.\n');
  process.exit(0);
}

for (const p of problems) console.log(`  ${p}`);
console.log(`\n  ${problems.length} problem${problems.length === 1 ? '' : 's'}\n`);
process.exit(1);
