# SparkX

**A splitter.** It takes one project brief and splits it into frontend and backend
work that two people can build at the same time, joined by generated, versioned
**contracts** — then proves, from the actual repo, that the halves still fit.

The rule everything follows:

> **A module is unblocked when the contracts it consumes reach `locked` — not when
> the module providing them is finished.**

---

## Quick start

```bash
npm run preflight   # zero-dependency sanity check — works before install
npm install
npm run seed        # loads the live-map worked example
npm run dev         # then open http://localhost:5173
```

How to run it and troubleshoot: **[HOW_TO_RUN.md](HOW_TO_RUN.md)**
How every part works and why: **[ARCHITECTURE.md](ARCHITECTURE.md)**
Working on the code, and the invariants not to break: **[AGENTS.md](AGENTS.md)**
Seventeen ways to improve the splitter: **[SPLITTER_ROADMAP.md](SPLITTER_ROADMAP.md)**

---

## Three ways to split

The same pipeline, three engines behind it. One line in `.env` picks.

| Engine | Needs | What it is |
|---|---|---|
| **Offline** `SPARK_PROVIDER=fake` | nothing at all | A rule table of known project shapes — a map view, a login, a chat, an upload. No model, no network, no key. Deterministic, free, and the floor a real model has to beat. |
| **Local CLI** `SPARK_PROVIDER=cli` | a signed-in CLI | Drives `agy`, `gemini` or `codex` headlessly. Real AI on a Google or OpenAI account, **no API key**. *Not built — Phase 2.* |
| **API key** `SPARK_PROVIDER=openai\|google\|ollama` | a key, or Ollama | Direct HTTP with schema-enforced structured output. Fastest and most reliable. |

The offline engine is not a stub. Given the live-map brief it produces 9 contracts
and 13 modules with zero validation issues.

## Three ways to drive it

| Surface | State |
|---|---|
| **Browser** at `localhost:5173` — nine screens: brief, graph, requirements, contracts, generate, check | built |
| **HTTP API** on `localhost:5178` — every screen is only a client of it | built |
| **MCP server** — so Claude Code, Codex or any MCP client can ask *"what can I start now?"*, read the contract graph, and run the checker | *not built — Phase 3* |
| **Desktop window** via Electron | optional, `npm run app` |

---

## What it does

**Split.** Three passes — capabilities, then seams, then modules. Seams *before*
modules is the important part: modules are derived from boundaries rather than
boundaries guessed after the fact. Six structural checks run on the raw output; only
problems with exactly one correct answer are repaired automatically.

**Contract.** Five kinds of boundary (`http`, `event`, `function`, `type`, `config`),
one mental model. Versioned, state-machined, hash-anchored. Examples are mandatory —
the same example is the frontend's mock, the backend's test fixture and the human's
readability check.

**Generate.** Typed clients and example-backed mocks for the consumer side; route
skeletons, validators and failing tests for the provider side. TypeScript/React,
Node/Express and Python/FastAPI ship in the box; adding a language is one new file.

**Track.** Status is derived from evidence — contract states, files on disk,
findings — not typed in. Override it and the badge goes hollow with your name on it.

**Verify.** Three levels of dependency check, cheapest first: graph, drift, code
reality. Every finding has a stable code and a fix hint.

**Govern.** The class of a contract change — additive, widening, breaking — is
computed from the schema diff, never declared. Nobody is ever hard-blocked; nothing
ever changes silently.

### The example, worked

Brief: *"a web app that shows vehicles moving on a live map; users tap a marker for
details and pan and zoom by touch; vehicles report their position."*

Out comes 9 contracts and 13 modules. The one to notice is
**`fe.gesture-controller`** — it consumes no backend contract at all, so touch
pan/zoom is startable minutes into the project, while the backend is still choosing
a database.

Realistic integration-day finding: the backend emits `heading`, the contract says
`headingDeg`. SparkX names the field, both files and the fix — seconds after the
push, rather than an hour before the demo.

---

## Where it actually stands

The code is written and statically verified — `npm run preflight` is clean across 46
source files and 124 imports. It has **never been installed or executed**: no
`node_modules`, no first run, no `data/spark.db`.

So every claim above is true of the design and of the parts that were run in
isolation (the splitter, the contract builder, all three generators). None of it has
been proven end to end on a real machine. Expect real bugs on the first
`npm run check` and `npm run seed`.

---

# The plan

Four phases. **Phase 1 blocks everything** — there is no point building on 7,000
lines that have never run.

## Phase 1 · Prove it runs

The whole phase is: execute it, fix what breaks, change nothing else.

```bash
npm run preflight   # already clean
npm install         # better-sqlite3 is native; see HOW_TO_RUN.md if it fails
npm run check       # tsc with real types for the first time
npm run seed        # splitter → contracts → 3 generators → checker, in one run
npm run dev         # open every screen, click every button
npm run eval        # score the splitter on ten briefs
```

Each step gates the next. Fix in place; resist redesigning anything while doing it.

**Done when:** `check` passes, `seed` completes and writes files into
`workspace/live-map-tracker/`, every screen renders, and `eval` reports numbers.

**Realistic expectation:** a meaningful number of type errors and a handful of
runtime ones. A codebase this size that has never executed always has them.

**Then, and only then, write the first tests.** `AGENTS.md` names the targets — the
pure functions where being wrong is most expensive: `contracts/diff.ts` (change
classification), `contracts/build.ts` (`specHash` stability), `splitter/validate.ts`
(all six checks), `generate/pack.ts` (banner round-trip), `status/derive.ts`. Use
`node:test`; it needs no new dependency.

## Phase 2 · The local-CLI engine

The middle tier: real AI, no API key. This is the one most students can actually
reach, and the groundwork already exists — `.claude/scripts/gemini.mjs` is a working
prototype of exactly this, and every bug it hit is a bug this will hit.

**New file:** `server/models/cli.ts`, implementing the existing `Provider` interface.
Nothing else in the model layer changes.

**Config:**

```
SPARK_PROVIDER=cli
SPARK_CLI_BIN=agy            # or gemini, codex
SPARK_CLI_TIMEOUT=600
```

**What it has to get right** — all five learned the hard way in `.claude/README.md`:

1. **Resolve the binary properly.** Check the known install path before probing
   PATH; an absolute path that exists is proof, a PATH probe is a guess.
2. **Large prompts go over stdin.** Windows caps a command line at 32,767
   characters. For `agy` that means `--input-format stream-json`, which forces
   `--output-format stream-json`, so the reply is newline-delimited events and the
   answer lives in the `result` event.
3. **No shell for a `.exe`.** `shell: true` concatenates the prompt unescaped, so a
   question containing `&` or a quote breaks or injects.
4. **Never pass `--dangerously-skip-permissions`.** The splitter needs no tools —
   the whole prompt is self-contained.
5. **Auth failure is a setup problem, not a retry.** Distinct exit code, stop.

**The hard part, stated honestly:** CLIs have no `response_format`. The other three
providers get schema-enforced JSON from the API; this one cannot. The schema goes in
the prompt and the harness's existing **validate-and-repair loop becomes
load-bearing** rather than a safety net. Expect a higher repair rate, and measure it
— `model_run.repair_count` already records it.

**Cost reality:** an agent CLI loads its own harness before it sees your prompt.
Measured: ~14k input tokens for "say ok", 19–28k for a real question, 13–32 seconds.
Route only Pass B — the hard one — through it if that matters.

**Done when:** `npm run eval` runs end to end with `SPARK_PROVIDER=cli` and scores
at or above the offline engine. If it scores below, the honest recommendation is to
keep using the offline engine, and the eval set is what tells you.

## Phase 3 · The MCP server

So other agents can drive SparkX. This is what makes it a tool other people's
workflows plug into rather than an app you have to sit in front of.

**New:** `server/mcp/index.ts`, `npm run mcp`, stdio transport (works with Claude
Code, Codex, any MCP client). It calls the *same* core functions the HTTP API calls
— `runSplit`, `deriveAll`, `generate`, `runCheck`. **No logic is reimplemented.**
If MCP needs something the API cannot express, that is a signal the core should
change, not that MCP should grow its own copy.

**Read tools — free to call:**

| Tool | Returns |
|---|---|
| `spark_projects` | every project |
| `spark_overview` | modules, contracts, statuses, findings, critical path |
| `spark_modules` | the roster, filterable to `ready` / `building` / `blocked` |
| `spark_contract` | one contract with spec and examples |
| `spark_check` | run the dependency checker, get the findings |
| `spark_next` | **the important one** — what can I start right now, what should be locked next, what is on the critical path |

`spark_next` is the reason to build this. An agent working in the repo asks one
question and gets a correct answer about what is unblocked, instead of guessing.

**Write tools — gated:**

`spark_split`, `spark_lock`, `spark_generate`, `spark_claim`.

Each takes `confirm?: boolean`. Called without it, the tool **does nothing** and
returns a preview of what it would change plus `"call again with confirm: true"`.
No protocol extension, no new concepts — and an agent cannot lock a contract by
accident. Contract-lock is a governance act that unblocks other people; it should
never happen as a side effect of an agent exploring.

**Also expose as MCP resources:** `.spark/contracts/*.json` and the current plan
revision, so a client can read the contract set without a tool call.

**Done when:** Claude Code can be pointed at the MCP server, asked "what should I
work on in this project?", and answer correctly from `spark_next` — and cannot lock
anything without being told twice.

## Phase 4 · Web hardening

Not a hosted service. The goal is that anyone who clones this can run it in a
browser in one command, and that teammates sync through the repo.

- **One command.** `npm run dev` already runs both halves; make `npm start` serve the
  built UI from the same process so there is a single-process path too.
- **Electron off the critical path.** Already optional; make sure nothing in the
  docs implies you need it.
- **Bind to `127.0.0.1` by default.** Add `--host` for LAN sharing, with a printed
  warning that there is **no authentication** — because there is none, and that is
  fine for a local tool and unsafe for anything else. Say so rather than implying
  otherwise.
- **`.spark/` stays the sync channel.** One file per module and per contract version
  so parallel edits do not conflict. No server, no accounts, no hosting bill.

**Explicitly not in scope:** accounts, multi-tenancy, Postgres, a hosted instance.
That is a different product with a different threat model. If it is ever wanted, it
is a fork of this plan, not an extension of it.

## Phase 5 · Splitter quality

The splitter is the piece that has to be genuinely good and the piece that fails
silently. [SPLITTER_ROADMAP.md](SPLITTER_ROADMAP.md) has seventeen improvements
against four named weaknesses. The three worth doing first:

1. **Split Pass B into B1 (enumerate seams) and B2 (specify each seam, one call
   each, in parallel).** Independently cacheable and repairable, faster wall-clock,
   degrades gracefully. Highest-leverage change available — and it matters most for
   the CLI engine, where every call is expensive.
2. **A parallelism score** — front load, parallel width, critical depth, lane
   balance. All computable from existing data with no model. Build it before the
   rest, because it is how every later change gets judged.
3. **Precedent retrieval** — store accepted splits, retrieve the nearest as few-shot
   examples. Turns the offline rule table into a seed corpus and makes the human's
   edits the training signal. Worth nothing on day one, a great deal on day thirty.

---

## Sequencing

```
Phase 1  prove it runs        ← blocks everything, do this first
Phase 2  CLI engine           ← needs a working eval to judge it
Phase 3  MCP server           ← needs a stable core to expose
Phase 4  web hardening        ← small, can slot in anywhere after 1
Phase 5  splitter quality     ← continuous, guided by the eval set
```

Phases 2 and 3 are independent of each other. If you only have time for one, build
**MCP** — it is what makes SparkX useful to other tools, and the offline and
API-key engines already cover splitting.

## Open decisions

- **Name.** SparkX in the docs, Spark2 as the folder. It lands in the repo name, the
  `.spark/` directory and any future binary. Settle it before Phase 3.
- **Git integration** was Phase 5 of the original plan and is still unbuilt. It may
  matter less now: MCP lets an agent read status directly, which was much of what
  the Git integration was for.
- **Level 3 checking** is a text scan, not a parse. Swapping in tree-sitter is a
  change to `server/deps/check.ts` alone, and it stays honest about its limits until
  someone does.
