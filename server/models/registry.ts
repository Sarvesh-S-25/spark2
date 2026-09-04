import { env, providerForPass, type ProviderId, type PassId } from '../env.js';
import type { Provider } from './types.js';
import { FakeProvider } from './fake.js';
import { OpenAIProvider } from './openai.js';
import { GoogleProvider } from './google.js';
import { OllamaProvider } from './ollama.js';
import { CliProvider } from './cli.js';

const cache = new Map<ProviderId, Provider>();

export function getProvider(id: ProviderId): Provider {
  const hit = cache.get(id);
  if (hit) return hit;
  const made: Provider =
    id === 'openai' ? new OpenAIProvider()
      : id === 'google' ? new GoogleProvider()
        : id === 'ollama' ? new OllamaProvider()
          : id === 'cli' ? new CliProvider()
            : new FakeProvider();
  cache.set(id, made);
  return made;
}

export function providerFor(pass: PassId): Provider {
  return getProvider(providerForPass(pass));
}

/** Status of every provider, for the Settings screen. */
export async function providerReport() {
  const ids: ProviderId[] = ['fake', 'openai', 'google', 'ollama', 'cli'];
  const rows = await Promise.all(
    ids.map(async (id) => {
      const p = getProvider(id);
      let health: { ok: boolean; detail: string; models?: string[] };
      try {
        health = await p.health();
      } catch (e) {
        health = { ok: false, detail: (e as Error).message };
      }
      return {
        id,
        model: p.model,
        active: env.provider === id,
        usedForPasses: (['A', 'B', 'C'] as PassId[]).filter((x) => providerForPass(x) === id),
        ...health,
      };
    }),
  );
  return {
    defaultProvider: env.provider,
    routing: { A: providerForPass('A'), B: providerForPass('B'), C: providerForPass('C') },
    temperature: env.temperature,
    maxRepairs: env.maxRepairs,
    cacheEnabled: env.cacheEnabled,
    providers: rows,
  };
}
