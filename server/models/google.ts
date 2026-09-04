import { env } from '../env.js';
import {
  Provider, CompleteRequest, CompleteResult, ProviderError, priceFor, parseJsonLoose,
} from './types.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Google Gemini.
 *
 * Gemini's `responseSchema` is a restricted dialect of JSON Schema: it rejects
 * `additionalProperties`, `$schema` and a few other keywords that OpenAI's
 * strict mode *requires*. `toGeminiSchema` strips those so one internal schema
 * can drive both providers.
 */
export class GoogleProvider implements Provider {
  readonly id = 'google' as const;
  readonly model = env.google.model;

  async health() {
    if (!env.google.apiKey) {
      return { ok: false, detail: 'GOOGLE_API_KEY is not set in .env' };
    }
    try {
      const res = await fetch(`${API}/models?key=${env.google.apiKey}`);
      if (!res.ok) return { ok: false, detail: `key rejected (HTTP ${res.status})` };
      const body = (await res.json()) as { models?: { name: string }[] };
      return {
        ok: true,
        detail: `ready · ${this.model}`,
        models: (body.models ?? []).map((m) => m.name.replace(/^models\//, '')).sort(),
      };
    } catch (e) {
      return { ok: false, detail: `cannot reach Google: ${(e as Error).message}` };
    }
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    if (!env.google.apiKey) throw new ProviderError('GOOGLE_API_KEY is not set', 'google');

    const url = `${API}/models/${this.model}:generateContent?key=${env.google.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        generationConfig: {
          temperature: req.temperature,
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(req.schema),
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 400)}`, 'google');
    }

    const body = (await res.json()) as any;
    const content: string = body.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const tokensIn = body.usageMetadata?.promptTokenCount ?? 0;
    const tokensOut = body.usageMetadata?.candidatesTokenCount ?? 0;

    return {
      json: parseJsonLoose(content),
      model: this.model,
      usage: { tokensIn, tokensOut, costUsd: priceFor(this.model, tokensIn, tokensOut) },
    };
  }
}

/** Drops keywords Gemini's schema dialect rejects, and uppercases `type`. */
export function toGeminiSchema(schema: unknown): unknown {
  const DROP = new Set(['additionalProperties', '$schema', 'definitions', '$defs', 'const']);
  const walk = (node: any): any => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out: any = {};
    for (const [k, v] of Object.entries(node)) {
      if (DROP.has(k)) continue;
      if (k === 'type' && typeof v === 'string') out.type = v.toUpperCase();
      else out[k] = walk(v);
    }
    return out;
  };
  return walk(schema);
}
