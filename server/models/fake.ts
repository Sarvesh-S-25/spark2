import type { Provider, CompleteRequest, CompleteResult } from './types.js';
import { FEATURES, BASE_SEAMS, BASE_MODULES, type Feature } from './heuristics.js';
import type { Seam, SplitModule, Capability } from '../splitter/schemas.js';

/**
 * The offline provider.
 *
 * It answers the same three passes a real model does, using the rule table in
 * ./heuristics.ts instead of inference. That makes it:
 *
 *   • the zero-setup path — SparkX is fully usable with no key and no network;
 *   • completely deterministic, so the splitter's validations and the UI can be
 *     developed and tested without spending a token;
 *   • the floor a real model has to beat. If a 7B local model scores worse than
 *     this on the eval set, use this instead.
 *
 * It is honest about what it is: it recognises project *shapes*, not meaning.
 * Give it a brief outside its rule table and it will fall back to a generic
 * list-and-create split, which is the correct thing for it to do.
 */
export class FakeProvider implements Provider {
  readonly id = 'fake' as const;
  readonly model = 'heuristic-v1';

  async health() {
    return {
      ok: true,
      detail: 'built-in heuristic planner — no key, no network, deterministic',
    };
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const ctx = (req.context ?? {}) as {
      brief?: string;
      capabilities?: Capability[];
      seams?: Seam[];
    };
    const brief = ctx.brief ?? req.user;

    let json: unknown;
    switch (req.schemaName) {
      case 'pass_a': json = { capabilities: passA(brief) }; break;
      case 'pass_b': json = { seams: passB(brief, ctx.capabilities ?? []) }; break;
      case 'pass_c': json = { modules: passC(brief, ctx.seams ?? []) }; break;
      case 'plan_draft': json = planDraft(brief); break;
      default: json = {};
    }

    return {
      json,
      model: this.model,
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    };
  }
}

// ── matching ─────────────────────────────────────────────────────────────────

export function matchFeatures(brief: string): Feature[] {
  const hits = FEATURES.filter((f) => f.match.test(brief));
  // `crud` is the catch-all. Only use it when it is the only thing that fired,
  // or when nothing did — otherwise a map project also grows a generic item list.
  const specific = hits.filter((f) => f.id !== 'crud');
  if (specific.length > 0) return specific;
  const crud = FEATURES.find((f) => f.id === 'crud')!;
  return [crud];
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((s) => s.length > 8);
}

/** Finds the phrase in the brief a capability most plausibly came from. */
function quoteFor(text: string, brief: string): string {
  const words = text.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  let best = '';
  let bestScore = 0;
  for (const s of sentences(brief)) {
    const low = s.toLowerCase();
    const score = words.reduce((n, w) => n + (low.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return bestScore >= 2 ? best.slice(0, 160) : '';
}

// ── the three passes ─────────────────────────────────────────────────────────

function passA(brief: string): Capability[] {
  const features = matchFeatures(brief);
  const out: Capability[] = [];
  const seen = new Set<string>();

  for (const f of features) {
    for (const c of f.capabilities) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ ...c, source_quote: quoteFor(c.text, brief) });
    }
  }
  if (out.length === 0) {
    out.push({
      id: 'use-app',
      text: 'use the application described in the brief',
      actor: 'end user',
      source_quote: sentences(brief)[0] ?? '',
    });
  }
  return out;
}

function passB(brief: string, capabilities: Capability[]): Seam[] {
  const features = matchFeatures(brief);
  const capIds = new Set(capabilities.map((c) => c.id));
  const out: Seam[] = [...BASE_SEAMS];
  const seen = new Set(out.map((s) => s.key));

  for (const f of features) {
    for (const s of f.seams) {
      if (seen.has(s.key)) continue;
      // Keep a seam if it serves a capability that survived Pass A, or if it
      // is unattributed plumbing (a shared type, an internal boundary).
      const relevant = s.capability_ids.length === 0 || s.capability_ids.some((id) => capIds.has(id));
      if (!relevant) continue;
      seen.add(s.key);
      out.push(s);
    }
  }
  return out;
}

function planDraft(idea: string) {
  const features = matchFeatures(idea);
  const caps = features.flatMap((f) => f.capabilities);
  const first = sentences(idea)[0] ?? idea.trim();
  const title = first.split(/\s+/).slice(0, 5).join(' ').replace(/[.,;:]$/, '') || 'New project';

  const dataShapes = [...new Set(
    features.flatMap((f) => f.seams.filter((s) => s.kind === 'type').map((s) => s.key)),
  )];

  const brief_md = `# ${title}

${first}

## Who uses it, and what they can do

${caps.map((c) => `- (${c.actor}) ${c.text}`).join('\n')}

## What the system holds

${dataShapes.length ? dataShapes.map((d) => `- ${d}`).join('\n') : '- Not yet determined.'}

## Not in this version

- Anything not listed above. Scope grows by editing this plan, not by surprise.
`;

  return {
    title,
    brief_md,
    assumptions: [
      'Capabilities were inferred from the project shapes this brief resembles, not from anything you stated explicitly.',
      'No authentication is assumed unless the brief mentions accounts or sign-in.',
    ],
    open_questions: [
      'Who are the users, and does anyone need to sign in?',
      'Roughly how much data, and how often does it change?',
      'Web only, or is there a mobile client too?',
    ],
  };
}

function passC(brief: string, seams: Seam[]): SplitModule[] {
  const features = matchFeatures(brief);
  const keys = new Set(seams.map((s) => s.key));
  const out: SplitModule[] = [];
  const seen = new Set<string>();

  const push = (m: SplitModule) => {
    if (seen.has(m.slug)) return;
    // Drop references to seams that did not survive Pass B.
    const provides = m.provides.filter((k) => keys.has(k));
    const consumes = m.consumes.filter((k) => keys.has(k));
    // A module with nothing on either side of it is not a boundary; skip it
    // unless it is a leaf presentation or persistence unit.
    if (provides.length === 0 && consumes.length === 0 && m.kind !== 'ui_component' && m.kind !== 'adapter') return;
    seen.add(m.slug);
    out.push({ ...m, provides, consumes });
  };

  for (const m of BASE_MODULES) push(m);
  for (const f of features) for (const m of f.modules) push(m);

  // Every `type` contract needs a provider, and the natural one is a single
  // shared module both lanes import from.
  const typeKeys = seams.filter((s) => s.kind === 'type').map((s) => s.key);
  if (typeKeys.length > 0) {
    out.push({
      slug: 'sh.domain-types',
      name: 'Domain types',
      lane: 'shared',
      kind: 'schema',
      summary: 'The data shapes both lanes agree on, generated into each language from one definition.',
      responsibilities: ['own every shared data shape', 'own the shared error-code enum'],
      non_goals: ['any behaviour at all — this module holds no logic'],
      provides: typeKeys,
      consumes: [],
      files: ['src/spark/types.ts', 'server/spark/types.py'],
      acceptance: ['every shared shape is emitted for both lanes from one source'],
      est_size: 'S',
    });
  }

  return out;
}
