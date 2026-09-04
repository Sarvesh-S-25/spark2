import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../env.js';
import {
  Provider, CompleteRequest, CompleteResult, ProviderError, parseJsonLoose,
} from './types.js';

/**
 * A headless CLI agent (agy, or the older `gemini`) as the model — real AI,
 * no API key. `.claude/scripts/gemini.mjs` is a working prototype of exactly
 * this kind of call, made from this same repo, and every gotcha it hit
 * (documented in `.claude/README.md`) applies here too. This file adapts that
 * prototype's proven parts rather than reinventing them, with two changes the
 * server context forces:
 *
 *   1. Everything here is async. `gemini.mjs` is a one-shot script, so a
 *      blocking `spawnSync` PATH probe costs nothing; this provider lives
 *      inside a long-lived Fastify server, and a blocking probe would stall
 *      every other in-flight request for its duration.
 *   2. Agy has no `response_format` — the schema and the "JSON only" contract
 *      go into the prompt as text, and the harness's existing validate-and-
 *      repair loop is what actually enforces the shape, at a higher repair
 *      rate than the schema-enforced providers. That is expected, not a bug;
 *      `model_run.repair_count` already measures it.
 *
 * Only `agy` and the legacy `gemini` CLI are implemented — those are the two
 * shapes `gemini.mjs` has actually proven out. `codex` is mentioned in the
 * plan as a third option but nothing in this repo has driven it headlessly,
 * so guessing its flags here would be exactly the kind of "quiet
 * approximation" AGENTS.md says to avoid. Setting SPARK_CLI_BIN=codex will
 * attempt the generic (gemini-shaped) path below and likely fail loudly
 * rather than silently produce wrong output — a clear gap, not a false claim.
 */

const WIN = process.platform === 'win32';
const ARG_LIMIT = 7000;

let resolvedBin: string | null | undefined; // undefined = not yet resolved this process

/** An absolute path that exists is proof; a PATH probe is only a guess. */
function knownPath(bin: string): string | null {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const local = process.env.LOCALAPPDATA || (home ? join(home, 'AppData', 'Local') : '');
  const candidates = bin === 'agy'
    ? [
      local && join(local, 'agy', 'bin', WIN ? 'agy.exe' : 'agy'),
      home && join(home, '.local', 'bin', 'agy'),
      '/usr/local/bin/agy',
    ]
    : [
      home && join(home, 'AppData', 'Roaming', 'npm', `${bin}.cmd`),
      `/usr/local/bin/${bin}`,
    ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

/** Runs `bin --version` with a short timeout. Never throws. */
function probe(bin: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; resolve(ok); } };
    try {
      const needsShell = WIN && !/\.exe$/i.test(bin);
      const child = spawn(bin, ['--version'], { shell: needsShell, stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill(); finish(false); }, timeoutMs);
      child.on('error', () => { clearTimeout(timer); finish(false); });
      child.on('close', (code) => { clearTimeout(timer); finish(code === 0); });
    } catch {
      finish(false);
    }
  });
}

/**
 * Resolves the configured binary once per process and caches the result —
 * cheap on every later call, and consistent between `health()` and
 * `complete()` (a bare name that only works because it is on PATH resolves
 * the same way both times).
 */
async function resolveBin(): Promise<string | null> {
  if (resolvedBin !== undefined) return resolvedBin;
  const bin = env.cli.bin;
  const known = knownPath(bin);
  if (known) return (resolvedBin = known);
  resolvedBin = (await probe(bin, 5000)) ? bin : null;
  return resolvedBin;
}

function looksLikeAuthProblem(text: string): boolean {
  return /no longer supported|unauthenticated|failed to sign in|sign ?-?in failed|oauth token|api key not valid|\b401\b|\b403\b/i
    .test(text);
}

function firstLines(text: string, n = 6): string {
  return text.trim().split('\n').slice(0, n).join('\n');
}

/**
 * Folds the schema into the prompt as text, since a CLI agent has no
 * structured-output parameter. Ends with `user` last for recency, and states
 * the no-tools contract explicitly — AGENTS.md and `.claude/README.md` are
 * both clear that a splitter prompt is self-contained and must stay that way,
 * and an agentic CLI left to its own judgement may otherwise try to "help" by
 * exploring the filesystem.
 */
function buildPrompt(req: CompleteRequest): string {
  return [
    req.system.trim(),
    '',
    'Respond with JSON only: no markdown code fences, no prose before or after the JSON, no' +
    ' tool calls, no reading or writing any file. Everything you need is already in this message.',
    '',
    `The JSON must match this schema, named "${req.schemaName}":`,
    JSON.stringify(req.schema),
    '',
    req.user.trim(),
  ].join('\n');
}

export class CliProvider implements Provider {
  readonly id = 'cli' as const;
  readonly model = env.cli.bin;

  async health() {
    const bin = await resolveBin();
    if (!bin) {
      return {
        ok: false,
        detail: `no "${env.cli.bin}" found. Install it (see .claude/README.md), or set SPARK_CLI_BIN to its full path.`,
      };
    }
    // A fast reachability check only — it cannot tell whether the CLI is
    // actually signed in, which only surfaces on a real completion call and
    // takes 13-32s even for a trivial prompt (agy loads its own harness
    // first). That is too slow for a Settings screen that health-checks
    // every provider on every load; a full check is the price of the first
    // real split instead, and its failure is reported clearly there.
    const ok = await probe(bin, 5000);
    return {
      ok,
      detail: ok ? `ready · ${bin}` : `found "${bin}" but it did not respond to --version`,
    };
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const bin = await resolveBin();
    if (!bin) {
      throw new ProviderError(
        `no "${env.cli.bin}" found. Install it, or set SPARK_CLI_BIN to its full path.`,
        'cli',
      );
    }

    const prompt = buildPrompt(req);
    const isAgy = /agy(\.exe)?$/i.test(bin);
    const streaming = isAgy && prompt.length > ARG_LIMIT;
    const pipePlain = !isAgy && prompt.length > ARG_LIMIT;

    const args = isAgy
      ? (streaming
        ? ['--input-format', 'stream-json', '--output-format', 'stream-json',
          '--print-timeout', `${Math.max(1, Math.round(env.cli.timeoutSec / 60))}m`]
        : ['-p', prompt, '--output-format', 'json',
          '--print-timeout', `${Math.max(1, Math.round(env.cli.timeoutSec / 60))}m`])
      : (pipePlain ? ['--output-format', 'json'] : ['--prompt', prompt, '--output-format', 'json']);

    // A .exe needs no shell; avoiding one is what keeps an unescaped prompt
    // (a quote, an &, a brief containing either) from breaking or injecting
    // into the command line. Never `--dangerously-skip-permissions` — the
    // whole prompt is self-contained, so the CLI needs no tool access at all.
    const needsShell = WIN && !/\.exe$/i.test(bin);

    const { stdout, stderr, code, timedOut } = await new Promise<{
      stdout: string; stderr: string; code: number | null; timedOut: boolean;
    }>((resolve) => {
      const child = spawn(bin, args, {
        shell: needsShell,
        stdio: [streaming || pipePlain ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, (env.cli.timeoutSec + 30) * 1000);

      if (streaming) {
        child.stdin!.write(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
        child.stdin!.end();
      } else if (pipePlain) {
        child.stdin!.write(prompt);
        child.stdin!.end();
      }

      child.stdout?.on('data', (d) => { out += d; });
      child.stderr?.on('data', (d) => { err += d; });
      child.on('error', () => { clearTimeout(timer); resolve({ stdout: out, stderr: err, code: null, timedOut }); });
      child.on('close', (c) => { clearTimeout(timer); resolve({ stdout: out, stderr: err, code: c, timedOut }); });
    });

    if (timedOut) {
      throw new ProviderError(`"${bin}" did not respond within ${env.cli.timeoutSec}s`, 'cli');
    }
    if (looksLikeAuthProblem(stderr)) {
      throw new ProviderError(`"${bin}" could not authenticate: ${firstLines(stderr)}`, 'cli');
    }

    // Streaming replies as newline-delimited init/step_update/result events;
    // the answer is the single result event. Non-streaming is one envelope.
    let envelope: any = null;
    if (streaming) {
      for (const line of stdout.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          const ev = JSON.parse(s);
          if (ev.event === 'result' && ev.result) envelope = ev.result;
        } catch { /* a partial line is not fatal */ }
      }
    } else {
      try { envelope = JSON.parse(stdout); } catch { /* handled below */ }
    }

    if (!envelope) {
      if (code !== 0) {
        throw new ProviderError(`"${bin}" exited ${code}: ${firstLines(stderr || stdout)}`, 'cli');
      }
      // Process succeeded but produced nothing parseable as the outer
      // envelope — treat the raw output as the model's own (malformed)
      // answer text, not a transport failure. See the `text` branch below:
      // this becomes a sentinel object that fails Zod cleanly so the
      // harness's repair loop runs, instead of a hard stop with zero retries.
      return sentinelResult(this.model, stdout || '(empty response)');
    }
    if (String(envelope.status ?? '').toLowerCase() === 'error' || envelope.error) {
      const detail = typeof envelope.error === 'string' ? envelope.error : JSON.stringify(envelope.error ?? envelope);
      if (looksLikeAuthProblem(detail)) throw new ProviderError(`"${bin}" could not authenticate: ${detail}`, 'cli');
      throw new ProviderError(`"${bin}" returned an error: ${detail}`, 'cli');
    }

    const text = String(envelope.response ?? '');
    const usage = envelope.usage ?? {};

    // The whole reason this needs its own try/catch, unlike every other
    // provider: an agentic CLI can "succeed" (exit 0, well-formed envelope)
    // while its `response` is prose instead of JSON — a refused tool call, a
    // rambling explanation. That is a content problem for the harness's
    // repair loop to fix, not a transport problem for this method to throw
    // on; see PassResult and the interface contract in ./types.ts.
    try {
      return {
        json: parseJsonLoose(text),
        model: this.model,
        usage: { tokensIn: usage.input_tokens ?? 0, tokensOut: usage.output_tokens ?? 0, costUsd: 0 },
      };
    } catch {
      return sentinelResult(this.model, text);
    }
  }
}

/** A value that will fail Zod validation with a readable message, not throw. */
function sentinelResult(model: string, rawText: string): CompleteResult {
  return {
    json: { _cliRawText: rawText.slice(0, 2000) },
    model,
    usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
  };
}
