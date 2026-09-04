import 'dotenv/config';

/**
 * Every knob SparkX has, read once from the environment.
 *
 * Nothing else in the codebase touches `process.env` — so if you want to know
 * what the app can be configured with, this file is the complete answer.
 */

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}
function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

export type ProviderId = 'fake' | 'openai' | 'google' | 'ollama' | 'cli';
export type PassId = 'A' | 'B' | 'C';

const VALID: ProviderId[] = ['fake', 'openai', 'google', 'ollama', 'cli'];

function provider(name: string, fallback: ProviderId): ProviderId {
  const v = str(name).toLowerCase() as ProviderId;
  return VALID.includes(v) ? v : fallback;
}

export const env = {
  port: num('PORT', 5178),
  dbPath: str('SPARK_DB', './data/spark.db'),

  /** Default provider for every pass. */
  provider: provider('SPARK_PROVIDER', 'fake'),

  /** Optional per-pass override. Undefined means "use the default". */
  passProvider: {
    A: str('SPARK_PROVIDER_PASS_A') ? provider('SPARK_PROVIDER_PASS_A', 'fake') : undefined,
    B: str('SPARK_PROVIDER_PASS_B') ? provider('SPARK_PROVIDER_PASS_B', 'fake') : undefined,
    C: str('SPARK_PROVIDER_PASS_C') ? provider('SPARK_PROVIDER_PASS_C', 'fake') : undefined,
  } as Record<PassId, ProviderId | undefined>,

  openai: {
    apiKey: str('OPENAI_API_KEY'),
    model: str('OPENAI_MODEL', 'gpt-4o-mini'),
    baseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
  },
  google: {
    apiKey: str('GOOGLE_API_KEY'),
    model: str('GOOGLE_MODEL', 'gemini-2.0-flash'),
  },
  ollama: {
    host: str('OLLAMA_HOST', 'http://localhost:11434').replace(/\/$/, ''),
    model: str('OLLAMA_MODEL', 'qwen2.5-coder:7b'),
  },
  cli: {
    bin: str('SPARK_CLI_BIN', 'agy'),
    timeoutSec: num('SPARK_CLI_TIMEOUT', 600),
  },

  temperature: num('SPARK_TEMPERATURE', 0),
  maxRepairs: num('SPARK_MAX_REPAIRS', 2),
  cacheEnabled: str('SPARK_CACHE', '1') !== '0',
};

/** Which provider actually runs a given pass. */
export function providerForPass(pass: PassId): ProviderId {
  return env.passProvider[pass] ?? env.provider;
}

/** True when the configured provider has everything it needs to run. */
export function providerConfigured(id: ProviderId): boolean {
  switch (id) {
    case 'fake': return true;
    case 'openai': return env.openai.apiKey.length > 0;
    case 'google': return env.google.apiKey.length > 0;
    case 'ollama': return true; // reachability is probed at call time
    case 'cli': return true; // whether the binary resolves is probed at call time
  }
}
