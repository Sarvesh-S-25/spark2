import { pascal, camel } from '../../util.js';
import {
  banner, tsInterfaceBody, tsScalar, fieldsOf, unwrapArray, pathParts, safeKey,
  type LanguagePack, type GenContract, type GenFile,
} from '../pack.js';

const OUT = 'src/spark';

const fnName = (key: string) => camel(key.replace(/\./g, '_'));
const typeBase = (key: string) => pascal(key.replace(/\./g, '_'));
const fileBase = (key: string) => key.replace(/\./g, '-');

/**
 * TypeScript + React + fetch.
 *
 * The point of this pack: the frontend developer gets a real, typed, callable
 * function on day one, backed by the contract's own examples until the server
 * exists. They write their CSS, their layout and their gestures against
 * correctly-shaped data, and the only thing they have to remember is the name.
 */
export const tsReactFetch: LanguagePack = {
  id: 'ts-react-fetch',
  label: 'TypeScript · React · fetch',
  lane: 'frontend',

  emitRuntime(): GenFile[] {
    const body = `
export interface SparkConfig {
  /** Where the backend lives. Point this at your API in one place. */
  baseUrl: string;
  /** Contract keys to serve from their examples instead of the network. */
  mock: 'all' | 'none' | string[];
  /** Extra headers on every request — auth token, tracing, whatever. */
  headers: () => Record<string, string>;
}

export const sparkConfig: SparkConfig = {
  baseUrl: '',
  mock: 'all',
  headers: () => ({}),
};

/** True while a contract should be served from its example data. */
export function isMocked(contractKey: string): boolean {
  const m = sparkConfig.mock;
  if (m === 'all') return true;
  if (m === 'none') return false;
  return m.includes(contractKey);
}

/** Every error a generated client throws. \`code\` is the contract's own error code. */
export class SparkError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly contract: string,
    message?: string,
  ) {
    super(message ?? \`\${contract} failed with \${code}\`);
    this.name = 'SparkError';
  }
}

export async function sparkFetch<T>(
  contract: string,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, unknown>,
): Promise<T> {
  const url = new URL(sparkConfig.baseUrl + path, sparkConfig.baseUrl || window.location.origin);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }

  const res = await fetch(url.toString(), {
    method,
    headers: { 'Content-Type': 'application/json', ...sparkConfig.headers() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    let code = 'UNKNOWN';
    let message: string | undefined;
    try {
      const err = await res.json() as { code?: string; message?: string };
      code = err.code ?? code;
      message = err.message;
    } catch { /* a non-JSON error body is still an error */ }
    throw new SparkError(code, res.status, contract, message);
  }

  return await res.json() as T;
}

type Handler<T> = (event: T) => void;

/**
 * Subscribes to a server-pushed event contract.
 *
 * While mocked it replays the contract's example once a second, so a live view
 * can be built and demoed before any websocket exists.
 */
export function sparkSubscribe<T>(
  contract: string,
  channel: string,
  handler: Handler<T>,
  mockEvent?: T,
): () => void {
  if (isMocked(contract)) {
    if (mockEvent === undefined) return () => {};
    const timer = setInterval(() => handler(structuredClone(mockEvent)), 1000);
    return () => clearInterval(timer);
  }

  const wsUrl = (sparkConfig.baseUrl || window.location.origin)
    .replace(/^http/, 'ws') + '/ws';
  const socket = new WebSocket(wsUrl);
  socket.addEventListener('open', () => socket.send(JSON.stringify({ subscribe: channel })));
  socket.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data as string) as { channel?: string; payload?: T };
      if (msg.channel === channel && msg.payload !== undefined) handler(msg.payload);
    } catch { /* ignore frames we do not understand */ }
  });
  return () => socket.close();
}
`.trimStart();

    return [{
      path: `${OUT}/runtime.ts`,
      content: banner('//', { note: 'Shared runtime for every generated client.' }, body),
    }];
  },

  emitTypes(contracts: GenContract[]): GenFile[] {
    const blocks: string[] = [];

    for (const c of contracts) {
      if (c.kind === 'type') {
        blocks.push(
          `/** ${c.spec.summary || c.key} — contract ${c.key}@${c.semver} */\n` +
          `export interface ${c.spec.transport.symbol || typeBase(c.key)} {\n${tsInterfaceBody(c.spec.output)}\n}`,
        );
        continue;
      }

      const base = typeBase(c.key);
      if (fieldsOf(c.spec.input).length > 0) {
        blocks.push(`/** Input for ${c.key}@${c.semver} */\nexport interface ${base}Input {\n${tsInterfaceBody(c.spec.input)}\n}`);
      }
      const { isArray } = unwrapArray(c.spec.output);
      const itemName = `${base}Item`;
      if (isArray) {
        blocks.push(`export interface ${itemName} {\n${tsInterfaceBody(c.spec.output)}\n}`);
        blocks.push(`export type ${base}Output = ${itemName}[];`);
      } else {
        blocks.push(`export interface ${base}Output {\n${tsInterfaceBody(c.spec.output)}\n}`);
      }
      if (c.spec.errors.length > 0) {
        blocks.push(
          `/** Error codes ${c.key} can produce. */\n` +
          `export type ${base}Error = ${c.spec.errors.map((e) => JSON.stringify(e.code)).join(' | ')};`,
        );
      }
    }

    const allCodes = [...new Set(contracts.flatMap((c) => c.spec.errors.map((e) => e.code)))].sort();
    if (allCodes.length > 0) {
      blocks.push(
        `/** Every error code in this project, in one place. */\n` +
        `export const SPARK_ERROR_CODES = [\n${allCodes.map((c) => `  ${JSON.stringify(c)},`).join('\n')}\n] as const;\n` +
        `export type SparkErrorCode = typeof SPARK_ERROR_CODES[number];`,
      );
    }

    return [{
      path: `${OUT}/types.ts`,
      content: banner('//', { note: 'Every shared shape in this project.' }, blocks.join('\n\n') + '\n'),
    }];
  },

  emitClient(c: GenContract): GenFile[] {
    // A server-internal boundary is not the frontend's business, and emitting a
    // client for one would invite exactly the LANE_LEAK the checker looks for.
    if (c.kind === 'type' || c.spec.direction === 'server_internal') return [];
    const base = typeBase(c.key);
    const fn = fnName(c.key);
    const hasInput = fieldsOf(c.spec.input).length > 0;
    const argSig = hasInput ? `args: T.${base}Input` : '';
    const mockImport = `import { ${fn}Mock } from '../mocks/${fileBase(c.key)}.js';`;

    let body: string;

    if (c.kind === 'event') {
      const channel = c.spec.transport.symbol || c.key;
      body = `
import { sparkSubscribe } from '../runtime.js';
import type * as T from '../types.js';
${mockImport}

/**
 * ${c.spec.summary || c.key}
 *
 * Returns an unsubscribe function. While \`sparkConfig.mock\` covers this
 * contract, the example event replays once a second so a live view can be
 * built before the server pushes anything.
 */
export function ${fn}(handler: (event: T.${base}Output) => void): () => void {
  return sparkSubscribe<T.${base}Output>(
    ${JSON.stringify(c.key)},
    ${JSON.stringify(channel)},
    handler,
    ${fn}Mock,
  );
}
`.trimStart();
    } else if (c.kind === 'function') {
      body = `
import type * as T from '../types.js';
${mockImport}

/**
 * ${c.spec.summary || c.key}
 *
 * This is an in-lane boundary, not a network call: the module that provides it
 * lives in the same codebase. Import this type, build against \`${fn}Mock\`, and
 * swap in the real implementation when it lands.
 */
export type ${base} = (${hasInput ? `args: T.${base}Input` : ''}) => T.${base}Output;

export const ${fn}: ${base} = ${hasInput ? '(args)' : '()'} => ${fn}Mock;
`.trimStart();
    } else {
      // http and config both travel over HTTP.
      const method = c.spec.transport.method || 'GET';
      const rawPath = c.spec.transport.path || `/api/${c.key.replace(/\./g, '/')}`;
      const { params, template } = pathParts(rawPath);
      const bodyFields = fieldsOf(c.spec.input).filter((f) => !params.includes(f.name));
      const sendsBody = method !== 'GET' && method !== 'DELETE' && bodyFields.length > 0;
      const query = method === 'GET' && bodyFields.length > 0
        ? `{ ${bodyFields.map((f) => safeKey(f.name) + ': args.' + f.name).join(', ')} }`
        : 'undefined';
      const payload = sendsBody
        ? `{ ${bodyFields.map((f) => safeKey(f.name) + ': args.' + f.name).join(', ')} }`
        : 'undefined';

      body = `
import { sparkFetch, isMocked } from '../runtime.js';
import type * as T from '../types.js';
${mockImport}

/**
 * ${c.spec.summary || c.key}
 *
 * ${method} ${rawPath}
${c.spec.errors.map((e) => ` * Throws SparkError ${e.code} when ${e.when || 'the server says so'}.`).join('\n') || ' *'}
 */
export async function ${fn}(${argSig}): Promise<T.${base}Output> {
  if (isMocked(${JSON.stringify(c.key)})) return structuredClone(${fn}Mock);
  return sparkFetch<T.${base}Output>(
    ${JSON.stringify(c.key)},
    ${JSON.stringify(method)},
    \`${template}\`,
    ${payload},
    ${query},
  );
}
`.trimStart();
    }

    return [{
      path: `${OUT}/client/${fileBase(c.key)}.ts`,
      content: banner('//', { contract: c.key, semver: c.semver, specHash: c.hash }, body),
    }];
  },

  emitMocks(c: GenContract): GenFile[] {
    if (c.kind === 'type' || c.spec.direction === 'server_internal') return [];
    const base = typeBase(c.key);
    const fn = fnName(c.key);
    const example = c.examples[0]?.output ?? {};
    const body = `
import type * as T from '../types.js';

/**
 * Straight from the contract's first example.
 *
 * Edit the example in SparkX, not this file — the same example is also the
 * backend's contract-test fixture, and the two must not drift apart.
 */
export const ${fn}Mock: T.${base}Output = ${JSON.stringify(example, null, 2)};
`.trimStart();

    return [{
      path: `${OUT}/mocks/${fileBase(c.key)}.ts`,
      content: banner('//', { contract: c.key, semver: c.semver, specHash: c.hash }, body),
    }];
  },

  emitServerStub(): GenFile[] {
    return []; // frontend pack — the provider side belongs to a backend pack
  },

  emitContractTest(): GenFile[] {
    return []; // the contract test asserts the provider, so backend packs emit it
  },
};

/** Barrel file giving `sparkClient.markers.list(...)` style access. */
export function tsClientIndex(contracts: GenContract[]): GenFile {
  const usable = contracts.filter((c) => c.kind !== 'type' && c.spec.direction !== 'server_internal');
  const imports = usable
    .map((c) => `import { ${fnName(c.key)} } from './${fileBase(c.key)}.js';`)
    .join('\n');

  const tree: Record<string, any> = {};
  for (const c of usable) {
    const parts = c.key.split('.');
    let node = tree;
    for (const p of parts.slice(0, -1)) node = node[p] ??= {};
    node[parts[parts.length - 1]] = fnName(c.key);
  }
  const render = (node: any, indent = '  '): string =>
    Object.entries(node)
      .map(([k, v]) =>
        typeof v === 'string'
          ? `${indent}${safeKey(k)}: ${v},`
          : `${indent}${safeKey(k)}: {\n${render(v, indent + '  ')}\n${indent}},`)
      .join('\n');

  const body = `
${imports}

${usable.map((c) => `export { ${fnName(c.key)} } from './${fileBase(c.key)}.js';`).join('\n')}

/**
 * Every contract this project has, grouped by key.
 *
 *   const markers = await sparkClient.markers.list({ bbox });
 */
export const sparkClient = {
${render(tree)}
};
`.trimStart();

  return {
    path: `${OUT}/client/index.ts`,
    content: banner('//', { note: 'Client barrel.' }, body),
  };
}
