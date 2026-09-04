import { env } from '../env.js';
import {
  Provider, CompleteRequest, CompleteResult, ProviderError, priceFor, parseJsonLoose,
} from './types.js';

/**
 * OpenAI (and anything speaking its Chat Completions dialect — Azure, Groq,
 * LM Studio, a local gateway — via OPENAI_BASE_URL).
 *
 * Uses `response_format: json_schema` with `strict: true`, which makes the API
 * itself reject a response that doesn't match. That removes most of the work
 * the repair loop would otherwise have to do.
 */
export class OpenAIProvider implements Provider {
  readonly id = 'openai' as const;
  readonly model = env.openai.model;

  async health() {
    if (!env.openai.apiKey) {
      return { ok: false, detail: 'OPENAI_API_KEY is not set in .env' };
    }
    try {
      const res = await fetch(`${env.openai.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${env.openai.apiKey}` },
      });
      if (!res.ok) return { ok: false, detail: `key rejected (HTTP ${res.status})` };
      const body = (await res.json()) as { data?: { id: string }[] };
      return {
        ok: true,
        detail: `ready · ${this.model}`,
        models: (body.data ?? []).map((m) => m.id).filter((id) => id.startsWith('gpt')).sort(),
      };
    } catch (e) {
      return { ok: false, detail: `cannot reach ${env.openai.baseUrl}: ${(e as Error).message}` };
    }
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    if (!env.openai.apiKey) throw new ProviderError('OPENAI_API_KEY is not set', 'openai');

    const res = await fetch(`${env.openai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openai.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: req.temperature,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: req.schemaName,
            strict: true,
            schema: req.schema,
          },
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 400)}`, 'openai');
    }

    const body = (await res.json()) as any;
    const content: string = body.choices?.[0]?.message?.content ?? '';
    const tokensIn = body.usage?.prompt_tokens ?? 0;
    const tokensOut = body.usage?.completion_tokens ?? 0;

    return {
      json: parseJsonLoose(content),
      model: body.model ?? this.model,
      usage: { tokensIn, tokensOut, costUsd: priceFor(this.model, tokensIn, tokensOut) },
    };
  }
}
