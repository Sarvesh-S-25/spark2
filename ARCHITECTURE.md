# How SparkX works

A file-by-file account of what each part does and why it is shaped that way.
Read the first section and you will understand the whole thing; the rest is detail.

---

## The one idea

On most two-person projects the frontend developer waits. They wait because the
thing they need to call does not exist yet, and nobody has written down what it will
look like when it does.

SparkX attacks exactly that. The moment a boundary is described precisely enough to
*generate code from*, both sides can start. That description is a **contract**, and
everything in the codebase is either producing contracts, honouring them, or
noticing when someone stops.

> **A module is unblocked when the contracts it consumes reach `locked` — not when
> the module providing them is finished.**

If any part of the app makes a developer wait longer than that, it is a bug.

The pipeline:

```
brief ──► Pass A ──► Pass B ──► Pass C ──► contracts ──► generate ──► verify
        capabilities  seams    modules       lock          stubs      check
                                              │
                                    ┌─────────┴─────────┐
                            frontend builds      backend builds
                            against a mock       against a failing test
```

Everything before **lock** is single-player planning. Everything after runs twice in
parallel, and the contract is the only thing keeping the two branches honest.

---

## Layout

```
server/
  env.ts              every configurable knob, read once
  util.ts             ids, timestamps, hashing, name casing — no dependencies
  index.ts            the Fastify server
  api.ts              every HTTP endpoint
  seed.ts             loads the worked example
  db/
    db.ts             opens and migrates SQLite
    migrations/       numbered .sql files
  models/
    types.ts          the Provider interface
    fake.ts           the offline heuristic provider
    heuristics.ts     its rule table of known project shapes
    openai.ts  google.ts  ollama.ts
    registry.ts       which provider runs which pass
    harness.ts        validate → repair → cache → account
  splitter/
    schemas.ts        the three pass schemas + the field vocabulary
    prompts.ts        the three prompts
    index.ts          orchestration, normalisation, persistence
    validate.ts       the six structural checks
    plan.ts           Plan Studio
    eval.ts           the golden brief set
  contracts/
    spec.ts           the contract shape (zod)
    build.ts          seam → contract, and hashing (no deps)
    diff.ts           change classification
    state.ts          the state machine
  generate/
    pack.ts           the LanguagePack interface + banners + type mapping
    packs/            ts-react-fetch · node-express · python-fastapi
    openapi.ts        the OpenAPI projection
    index.ts          runs the packs, writes files, writes .spark/
  status/
    derive.ts         status from evidence, ranking, critical path
  deps/
    check.ts          the three-level dependency checker
ui/src/
  api.ts              the API client
  App.tsx             shell, navigation, project selection
  bits.tsx            chips, panels, banners
  theme.css           the design tokens
  views/              one file per screen
electron/main.cjs     the desktop window
```

---

## The database

Twelve tables plus two helpers, in `server/db/migrations/001_init.sql`. Two shapes
matter:

**`module` and `contract` are separate objects joined by `module_contract`.** A
contract has exactly one provider and any number of consumers. The whole dependency
check is a query over that join. The one-provider rule is a partial unique index in
SQL, not application code, so no code path can violate it:

```sql
CREATE UNIQUE INDEX one_provider_per_contract
  ON module_contract (contract_id) WHERE role = 'provides';
```

**`status_event` is append-only.** A module's status is never a mutable column. It is
recomputed from evidence every time it is asked for (see `status/derive.ts`), which
is what stops the board from being a place people write optimistic fiction.

Migrations are numbered `.sql` files. Adding `002_x.sql` and restarting is the whole
upgrade story — no framework, nothing to learn.

---

## The model layer

### `models/types.ts` — the Provider interface

Every model SparkX can talk to implements this. Two rules the rest of the code
depends on:

1. `complete()` always returns parsed JSON, never prose. Structured output is
   mandatory because the result feeds straight into a Zod schema.
2. A provider throws only for transport failures — no key, host unreachable, HTTP
   error. "The model said something silly" is not the provider's problem; that is
   what the harness is for.

### The four providers

| File | Structured output via | Notes |
|---|---|---|
| `fake.ts` | n/a — it is code | Deterministic, offline, free |
| `openai.ts` | `response_format: json_schema`, `strict: true` | The API itself rejects a bad shape |
| `google.ts` | `responseSchema` | `toGeminiSchema()` strips keywords Gemini rejects that OpenAI requires |
| `ollama.ts` | `format` = the JSON Schema | Temperature 0 and a fixed seed, so the same brief gives the same split |

All four are configured from `.env` — nothing is stored in the database, so there is
one file to gitignore and no key ever syncs anywhere.

### `models/fake.ts` + `heuristics.ts` — the offline provider

Not machine learning and not pretending to be. `heuristics.ts` is a library of
well-known project shapes — a map view, a login, a chat, a file upload, a payment,
a dashboard, a search, a notification feed, and a generic list-and-create fallback —
each with the seams and modules that shape always needs. When a brief mentions one,
SparkX produces a real, correct, contract-closed split with no model at all.

It exists for three reasons:

1. The app is fully usable with no key and no network.
2. It is deterministic, so the UI and the validations can be developed without
   spending a token.
3. It is the floor a real model has to beat. If a local 7B scores worse than this on
   the eval set, use this instead.

It is honest about its limits: it recognises project *shapes*, not meaning. Given a
brief outside its table, it falls back to a generic list-and-create split, which is
the correct thing for it to do.

One detail worth copying if you extend it: the dashboard rule deliberately does not
match a bare "report". "Vehicles report their position" is not a request for a
dashboard, and that one false positive grew a whole pair of modules nobody asked for.

### `models/harness.ts` — the only place that calls a model

Four things on top of a raw provider call:

- **Validation.** The response is parsed with a Zod schema. A response that does not
  fit is not a result, it is a failed attempt.
- **Repair.** A failed attempt is fed its own validation errors and asked again, at
  most `SPARK_MAX_REPAIRS` times. After that it gives up and returns the raw attempt
  so the caller can hand you a partially-filled editor — a half-correct draft you can
  fix in ninety seconds beats a third retry and a spinner.
- **Cache.** Keyed on `sha256(system + user + schema + model + provider)`. Re-running
  an unchanged split costs nothing and takes no time.
- **Accounting.** Every attempt lands in `model_run` with tokens, cost, latency and
  repair count. That table is what the cost meter in Settings reads.

---

## The splitter

### Why three passes

Asking a model for "modules and contracts" in one shot produces plausible mush.

- **Pass A — capabilities.** What can a person (or a device, or a job) *do*? Verb
  phrases, no technical vocabulary at all. Checkable by a human in ten seconds, which
  is why the UI shows it first: if this is wrong, everything downstream is
  confidently wrong.
- **Pass B — seams.** Where does data cross a boundary between two pieces different
  people would build? This produces draft contracts **before** modules.
- **Pass C — modules.** Assign each seam one provider and its consumers, then cluster
  the remaining leaf work per lane.

Seams before modules is the counterintuitive part and the reason the output holds
together: modules are *derived from* boundaries rather than boundaries being guessed
after the fact.

### The field-table trick

**The model is never asked to write JSON Schema.** It describes each field as
`{name, type, required, description}` with `type` drawn from a closed nine-value
vocabulary, and `compileSchema()` in `contracts/build.ts` turns that table into real
JSON Schema.

Small local models are bad at emitting valid JSON Schema and fine at filling in a
flat table. This one trade buys most of the reliability that makes a 7B model usable
for the job.

### `splitter/validate.ts` — the six checks

Each corresponds to a way a split can be confidently wrong in a manner that only
surfaces days later, once two people have already built against it.

| Check | Fails when | Severity |
|---|---|---|
| Contract closure | A module consumes something nothing provides | block |
| One provider | Two modules claim the same contract | block |
| Lane purity | A frontend module has kind `service`, or provides an http seam | block |
| Granularity | A module is estimated over ~400 lines | warn |
| Coverage | A capability produced no seam anyone uses | warn |
| Acyclicity | The provider→consumer graph has a cycle | block |

Plus uniqueness of slugs and files, dead contracts, and an over-splitting warning
above 30 modules.

### Report first, repair second

`runSplit()` runs `validateSplit()` on the **raw** model output, so what you see is
the truth about what the model produced. Only then does `normalize()` mechanically
fix the subset of problems with exactly one correct answer — a missing lane prefix, a
duplicate slug, a reference to a seam that does not exist, a second module claiming a
contract someone else already provides. Every repair is recorded and shown.

Anything requiring judgement — breaking a dependency cycle, deciding which of two
modules should own a boundary — is left as a reported issue for a person. SparkX will
not break a cycle for you, because which side owns the boundary is a design decision.

### Re-splitting is safe

`persist()` enforces two rules:

- **A locked contract version is never touched.** A new plan revision can propose
  changes but cannot silently rewrite something people are building against.
- **A claimed module is never deleted.** It is marked `orphaned` for a human to
  decide about.

---

## The contract layer

### `contracts/spec.ts` — the shape

Five kinds of boundary, one mental model:

| kind | Boundary | Consumer gets | Provider gets |
|---|---|---|---|
| `http` | Request over the network | Typed client + mock | Route, validator, failing test |
| `event` | Server-pushed message | Typed subscriber + replayed example | Typed publisher |
| `function` | Call across a boundary inside one lane | Typed import with a mock impl | Signature stub |
| `type` | Shared data shape | Emitted into both lanes from one definition | — |
| `config` | Shared setting or key name | Typed accessor | Route |

`function` seams matter more than they look: a canvas publishing its viewport to
layers is a boundary two *frontend* developers can work either side of.

### `contracts/build.ts` — hashing, and why examples are mandatory

`specHash()` deliberately excludes `summary` and every `description`. A typo fix in
prose must not invalidate everyone's generated code; the hash covers exactly the
parts that change how code has to be written.

**Examples are required for a contract to lock.** One field does three jobs: it is
the frontend's mock, the backend's test fixture, and the human's readability check.
Rather than asking a model to invent valid ones — it gets the shape wrong often
enough to matter — `buildExample()` derives them from the field types, and a person
edits them into something more realistic.

### `contracts/diff.ts` — the change class is computed, never declared

```
additive  new optional input field · new output field · new error code   → auto
widening  required becomes optional · output now always present          → auto, flagged
breaking  field removed or renamed · type changed · optional→required    → change request
          · path or method changed · error code removed
```

Because it comes from the schema diff, "I thought it was a small change" stops being
an argument you can have.

### `contracts/state.ts` — the machine

```
draft ──► proposed ──► locked ──► deprecated ──► removed
  ▲          │
  └──────────┘
```

A locked contract has exactly one legal move: `deprecated`. It cannot be edited. The
only way to change one is a change request that produces a *new version*, which is
what keeps both versions generating through a migration and stops anyone being hard
blocked.

### The governance flow (`api.ts`)

1. Provider posts a change request with the new spec and a written reason.
2. SparkX classifies it. Additive and widening **apply immediately** — nothing anyone
   wrote breaks, so nobody should wait for a meeting.
3. Breaking opens a request. Every consumer must ack. **An objection must carry a
   reason** — the API rejects a bare "no", because "no" alone is not a valid response.
4. On full ack, the old version goes `deprecated` and keeps generating; the new
   major locks.
5. **Break glass** forces it through instantly, records who did it and why, and marks
   every consumer un-acked. Fast, but never quiet.

---

## Generation

### `generate/pack.ts` — the plugin boundary

```ts
interface LanguagePack {
  emitTypes(contracts): GenFile[]      // shared shapes
  emitClient(contract): GenFile[]      // consumer side
  emitServerStub(contract): GenFile[]  // provider side
  emitMocks(contract): GenFile[]       // from examples
  emitContractTest(contract): GenFile[]// from examples
  emitRuntime(): GenFile[]             // same for every project
}
```

Adding Spring Boot or Go is a new file in `packs/` and one line in `generate/index.ts`.
Getting this boundary right mattered more than how many packs shipped.

### Banners, and how tampering is detected

Every generated file carries its contract identity **and a hash of its own body**:

```
// contract:  markers.list@1.0.0
// spec-hash: sha256:cee8e414…
// spark-body: sha256:41ae86a1…
```

The checker recomputes the body hash and compares. That is the entire mechanism for
`GENERATED_EDITED` — no file watching, no daemon. And comparing `spec-hash` against
the contract's current hash gives `CONTRACT_DRIFT` just as cheaply.

### The directory boundary

Generated output lands under `src/spark/` and `server/spark/`. Human code imports
from it and never edits inside it. Generated-versus-handwritten being a *directory*
boundary is the only kind of boundary people reliably respect, and it means
regeneration can never destroy anyone's work.

### What the frontend developer actually gets

```ts
import { sparkClient } from '@/spark/client';

// Returns the contract's example while mocked. Real shape, wrong data —
// exactly what you want for building the UI on day one.
const markers = await sparkClient.markers.list({ bbox: viewport.bbox });
```

`sparkConfig.mock` starts as `'all'`. Flip it to `'none'`, or to a list of contract
keys, as each real endpoint lands.

### What the backend developer gets

A router with the path already correct, a dependency-free validator generated from
the input schema, a handler throwing `NotImplemented`, and a test asserting the
contract's example. Their job is unambiguous: make the test pass.

### OpenAPI is a projection

The internal format is the source of truth because it covers `function`, `event` and
`type` boundaries OpenAPI cannot express. Exporting the `http` subset gives you
Swagger, Postman and interoperability for free without giving up the other three.

### `.spark/`

The repo is the sync channel — there is no SparkX server. Generation writes one file
per module and per contract version:

```
.spark/project.json
.spark/plan/001.md
.spark/modules/fe.map-canvas.json
.spark/contracts/markers.list@1.0.0.json
```

One file per object is deliberate. A single big manifest would conflict on every
parallel edit, which is precisely the pain this product claims to solve. The
`project.json` even omits a generation timestamp, so an unchanged regenerate produces
a zero-line diff.

---

## Status derivation

`status/derive.ts` computes, never stores:

| Status | Derived when |
|---|---|
| `planned` | Not everything it consumes is locked |
| `ready` | All consumed contracts locked, unclaimed — **the "start now" list** |
| `building` | Claimed |
| `blocked` | An open change request touches its contracts, or a blocking finding names it |
| `contract_met` | Every declared file exists and its contracts are locked |
| `completed` | Asserted by a person |
| `orphaned` | Dropped from the plan but somebody had claimed it |

The manual override exists because people need an escape hatch. It renders as a
**hollow** chip with an "asserted" marker and is written to `status_event` with the
actor's name, so it can never be used invisibly.

Two derived views come free from the same data:

- **`unblockRanking()`** — which contract, once locked, moves the most modules into
  Ready. The answer to "what should we agree on next".
- **`criticalPath()`** — the longest chain of unfinished dependent modules.

---

## The dependency check

Three levels, cheapest first (`deps/check.ts`).

**Level 1 — graph.** Pure SQL over the module/contract join, milliseconds.
`ORPHAN_CONTRACT`, `DEAD_CONTRACT`, `CYCLE`, `LANE_LEAK`, `UNOWNED_MODULE`.

**Level 2 — drift.** Hash comparison, no parsing. `CONTRACT_DRIFT` (generated code is
behind the contract), `GENERATED_EDITED` (body hash mismatch), `CONTRACT_TAMPERED` (a
locked spec no longer hashes to its recorded value), `VERSION_SKEW`.

**Level 3 — code reality.** Currently a text scan rather than a parse, and it says so:
it reports at warning strength where tree-sitter would block. `MISSING_IMPL` (no
handwritten file mentions the contract's path), `UNDECLARED_CALL` (code calls an
endpoint no contract covers), `STUB_REMAINING`, `MISSING_FILE`.

`UNDECLARED_CALL` is the sleeper. It is how SparkX finds the seams the splitter
missed, which is also how the tool stays useful on a project that started without it.

Every finding carries a stable code and a fix hint, because a checker that says
"something is wrong" is a checker people turn off.

---

## The UI

`ui/src/theme.css` holds the design tokens. The palette encodes information rather
than decorating: every module, contract and generated file carries a lane, and the
lane colour is the same everywhere it appears. Semantic colour (ok / warn / stop) is
kept separate from lane colour so "which side is this" and "is this in trouble" never
compete for the same cue. Both light and dark are defined at token level, including
the un-stamped system-preference case.

| Screen | What it answers |
|---|---|
| **Overview** | What can I start now, what should we lock next, is anything broken |
| **Brief & split** | Plan Studio, the brief, and what the three passes did |
| **Requirements** | The roster — lane, status, who has it, what it waits on |
| **Graph** | Modules by lane, wired by contract; click to focus |
| **Contracts** | The table, the editor, the state machine, change requests |
| **Generate** | Pick packs, preview, write |
| **Dependency check** | Run it, read the findings, learn what each code means |
| **Settings** | Which model runs which pass, what it has cost, where the source lives |

The UI is only one client of the API. Every screen talks to endpoints in
`server/api.ts` over HTTP — which is why the server is a real HTTP surface rather than
functions the UI imports. The CLI and the VS Code extension in the roadmap plug into
the same list with no server changes.

---

## Two deliberate departures from the plan

**The server is a sidecar process, not code inside Electron's main process.**
`better-sqlite3` is a native module, and compiling it against Electron's ABI on every
machine is a setup failure waiting to happen. As a plain Node process it builds
against system Node, so `npm install` is the whole story on Windows, macOS and Linux
— and the app is equally usable in a browser tab, which makes development and
screen-sharing easier.

**The module graph is three fixed lane columns, not a force-directed layout.** The
whole product is about which side of the frontend/backend line something sits on, so
the layout should say that before you read a single label. It also removes a
dependency.

---

## Where to add the missing pieces

| Feature | Where it goes |
|---|---|
| Git integration | New `server/git/` + routes in `api.ts`; `.spark/` writer already exists in `generate/index.ts` |
| tree-sitter level 3 | `server/deps/check.ts`, `level3()` only |
| Running contract tests | `server/deps/`, then a new branch in `status/derive.ts` |
| Migration-window timers | `server/api.ts` change-request routes + a scheduled sweep |
| A new language | One file in `server/generate/packs/`, one line in `generate/index.ts` |
| A CLI | Talks to the existing HTTP API — no server changes |
