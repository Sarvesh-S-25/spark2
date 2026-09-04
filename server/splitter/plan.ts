import { z } from 'zod';
import { runPass } from '../models/harness.js';
import type { JSONSchema } from '../models/types.js';

/**
 * Plan Studio.
 *
 * The second front door. Some people arrive with a written spec; some arrive
 * with "a live tracker on a map". This turns the second into the first, and the
 * result is an ordinary editable plan — not a hidden prompt. Everything
 * downstream traces back to a plan revision, so "why does this module exist?"
 * always has an answer you can read.
 */

export const zPlanDraft = z.object({
  title: z.string().min(1),
  brief_md: z.string().min(40),
  assumptions: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([]),
});
export type PlanDraft = z.infer<typeof zPlanDraft>;

export const PLAN_JSON_SCHEMA: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'brief_md', 'assumptions', 'open_questions'],
  properties: {
    title: { type: 'string', description: 'short project name' },
    brief_md: {
      type: 'string',
      description: 'the plan as markdown: what it is, who uses it, what they can do, what it explicitly will not do',
    },
    assumptions: {
      type: 'array', items: { type: 'string' },
      description: 'things you filled in that the person did not say',
    },
    open_questions: {
      type: 'array', items: { type: 'string' },
      description: 'decisions that genuinely change the build and are still unmade',
    },
  },
};

const PLAN_SYSTEM = `
You are the planning assistant inside SparkX. Turn a rough idea into a plan
specific enough to decompose into frontend and backend modules.

The plan must cover, in this order:
  1. What the thing is, in two sentences.
  2. Who uses it and what each of them can do — as a bulleted list of concrete
     capabilities, one per line, in plain language.
  3. What data the system holds.
  4. What it explicitly does NOT do in this version.

Rules:
- Return JSON only.
- Write the plan in markdown in brief_md.
- Do not choose a database, framework or hosting provider. Those are the
  builder's decisions and putting them in the plan biases the split.
- Anything you invent that the person did not say goes in assumptions, so they
  can see it and disagree.
- open_questions is for decisions that genuinely change the build. Do not pad it.
`.trim();

export async function draftPlan(opts: {
  idea: string;
  projectId?: string;
}): Promise<{ ok: boolean; draft: PlanDraft | null; errors: string[]; meta: any }> {
  const r = await runPass({
    pass: 'A',
    purpose: 'plan:draft',
    projectId: opts.projectId,
    system: PLAN_SYSTEM,
    user: `Rough idea:\n\n${opts.idea.trim()}`,
    schema: PLAN_JSON_SCHEMA,
    schemaName: 'plan_draft',
    zod: zPlanDraft,
    context: { brief: opts.idea },
  });
  return { ok: r.ok, draft: r.data, errors: r.errors, meta: r.meta };
}
