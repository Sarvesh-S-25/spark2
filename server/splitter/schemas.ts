import { z } from 'zod';
import type { JSONSchema } from '../models/types.js';

/**
 * The three pass schemas, and the field vocabulary they share.
 *
 * A deliberate design decision lives here: the model is NEVER asked to write
 * JSON Schema. It describes a field as {name, type, required} picked from a
 * closed vocabulary, and `compileSchema()` in ./compile.ts turns that into real
 * JSON Schema. Small local models are bad at emitting valid JSON Schema and
 * fine at filling in a flat table, so this trade buys most of the reliability
 * that makes a 7B model usable for the job.
 */

export const FIELD_TYPES = [
  'string', 'number', 'boolean', 'datetime', 'id',
  'string[]', 'number[]', 'object', 'object[]',
] as const;

export const LANES = ['frontend', 'backend', 'shared', 'infra'] as const;

export const MODULE_KINDS = [
  'ui_component', 'state_store', 'api_route', 'service',
  'adapter', 'job', 'schema', 'util',
] as const;

export const CONTRACT_KINDS = ['http', 'function', 'event', 'type', 'config'] as const;

export const DIRECTIONS = [
  'client_to_server', 'server_to_client', 'device_to_server',
  'client_internal', 'server_internal', 'shared',
] as const;

// ── Pass A · capabilities ────────────────────────────────────────────────────

export const zCapability = z.object({
  id: z.string().min(1),
  text: z.string().min(3),
  actor: z.string().min(1),
  source_quote: z.string().default(''),
});
export const zPassA = z.object({ capabilities: z.array(zCapability).min(1) });
export type Capability = z.infer<typeof zCapability>;

// ── Pass B · seams (draft contracts) ─────────────────────────────────────────

export const zField = z.object({
  name: z.string().min(1),
  type: z.enum(FIELD_TYPES),
  required: z.boolean(),
  description: z.string().default(''),
});
export type Field = z.infer<typeof zField>;

export const zSeamError = z.object({
  code: z.string().min(1),
  when: z.string().default(''),
  http: z.number().int().default(400),
});

export const zSeam = z.object({
  key: z.string().min(1),
  kind: z.enum(CONTRACT_KINDS),
  direction: z.enum(DIRECTIONS),
  summary: z.string().default(''),
  capability_ids: z.array(z.string()).default([]),
  /** HTTP only; empty string when not applicable. */
  method: z.string().default(''),
  path: z.string().default(''),
  /** Function / event / type / config name; empty when not applicable. */
  symbol: z.string().default(''),
  input: z.array(zField).default([]),
  output: z.array(zField).default([]),
  output_is_array: z.boolean().default(false),
  errors: z.array(zSeamError).default([]),
});
export const zPassB = z.object({ seams: z.array(zSeam).min(1) });
export type Seam = z.infer<typeof zSeam>;

// ── Pass C · modules ─────────────────────────────────────────────────────────

export const zModule = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  lane: z.enum(LANES),
  kind: z.enum(MODULE_KINDS),
  summary: z.string().default(''),
  responsibilities: z.array(z.string()).default([]),
  non_goals: z.array(z.string()).default([]),
  provides: z.array(z.string()).default([]),
  consumes: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  acceptance: z.array(z.string()).default([]),
  est_size: z.enum(['S', 'M', 'L']),
});
export const zPassC = z.object({ modules: z.array(zModule).min(1) });
export type SplitModule = z.infer<typeof zModule>;

// ── JSON Schemas handed to the providers ─────────────────────────────────────
// Written by hand rather than generated, because OpenAI strict mode requires
// every property to appear in `required` and `additionalProperties: false`
// everywhere — constraints most zod-to-json-schema output violates.

const str = { type: 'string' };
const strArr = { type: 'array', items: { type: 'string' } };

export const PASS_A_JSON_SCHEMA: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['capabilities'],
  properties: {
    capabilities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text', 'actor', 'source_quote'],
        properties: {
          id: { ...str, description: 'short kebab id, e.g. see-live-markers' },
          text: { ...str, description: 'one user-visible capability as a verb phrase' },
          actor: { ...str, description: 'who does it: end user, operator, device, system' },
          source_quote: { ...str, description: 'the phrase in the brief this came from' },
        },
      },
    },
  },
};

const FIELD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'type', 'required', 'description'],
  properties: {
    name: str,
    type: { type: 'string', enum: [...FIELD_TYPES] },
    required: { type: 'boolean' },
    description: str,
  },
};

export const PASS_B_JSON_SCHEMA: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['seams'],
  properties: {
    seams: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'key', 'kind', 'direction', 'summary', 'capability_ids',
          'method', 'path', 'symbol', 'input', 'output', 'output_is_array', 'errors',
        ],
        properties: {
          key: { ...str, description: 'dotted key, e.g. markers.list or Marker' },
          kind: { type: 'string', enum: [...CONTRACT_KINDS] },
          direction: { type: 'string', enum: [...DIRECTIONS] },
          summary: str,
          capability_ids: strArr,
          method: { ...str, description: 'GET/POST/PUT/PATCH/DELETE for http, else empty string' },
          path: { ...str, description: 'e.g. /api/markers for http, else empty string' },
          symbol: { ...str, description: 'name for function/event/type/config, else empty string' },
          input: { type: 'array', items: FIELD_SCHEMA },
          output: { type: 'array', items: FIELD_SCHEMA },
          output_is_array: { type: 'boolean' },
          errors: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['code', 'when', 'http'],
              properties: {
                code: { ...str, description: 'SCREAMING_SNAKE, e.g. BBOX_INVALID' },
                when: str,
                http: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  },
};

export const PASS_C_JSON_SCHEMA: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['modules'],
  properties: {
    modules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'slug', 'name', 'lane', 'kind', 'summary', 'responsibilities',
          'non_goals', 'provides', 'consumes', 'files', 'acceptance', 'est_size',
        ],
        properties: {
          slug: { ...str, description: 'lane-prefixed, e.g. fe.map-canvas or be.markers-service' },
          name: str,
          lane: { type: 'string', enum: [...LANES] },
          kind: { type: 'string', enum: [...MODULE_KINDS] },
          summary: str,
          responsibilities: strArr,
          non_goals: { ...strArr, description: 'what this module must NOT do — stops duplicate work' },
          provides: { ...strArr, description: 'contract keys from the seam list' },
          consumes: { ...strArr, description: 'contract keys from the seam list' },
          files: { ...strArr, description: 'suggested source file paths' },
          acceptance: { ...strArr, description: 'checkable statements' },
          est_size: { type: 'string', enum: ['S', 'M', 'L'] },
        },
      },
    },
  },
};
