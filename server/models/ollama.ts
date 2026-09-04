import { env } from '../env.js';
import {
  Provider, CompleteRequest, CompleteResult, ProviderError, parseJsonLoose,
} from './types.js';

/**
 * Ollama — a model running on this machine, no key, no network egress.
 *
 * Ollama accepts a JSON Schema in its `format` field and constrains generation
 * to it, which is the reason a 7B model is viable here at all. Temperature is
 * pinned and a fixed seed is passed so the same brief produces the same split.
 */
export class OllamaProvider implements Provider {
  readonly id = 'ollama' as const;
  readonly model = env.ollama.model;

  async health() {
    try {
      const res = await fetch(`${env.ollama.host}/api/tags`, {
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) return { ok: false, detail: `Ollama replied HTTP ${res.status}` };
      const body = (await res.json()) as { models?: { name: string }[] };
      const names = (body.models ?? []).map((m) => m.name);
      if (names.length === 0) {
        return { ok: false, detail: `Ollama is running but has no models. Try: ollama pull ${this.model}`, models: [] };
      }
      const has = names.some((n) => n === this.model || n.startsWith(this.model.split(':')[0]));
      return {
        ok: has,
        detail: has
          ? `ready · ${this.model}`
          : `${this.model} not pulled. Try: ollama pull ${this.model}`,
        models: names.sort(),
      };
    } catch {
      return {
        ok: false,
        detail: `no Ollama at ${env.ollama.host}. Install from ollama.com, then: ollama pull ${this.model}`,
      };
    }
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    let res: Response;
    try {
      res = await fetch(`${env.ollama.host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          format: req.schema,
          options: { temperature: req.temperature, seed: 7 },
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        }),
      });
    } catch (e) {
      throw new ProviderError(
        `cannot reach Ollama at ${env.ollama.host} — is it running? (${(e as Error).message})`,
        'ollama',
      );
    }

    if (!res.ok) {
      const text = await res.text();
      throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 400)}`, 'ollama');
    }

    const body = (await res.json()) as any;
    const content: string = body.message?.content ?? '';

    return {
      json: parseJsonLoose(content),
      model: this.model,
      usage: {
        tokensIn: body.prompt_eval_count ?? 0,
        tokensOut: body.eval_count ?? 0,
        costUsd: 0, // local inference is free
      },
    };
  }
}
