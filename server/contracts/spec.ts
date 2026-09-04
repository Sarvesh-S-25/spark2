import { z } from 'zod';
import { pascal, camel, snake } from '../util.js';
import type { Field, Seam } from '../splitter/schemas.js';

/**
 * A contract: the frozen description of one boundary between two modules.
 *
 * This is the object the whole product exists to produce. Everything else —
 * the splitter, the board, the checker — is scaffolding around getting these
 * right and noticing when reality stops matching them.
 */

export const zTransport = z.object({
  method: z.string().default(''),
  path: z.string().default(''),
  symbol: z.string().default(''),
});

export const zContractError = z.object({
  code: z.string(),
  when: z.string().default(''),
  http: z.number().int().default(400),
});

export const zContractSpec = z.object({
  key: z.string(),
  kind: z.enum(['http', 'function', 'event', 'type', 'config']),
  direction: z.string().default('shared'),
  summary: z.string().default(''),
  transport: zTransport,
  input: z.record(z.unknown()),   // JSON Schema
  output: z.record(z.unknown()),  // JSON Schema
  errors: z.array(zContractError).default([]),
});

export type ContractSpec = z.infer<typeof zContractSpec>;
export type ContractExample = { input: unknown; output: unknown };

export type ContractState = 'draft' | 'proposed' | 'locked' | 'deprecated' | 'removed';

// Re-exported for convenience; the implementations live in ../util.ts.
export { pascal, camel, snake };
