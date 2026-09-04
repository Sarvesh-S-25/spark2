import type { z } from 'zod';
import { db, uid, now, sha256, stable } from '../db/db.js';
import { env, type PassId } from '../env.js';
import { providerFor } from './registry.js';
import type { JSONSchema } from './types.js';

/**
 * The prompt harness: the only place in SparkX that calls a model.
 *
 * What it adds on top of a raw provider call:
 *
 *   1. **Validation.** The response is parsed with a Zod schema. A response
 *      that does not fit is not a result, it is a failed attempt.
 *   2. **Repair.** A failed attempt is fed its own validation errors and asked
 *      again, at most `SPARK_MAX_REPAIRS` times. After that the harness gives
 *      up and returns the raw attempt so the caller can hand the user a
 *      partially-filled editor — a half-correct draft they can fix in ninety
 *      seconds beats a third retry and a spinner.
 *   3. **Caching.** Keyed on sha256(system + user + schema + model). Re-running
 *      an unchanged split costs nothing and takes no time.
 *   4. **Accounting.** Every attempt lands in `model_run` with tokens, cost and
 *      latency, which is what the cost meter reads.
 */

export interface PassResult<T> {
  ok: boolean;
  data: T | null;
  /** Present when ok is false: the last thing the model said, for the editor. */
  raw: unknown;
  errors: string[];
  meta: {
    provider: string;
    model: string;
    cached: boolean;
    repairs: number;
    latencyMs: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  };
}

export interface PassRequest<T> {
  pass: PassId;
  purpose: string;
  system: string;
  user: string;
  schema: JSONSchema;
  schemaName: string;
  // Input is pinned to `any` rather than left to default to T: ZodType's
  // default binds Input = Output, and several of our schemas use z.default()
  // (output required, input optional for that field). Leaving Input tied to T
  // makes TS unify T against both the required output shape and the optional
  // input shape at once, which widens every defaulted field to `| undefined`
  // everywhere `req.zod` is passed in. Pinning Input to `any` inference from
  // this property alone, so T resolves to the schema's actual output type.
  zod: z.ZodType<T, z.ZodTypeDef, any>;
  context?: Record<string, unknown>;
  projectId?: string;
}

export async function runPass<T>(req: PassRequest<T>): Promise<PassResult<T>> {
  const provider = providerFor(req.pass);
  const started = Date.now();
  const promptHash = sha256(
    stable({ s: req.system, u: req.user, sch: req.schema, m: provider.model, p: provider.id }),
  );

  // ── cache ──────────────────────────────────────────────────────────────────
  if (env.cacheEnabled) {
    const hit = db().prepare('SELECT response_json FROM prompt_cache WHERE prompt_hash = ?')
      .get(promptHash) as { response_json: string } | undefined;
    if (hit) {
      const parsed = req.zod.safeParse(JSON.parse(hit.response_json));
      if (parsed.success) {
        logRun(req, provider, promptHash, { ok: 1, cached: 1, repairs: 0, latencyMs: Date.now() - started });
        return {
          ok: true, data: parsed.data, raw: null, errors: [],
          meta: {
            provider: provider.id, model: provider.model, cached: true,
            repairs: 0, latencyMs: Date.now() - started,
            tokensIn: 0, tokensOut: 0, costUsd: 0,
          },
        };
      }
    }
  }

  // ── attempt + repair ───────────────────────────────────────────────────────
  let userMessage = req.user;
  let lastRaw: unknown = null;
  let errors: string[] = [];
  let tokensIn = 0, tokensOut = 0, costUsd = 0;

  for (let attempt = 0; attempt <= env.maxRepairs; attempt++) {
    let result;
    try {
      result = await provider.complete({
        system: req.system,
        user: userMessage,
        schema: req.schema,
        schemaName: req.schemaName,
        temperature: env.temperature,
        context: req.context,
      });
    } catch (e) {
      const message = (e as Error).message;
      logRun(req, provider, promptHash, {
        ok: 0, cached: 0, repairs: attempt, latencyMs: Date.now() - started, error: message,
      });
      return {
        ok: false, data: null, raw: null, errors: [message],
        meta: {
          provider: provider.id, model: provider.model, cached: false,
          repairs: attempt, latencyMs: Date.now() - started, tokensIn, tokensOut, costUsd,
        },
      };
    }

    tokensIn += result.usage.tokensIn;
    tokensOut += result.usage.tokensOut;
    costUsd += result.usage.costUsd;
    lastRaw = result.json;

    const parsed = req.zod.safeParse(result.json);
    if (parsed.success) {
      if (env.cacheEnabled) {
        db().prepare(
          'INSERT OR REPLACE INTO prompt_cache (prompt_hash, response_json, created_at) VALUES (?,?,?)',
        ).run(promptHash, JSON.stringify(result.json), now());
      }
      logRun(req, provider, promptHash, {
        ok: 1, cached: 0, repairs: attempt, latencyMs: Date.now() - started,
        tokensIn, tokensOut, costUsd,
      });
      return {
        ok: true, data: parsed.data, raw: null, errors: [],
        meta: {
          provider: provider.id, model: provider.model, cached: false,
          repairs: attempt, latencyMs: Date.now() - started, tokensIn, tokensOut, costUsd,
        },
      };
    }

    errors = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    userMessage = `${req.user}

Your previous response did not fit the required shape. These are the exact problems:
${errors.map((e) => `  - ${e}`).join('\n')}

Return the corrected JSON only. Change nothing that was already valid.`;
  }

  logRun(req, provider, promptHash, {
    ok: 0, cached: 0, repairs: env.maxRepairs, latencyMs: Date.now() - started,
    tokensIn, tokensOut, costUsd, error: errors.join('; ').slice(0, 500),
  });

  return {
    ok: false, data: null, raw: lastRaw, errors,
    meta: {
      provider: provider.id, model: provider.model, cached: false,
      repairs: env.maxRepairs, latencyMs: Date.now() - started, tokensIn, tokensOut, costUsd,
    },
  };
}

function logRun(
  req: PassRequest<any>,
  provider: { id: string; model: string },
  promptHash: string,
  x: {
    ok: number; cached: number; repairs: number; latencyMs: number;
    tokensIn?: number; tokensOut?: number; costUsd?: number; error?: string;
  },
): void {
  db().prepare(`
    INSERT INTO model_run
      (id, project_id, provider, model, purpose, prompt_hash, tokens_in, tokens_out,
       cost_usd, latency_ms, ok, repair_count, cached, error, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    uid('run'), req.projectId ?? null, provider.id, provider.model, req.purpose, promptHash,
    x.tokensIn ?? 0, x.tokensOut ?? 0, x.costUsd ?? 0, x.latencyMs,
    x.ok, x.repairs, x.cached, x.error ?? null, now(),
  );
}
