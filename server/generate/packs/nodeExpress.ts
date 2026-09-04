import { pascal, camel } from '../../util.js';
import {
  banner, tsInterfaceBody, fieldsOf, unwrapArray, tsScalar,
  type LanguagePack, type GenContract, type GenFile,
} from '../pack.js';

const OUT = 'server/spark';

const fnName = (key: string) => camel(key.replace(/\./g, '_'));
const typeBase = (key: string) => pascal(key.replace(/\./g, '_'));
const fileBase = (key: string) => key.replace(/\./g, '-');

/**
 * Node + Express.
 *
 * The provider side. The backend developer opens their module and finds the
 * path already correct, a validator already written from the input schema, a
 * handler that throws NotImplemented, and a failing test asserting the
 * contract's own example. Their job is unambiguous: make the test pass.
 */
export const nodeExpress: LanguagePack = {
  id: 'node-express',
  label: 'Node · Express · TypeScript',
  lane: 'backend',

  emitRuntime(): GenFile[] {
    const body = `
import type { Request, Response, NextFunction } from 'express';

/** Thrown by every un-implemented handler. Seeing this in production is a bug. */
export class NotImplemented extends Error {
  constructor(readonly contract: string) {
    super(\`\${contract} is not implemented yet\`);
    this.name = 'NotImplemented';
  }
}

/** An error the contract declares. Anything else is a 500 and your fault. */
export class ContractError extends Error {
  constructor(readonly code: string, readonly status: number, message?: string) {
    super(message ?? code);
    this.name = 'ContractError';
  }
}

export interface FieldRule {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required: boolean;
}

/**
 * Validates one request against a contract's input schema.
 *
 * Deliberately dependency-free — a generated file should never force a library
 * choice on the project it lands in.
 */
export function validate(rules: FieldRule[], source: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const rule of rules) {
    const value = source[rule.name];
    if (value === undefined || value === null || value === '') {
      if (rule.required) problems.push(\`\${rule.name} is required\`);
      continue;
    }
    const actual = Array.isArray(value) ? 'array' : typeof value;
    if (rule.type === 'number' && actual === 'string' && !Number.isNaN(Number(value))) continue;
    if (rule.type === 'boolean' && (value === 'true' || value === 'false')) continue;
    if (rule.type === 'array' && actual === 'string') continue; // comma-joined query param
    if (actual !== rule.type) {
      problems.push(\`\${rule.name} should be \${rule.type}, got \${actual}\`);
    }
  }
  return problems;
}

/** Express error shape every generated route uses, so clients see one format. */
export function sendError(res: Response, code: string, status: number, message?: string): void {
  res.status(status).json({ code, message: message ?? code });
}

export function wrap(
  contract: string,
  handler: (req: Request, res: Response) => Promise<void>,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof ContractError) return sendError(res, err.code, err.status, err.message);
      if (err instanceof NotImplemented) return sendError(res, 'NOT_IMPLEMENTED', 501, err.message);
      next(err);
    }
  };
}
`.trimStart();

    return [{
      path: `${OUT}/runtime.ts`,
      content: banner('//', { note: 'Shared runtime for every generated route.' }, body),
    }];
  },

  emitTypes(contracts: GenContract[]): GenFile[] {
    const blocks: string[] = [];
    for (const c of contracts) {
      if (c.kind === 'type') {
        blocks.push(`export interface ${c.spec.transport.symbol || typeBase(c.key)} {\n${tsInterfaceBody(c.spec.output)}\n}`);
        continue;
      }
      const base = typeBase(c.key);
      if (fieldsOf(c.spec.input).length > 0) {
        blocks.push(`export interface ${base}Input {\n${tsInterfaceBody(c.spec.input)}\n}`);
      }
      const { isArray } = unwrapArray(c.spec.output);
      if (isArray) {
        blocks.push(`export interface ${base}Item {\n${tsInterfaceBody(c.spec.output)}\n}`);
        blocks.push(`export type ${base}Output = ${base}Item[];`);
      } else {
        blocks.push(`export interface ${base}Output {\n${tsInterfaceBody(c.spec.output)}\n}`);
      }
    }
    return [{
      path: `${OUT}/types.ts`,
      content: banner('//', { note: 'Server-side view of every contract shape.' }, blocks.join('\n\n') + '\n'),
    }];
  },

  emitClient(): GenFile[] {
    return []; // backend pack — the consumer side belongs to a frontend pack
  },

  emitServerStub(c: GenContract): GenFile[] {
    if (c.kind === 'type' || c.kind === 'function') return [];

    const base = typeBase(c.key);
    const fn = fnName(c.key);
    const hasInput = fieldsOf(c.spec.input).length > 0;

    if (c.kind === 'event') {
      const channel = c.spec.transport.symbol || c.key;
      const body = `
import { NotImplemented } from '../runtime.js';
import type * as T from '../types.js';

/**
 * ${c.spec.summary || c.key}
 *
 * Server-pushed. Call \`publish${base}\` wherever the event actually happens;
 * the transport (websocket, SSE, pub/sub) is your choice — this file only
 * fixes the payload shape and the channel name.
 */
export const ${fn}Channel = ${JSON.stringify(channel)};

export type ${base}Publisher = (payload: T.${base}Output) => void | Promise<void>;

let publisher: ${base}Publisher | null = null;

export function register${base}Publisher(p: ${base}Publisher): void {
  publisher = p;
}

export async function publish${base}(payload: T.${base}Output): Promise<void> {
  if (!publisher) throw new NotImplemented(${JSON.stringify(c.key)});
  await publisher(payload);
}
`.trimStart();
      return [{
        path: `${OUT}/routes/${fileBase(c.key)}.ts`,
        content: banner('//', { contract: c.key, semver: c.semver, specHash: c.hash }, body),
      }];
    }

    const method = (c.spec.transport.method || 'GET').toLowerCase();
    const path = c.spec.transport.path || `/api/${c.key.replace(/\./g, '/')}`;
    const rules = fieldsOf(c.spec.input).map((f) => ({
      name: f.name,
      type: ruleType(f.prop),
      required: f.required,
    }));
    const readsQuery = method === 'get' || method === 'delete';

    const body = `
import { Router } from 'express';
import { NotImplemented, validate, sendError, wrap, type FieldRule } from '../runtime.js';
import type * as T from '../types.js';

/** ${c.spec.summary || c.key} — ${method.toUpperCase()} ${path} */
export type ${base}Handler = (${hasInput ? `args: T.${base}Input` : ''}) => Promise<T.${base}Output>;

const RULES: FieldRule[] = ${JSON.stringify(rules, null, 2)};

/** The default implementation. Replacing this is the whole job. */
export const not${base}: ${base}Handler = async (${hasInput ? '_args' : ''}) => {
  throw new NotImplemented(${JSON.stringify(c.key)});
};

export function ${fn}Router(impl: ${base}Handler = not${base}): Router {
  const router = Router();

  router.${method}(${JSON.stringify(path)}, wrap(${JSON.stringify(c.key)}, async (req, res) => {
    const input = { ...req.params, ...${readsQuery ? 'req.query' : 'req.body'} } as Record<string, unknown>;
    const problems = validate(RULES, input);
    if (problems.length > 0) {
      return sendError(res, ${JSON.stringify(c.spec.errors[0]?.code ?? 'INPUT_INVALID')}, 400, problems.join('; '));
    }
    const result = await impl(${hasInput ? `input as unknown as T.${base}Input` : ''});
    res.json(result);
  }));

  return router;
}

/* Error codes this contract is allowed to return:
${c.spec.errors.map((e) => ` *   ${e.code} (${e.http}) — ${e.when || 'unspecified'}`).join('\n') || ' *   (none declared)'}
 * Anything else reaching the client is a bug, not a contract.
 */
`.trimStart();

    return [{
      path: `${OUT}/routes/${fileBase(c.key)}.ts`,
      content: banner('//', { contract: c.key, semver: c.semver, specHash: c.hash }, body),
    }];
  },

  emitMocks(): GenFile[] {
    return [];
  },

  emitContractTest(c: GenContract): GenFile[] {
    if (c.kind === 'type' || c.kind === 'function' || c.kind === 'event') return [];
    const base = typeBase(c.key);
    const fn = fnName(c.key);
    const example = c.examples[0];
    if (!example) return [];

    const { isArray } = unwrapArray(c.spec.output);
    const expectedKeys = fieldsOf(c.spec.output).filter((f) => f.required).map((f) => f.name);

    const body = `
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { not${base} } from '../routes/${fileBase(c.key)}.js';

/**
 * The contract test.
 *
 * It is generated from the contract's example — the same example the frontend's
 * mock is built from. That is the point: when this passes, the two sides agree.
 *
 * Replace \`not${base}\` with your real handler as soon as you have one. Until
 * then this test fails, which is exactly what a to-do looks like in code.
 */
const EXAMPLE_INPUT = ${JSON.stringify(example.input, null, 2)} as any;

test('${c.key} matches its contract example', async () => {
  const result = await not${base}(EXAMPLE_INPUT);
${isArray
        ? `  assert.ok(Array.isArray(result), 'output should be an array');
  const first = (result as any[])[0] ?? {};`
        : `  assert.equal(typeof result, 'object', 'output should be an object');
  const first = result as any;`}
${expectedKeys.map((k) => `  assert.ok(${JSON.stringify(k)} in first, 'missing required output field: ${k}');`).join('\n') || '  // contract declares no required output fields'}
});
`.trimStart();

    return [{
      path: `${OUT}/tests/${fileBase(c.key)}.test.ts`,
      content: banner('//', { contract: c.key, semver: c.semver, specHash: c.hash }, body),
    }];
  },
};

function ruleType(prop: any): 'string' | 'number' | 'boolean' | 'array' | 'object' {
  if (prop?.type === 'array') return 'array';
  if (prop?.type === 'number' || prop?.type === 'integer') return 'number';
  if (prop?.type === 'boolean') return 'boolean';
  if (prop?.type === 'object') return 'object';
  return 'string';
}

/** Registers every generated route on one Express app. */
export function nodeRoutesIndex(contracts: GenContract[]): GenFile {
  const routable = contracts.filter((c) => c.kind === 'http' || c.kind === 'config');
  const body = `
import type { Express } from 'express';
${routable.map((c) => `import { ${fnName(c.key)}Router } from './${fileBase(c.key)}.js';`).join('\n')}

/**
 * Mounts every contract route.
 *
 * Pass real handlers in as you build them:
 *
 *   registerSparkRoutes(app, { ${routable[0] ? fnName(routable[0].key) : 'someContract'}: myHandler });
 */
export function registerSparkRoutes(
  app: Express,
  impls: Partial<{
${routable.map((c) => `    ${fnName(c.key)}: Parameters<typeof ${fnName(c.key)}Router>[0];`).join('\n')}
  }> = {},
): void {
${routable.map((c) => `  app.use(${fnName(c.key)}Router(impls.${fnName(c.key)}));`).join('\n')}
}
`.trimStart();

  return {
    path: `${OUT}/routes/index.ts`,
    content: banner('//', { note: 'Route registry.' }, body),
  };
}
