/**
 * The provider interface.
 *
 * Every model SparkX can talk to — cloud or local — implements exactly this.
 * Two rules the rest of the codebase relies on:
 *
 *   1. `complete()` always returns parsed JSON, never prose. Structured output
 *      is mandatory, not a nice-to-have, because the splitter feeds its result
 *      straight into a Zod schema.
 *   2. A provider never throws for "the model said something silly" — that is
 *      the harness's job to detect and repair. It throws only for transport
 *      failures (no key, host unreachable, HTTP error).
 */

export type JSONSchema = Record<string, unknown>;

export interface CompleteRequest {
  system: string;
  user: string;
  /** The shape the response must have. Enforced by the provider where the API supports it. */
  schema: JSONSchema;
  /** Name used by APIs that require the schema to be named (OpenAI, tool-use). */
  schemaName: string;
  temperature: number;
  /**
   * Structured inputs for the request. Real providers ignore this — everything
   * they need is already rendered into `user`. The built-in heuristic provider
   * reads it so it can work offline without re-parsing its own prompt.
   */
  context?: Record<string, unknown>;
}

export interface Usage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface CompleteResult {
  json: unknown;
  usage: Usage;
  model: string;
}

export interface Provider {
  readonly id: 'fake' | 'openai' | 'google' | 'ollama' | 'cli';
  /** Human-readable model name currently in use. */
  readonly model: string;
  /** Can this provider run right now? Probes the network for Ollama. */
  health(): Promise<{ ok: boolean; detail: string; models?: string[] }>;
  complete(req: CompleteRequest): Promise<CompleteResult>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly provider: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * Rough per-million-token prices, only used to show a running cost.
 * Wrong numbers here cost nothing but a wrong number on a dashboard; update
 * freely. Unknown models fall back to 0 rather than guessing.
 */
const PRICES: Record<string, [number, number]> = {
  'gpt-4o-mini': [0.15, 0.60],
  'gpt-4o': [2.50, 10.00],
  'gpt-4.1-mini': [0.40, 1.60],
  'gpt-4.1': [2.00, 8.00],
  'gemini-2.0-flash': [0.10, 0.40],
  'gemini-1.5-pro': [1.25, 5.00],
};

export function priceFor(model: string, tokensIn: number, tokensOut: number): number {
  const key = Object.keys(PRICES).find((k) => model.startsWith(k));
  if (!key) return 0;
  const [inP, outP] = PRICES[key];
  return (tokensIn / 1e6) * inP + (tokensOut / 1e6) * outP;
}

/**
 * Models return JSON with varying amounts of packaging around it.
 * This strips markdown fences and leading prose, then parses.
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Last resort: take the outermost {...} or [...] span.
    const start = candidate.search(/[[{]/);
    const endObj = candidate.lastIndexOf('}');
    const endArr = candidate.lastIndexOf(']');
    const end = Math.max(endObj, endArr);
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error('response was not JSON');
  }
}
