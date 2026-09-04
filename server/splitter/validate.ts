import type { Capability, Seam, SplitModule } from './schemas.js';

/**
 * The six structural checks a split must pass before it is allowed near the
 * database.
 *
 * These are not style preferences. Each one corresponds to a way a split can be
 * confidently wrong in a manner that only shows up days later, when two people
 * have already built against it.
 */

export type IssueSeverity = 'block' | 'warn';

export interface SplitIssue {
  code:
  | 'ORPHAN_CONTRACT' | 'DUPLICATE_PROVIDER' | 'UNKNOWN_CONTRACT'
  | 'LANE_IMPURITY' | 'OVERSIZED_MODULE' | 'UNCOVERED_CAPABILITY'
  | 'DUPLICATE_SLUG' | 'DUPLICATE_FILE' | 'CYCLE' | 'DEAD_CONTRACT'
  | 'NO_PROVIDER_MODULE' | 'TOO_MANY_MODULES';
  severity: IssueSeverity;
  message: string;
  fixHint: string;
  subject?: string;
}

export interface SplitInput {
  capabilities: Capability[];
  seams: Seam[];
  modules: SplitModule[];
}

const FRONTEND_FORBIDDEN = new Set(['service', 'job', 'api_route']);
const BACKEND_FORBIDDEN = new Set(['ui_component']);

export function validateSplit(input: SplitInput): SplitIssue[] {
  const { capabilities, seams, modules } = input;
  const issues: SplitIssue[] = [];
  const seamByKey = new Map(seams.map((s) => [s.key, s]));

  // ── 1. Uniqueness ──────────────────────────────────────────────────────────
  const slugSeen = new Map<string, number>();
  for (const m of modules) slugSeen.set(m.slug, (slugSeen.get(m.slug) ?? 0) + 1);
  for (const [slug, n] of slugSeen) {
    if (n > 1) {
      issues.push({
        code: 'DUPLICATE_SLUG', severity: 'block', subject: slug,
        message: `${n} modules share the slug "${slug}"`,
        fixHint: 'Slugs are the stable identity across re-splits. Rename one.',
      });
    }
  }
  const fileOwner = new Map<string, string>();
  for (const m of modules) {
    for (const f of m.files) {
      const prev = fileOwner.get(f);
      if (prev && prev !== m.slug) {
        issues.push({
          code: 'DUPLICATE_FILE', severity: 'warn', subject: f,
          message: `"${f}" is claimed by both ${prev} and ${m.slug}`,
          fixHint: 'Two people editing one file is the thing this tool exists to avoid. Give each module its own files.',
        });
      }
      fileOwner.set(f, m.slug);
    }
  }

  // ── 2. Contract closure ────────────────────────────────────────────────────
  const providers = new Map<string, string[]>();
  const consumers = new Map<string, string[]>();
  for (const m of modules) {
    for (const key of m.provides) (providers.get(key) ?? providers.set(key, []).get(key)!).push(m.slug);
    for (const key of m.consumes) (consumers.get(key) ?? consumers.set(key, []).get(key)!).push(m.slug);
  }

  for (const [key, mods] of consumers) {
    if (!seamByKey.has(key)) {
      issues.push({
        code: 'UNKNOWN_CONTRACT', severity: 'block', subject: key,
        message: `${mods.join(', ')} consume "${key}", which is not in the seam list`,
        fixHint: 'Either the module reference is a typo, or Pass B missed a seam. Add the seam or fix the reference.',
      });
      continue;
    }
    if (!providers.has(key)) {
      issues.push({
        code: 'ORPHAN_CONTRACT', severity: 'block', subject: key,
        message: `"${key}" is consumed by ${mods.join(', ')} but nothing provides it`,
        fixHint: 'Every contract needs exactly one owner. Add a providing module, or drop the consumption.',
      });
    }
  }

  for (const [key, mods] of providers) {
    if (!seamByKey.has(key)) {
      issues.push({
        code: 'UNKNOWN_CONTRACT', severity: 'block', subject: key,
        message: `${mods.join(', ')} provide "${key}", which is not in the seam list`,
        fixHint: 'Add the seam in Pass B, or remove the claim.',
      });
      continue;
    }
    if (mods.length > 1) {
      issues.push({
        code: 'DUPLICATE_PROVIDER', severity: 'block', subject: key,
        message: `${mods.join(' and ')} both provide "${key}"`,
        fixHint: 'One provider per contract, always. If both genuinely need it, the contract is under-specified — split it in two.',
      });
    }
  }

  for (const seam of seams) {
    if (!providers.has(seam.key)) {
      issues.push({
        code: 'NO_PROVIDER_MODULE', severity: 'block', subject: seam.key,
        message: `no module provides "${seam.key}"`,
        fixHint: 'Assign it to a module, or remove the seam.',
      });
    } else if (!consumers.has(seam.key) && seam.direction !== 'device_to_server') {
      issues.push({
        code: 'DEAD_CONTRACT', severity: 'warn', subject: seam.key,
        message: `"${seam.key}" is provided but nothing consumes it`,
        fixHint: 'Either a consumer is missing, or this boundary is speculative and can be dropped until it is needed.',
      });
    }
  }

  // ── 3. Lane purity ─────────────────────────────────────────────────────────
  for (const m of modules) {
    if (m.lane === 'frontend' && FRONTEND_FORBIDDEN.has(m.kind)) {
      issues.push({
        code: 'LANE_IMPURITY', severity: 'block', subject: m.slug,
        message: `${m.slug} is a frontend module with kind "${m.kind}"`,
        fixHint: 'Frontend modules do not serve routes or run jobs. Move it to the backend lane, or change its kind.',
      });
    }
    if (m.lane === 'backend' && BACKEND_FORBIDDEN.has(m.kind)) {
      issues.push({
        code: 'LANE_IMPURITY', severity: 'block', subject: m.slug,
        message: `${m.slug} is a backend module with kind "${m.kind}"`,
        fixHint: 'Backend modules do not render UI. Move it to the frontend lane, or change its kind.',
      });
    }
    for (const key of m.provides) {
      const seam = seamByKey.get(key);
      if (!seam) continue;
      if (m.lane === 'frontend' && (seam.kind === 'http' || seam.direction === 'server_to_client')) {
        issues.push({
          code: 'LANE_IMPURITY', severity: 'block', subject: `${m.slug} → ${key}`,
          message: `frontend module ${m.slug} claims to provide the server-side seam "${key}"`,
          fixHint: 'Server seams are provided by backend modules. Reassign the provider.',
        });
      }
      if (m.lane === 'backend' && seam.direction === 'client_internal') {
        issues.push({
          code: 'LANE_IMPURITY', severity: 'block', subject: `${m.slug} → ${key}`,
          message: `backend module ${m.slug} claims to provide the client-internal seam "${key}"`,
          fixHint: 'Client-internal seams are provided by frontend modules. Reassign the provider.',
        });
      }
    }
  }

  // ── 4. Granularity ─────────────────────────────────────────────────────────
  for (const m of modules) {
    if (m.est_size === 'L') {
      issues.push({
        code: 'OVERSIZED_MODULE', severity: 'warn', subject: m.slug,
        message: `${m.slug} is estimated over 400 lines`,
        fixHint: 'Split it into two modules with a seam between them — that is one more place two people can work at once.',
      });
    }
  }
  if (modules.length > 30) {
    issues.push({
      code: 'TOO_MANY_MODULES', severity: 'warn', subject: String(modules.length),
      message: `${modules.length} modules is a lot for one project`,
      fixHint: 'Over-splitting is worse than not splitting. Merge modules that would always be edited together.',
    });
  }

  // ── 5. Capability coverage ─────────────────────────────────────────────────
  const coveredCaps = new Set<string>();
  for (const seam of seams) {
    const isUsed = providers.has(seam.key);
    if (!isUsed) continue;
    for (const id of seam.capability_ids) coveredCaps.add(id);
  }
  for (const cap of capabilities) {
    if (!coveredCaps.has(cap.id)) {
      issues.push({
        code: 'UNCOVERED_CAPABILITY', severity: 'warn', subject: cap.id,
        message: `nothing was built for "${cap.text}"`,
        fixHint: 'Either the brief promises something the split forgot, or this capability needs no seam of its own.',
      });
    }
  }

  // ── 6. Acyclicity ──────────────────────────────────────────────────────────
  const cycle = findCycle(modules, providers);
  if (cycle) {
    issues.push({
      code: 'CYCLE', severity: 'block', subject: cycle.join(' → '),
      message: `circular dependency: ${cycle.join(' → ')}`,
      fixHint: 'SparkX will not break this for you — which module depends on which is a design decision. Invert one edge, or extract a shared module both depend on.',
    });
  }

  return issues;
}

/** Depth-first search over provider → consumer edges. Returns the first cycle found. */
function findCycle(modules: SplitModule[], providers: Map<string, string[]>): string[] | null {
  const edges = new Map<string, Set<string>>();
  for (const m of modules) edges.set(m.slug, new Set());
  for (const m of modules) {
    for (const key of m.consumes) {
      for (const providerSlug of providers.get(key) ?? []) {
        if (providerSlug !== m.slug) edges.get(m.slug)?.add(providerSlug);
      }
    }
  }

  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map<string, number>();
  for (const m of modules) colour.set(m.slug, WHITE);
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    colour.set(node, GREY);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (colour.get(next) === GREY) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (colour.get(next) === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    colour.set(node, BLACK);
    return null;
  };

  for (const m of modules) {
    if (colour.get(m.slug) === WHITE) {
      const found = visit(m.slug);
      if (found) return found;
    }
  }
  return null;
}
