# AGENTS.md — working on SparkX

Instructions for any AI coding agent (or new human) working in this repo. Read this
before touching anything. `ARCHITECTURE.md` is the deep explanation; this file is the
operating manual.

---

## What this project is

SparkX splits one project brief into frontend and backend work streams that can
proceed **in parallel**, joined by generated, versioned **contracts**.

The problem it exists to solve: on most two-person projects the frontend developer
waits, because the thing they need to call does not exist yet and nobody has written
down what it will look like when it does.

### More Detail 
more detail on this project can be found at 
@ARCHITECURE.md

**The one rule everything serves:**

> A module is unblocked when the contracts it consumes reach `locked` — **not** when
> the module providing them is finished.

If a change you are about to make would make a developer wait longer than that, it is
the wrong change. Test every proposed feature against one question: *does this
shorten the time from brief to contract-lock, or catch a break sooner?* If neither,
it is out of scope — this is not a project-management tool.

Pipeline:

```
brief → Pass A (capabilities) → Pass B (seams) → Pass C (modules)
      → contracts lock → generate stubs → verify against the repo
```

---

##Splitter information 
The way the project can be split is mentioned in SPLITTER_ROADMAP.md

## The plan

`README.md` contains the build plan under `# The plan`. It is phased, and **Phase 1
(prove it runs) blocks everything** — this code has never been installed or
executed. Name the phase before starting work, and do not skip ahead.

## Commands

```
npm run preflight    # zero-dependency check — imports, exports, scripts, env keys
npm install          # first time; better-sqlite3 is native, see HOW_TO_RUN.md
npm run dev          # API on :5178 + Vite on :5173  ← the one you want
npm run start        # API only
npm run app          # Electron desktop window
npm run seed         # load the live-map worked example (-- --reset to wipe)
npm run eval         # score the splitter against the golden brief set
npm run check        # tsc --noEmit across server and ui  ← run before you finish
npm run build:ui     # production UI build
```

**Run `npm run preflight` after moving code between files, and `npm run check` before declaring work done.** There is no test suite yet
(see *Testing* below), so the type checker plus `npm run seed` plus `npm run eval` are
the verification story.

---

## Repo map

| Path | Owns |
|---|---|
| `server/env.ts` | Every configurable knob. Nothing else reads `process.env`. |
| `server/util.ts` | ids, timestamps, hashing, name casing. **Zero dependencies.** |
| `server/api.ts` | Every HTTP endpoint. The UI is only one client of it. |
| `server/db/` | SQLite open + numbered `.sql` migrations. |
| `server/models/` | Provider interface, four providers, routing, prompt harness. |
| `server/splitter/` | The three passes, prompts, schemas, validations, evals. |
| `server/contracts/` | Contract shape, hashing, change classification, state machine. |
| `server/generate/` | Language packs, banners, OpenAPI, `.spark/` writer. |
| `server/status/` | Status derivation, unblock ranking, critical path. |
| `server/deps/` | The three-level dependency checker. |
| `ui/src/views/` | One file per screen. |
| `ui/src/theme.css` | All design tokens. No colour literals in components. |

---

## Invariants — do not break these

1. **One provider per contract.** Enforced by a partial unique index in SQL, not by
   application code. Never work around it; if two modules both need to provide
   something, the contract is under-specified and should be split in two.

2. **Status is derived, never stored.** `module.manual_status` is the *override*, and
   it renders as a hollow chip with the actor's name. Do not add a "status" column
   that the app writes on its own. `status_event` is append-only.

3. **A locked contract is never edited.** Its only legal transition is `deprecated`.
   Changes produce a **new version** through a change request. This is what lets both
   versions generate during a migration so nobody is hard-blocked.

4. **The change class is computed, never declared.** `contracts/diff.ts` derives
   additive / widening / breaking from the schema diff. Never accept a client-supplied
   class.

5. **Examples are mandatory to lock.** One example serves three masters: the
   frontend's mock, the backend's test fixture, the human's readability check. Do not
   add a bypass.

6. **Generated code lives only under `src/spark/` and `server/spark/`.** Human code
   imports from it and never edits inside it. Generated-vs-handwritten being a
   *directory* boundary is the only kind people reliably respect.

7. **Every generated file carries a body hash in its banner.** That is the entire
   mechanism for `GENERATED_EDITED`. If you change `banner()`, change `readBanner()`
   in the same commit and re-verify the round-trip.

8. **`specHash()` excludes prose.** A typo fix in a `summary` or `description` must
   not invalidate everyone's generated code. If you add a field to `ContractSpec`,
   decide deliberately whether it belongs in the hash material.

9. **Report the truth, then repair.** `runSplit()` runs `validateSplit()` on the
   **raw** model output before `normalize()` touches it. Only fixes with exactly one
   correct answer belong in `normalize()`, and each one must be recorded in `fixes[]`.
   Anything needing judgement — breaking a cycle, choosing an owner — stays a
   reported issue for a person.

10. **`.spark/` is one file per object.** A single manifest would conflict on every
    parallel edit, which is the exact pain this product claims to solve.
    `project.json` deliberately omits a timestamp so an unchanged regenerate is a
    zero-line diff.

11. **Keys live in `.env` only.** Never in SQLite, never in `.spark/`, never in a
    generated file.

12. **The model never writes JSON Schema.** It fills in a flat
    `{name, type, required, description}` table from the closed `FIELD_TYPES`
    vocabulary, and `compileSchema()` compiles it. This is the single trade that
    makes a 7B local model viable. Do not "simplify" it by asking for schema directly.

---

## Conventions

**TypeScript.** ESM throughout (`"type": "module"`), so **relative imports end in
`.js`** even though the files are `.ts` — `import { db } from './db/db.js'`. `tsx`
runs the server directly; there is no server build step.

**Layering.** `util.ts` depends on nothing. `contracts/build.ts` depends on `util`
and types only — no zod, no SQLite — so the generators, the checker and a future CLI
can use it without booting an app. Keep it that way; if you need a helper in
`build.ts` that would drag in a dependency, put the helper somewhere else.

**Adding a language pack.** One new file in `server/generate/packs/` implementing
`LanguagePack`, one line in the `PACKS` map in `server/generate/index.ts`. Nothing in
core changes. If your change to support a language touches anything outside those two
places, the abstraction is wrong — say so rather than patching around it.

**Adding a migration.** New `server/db/migrations/00N_thing.sql`. They run in
filename order, once, recorded in `_migration`. Never edit an applied migration.

**Adding an endpoint.** `server/api.ts`, then a method on `api` in `ui/src/api.ts`.
Error responses are always `{ code, message }` with a SCREAMING_SNAKE code — the UI
surfaces `message` verbatim, so write it for the person reading it.

**Adding a finding.** Give it a stable SCREAMING_SNAKE code, a `severity`, and a
`fixHint` that says what to actually do. Add the row to the reference table in
`ui/src/views/Checks.tsx` in the same commit. A checker that says "something is
wrong" is a checker people turn off.

**UI.** Colours come from tokens in `theme.css` — no hex literals in components. Lane
colour is informational (which side of the line) and is kept separate from semantic
colour (ok / warn / stop) so the two never compete for the same cue. Both light and
dark are defined at token level, including the un-stamped system-preference case.

**Copy.** Write from the reader's side of the screen. Say what happened and what to
do about it. No apologies, no "oops", no exclamation marks.

---

## Testing story (and its gap)

There is no unit test suite yet. This is the most significant gap in the repo and a
good first contribution. Until there is, verification is:

1. `npm run check` — types.
2. `npm run seed` — exercises the splitter, contract state machine, all three
   generators and the checker in one run, and prints what it did.
3. `npm run eval` — scores the splitter on ten briefs, four deliberately awkward.

If you add tests, start with the parts that are pure functions over plain objects and
have the highest cost of being wrong: `contracts/diff.ts` (change classification),
`contracts/build.ts` (`specHash` stability, `compileSchema`), `splitter/validate.ts`
(all six checks), `generate/pack.ts` (banner round-trip), `status/derive.ts`. Use
`node:test` — it needs no new dependency.

---

## Gotchas that have already bitten

- **`better-sqlite3` is native.** This is why the server runs as a **sidecar Node
  process** rather than inside Electron's main process — compiling against Electron's
  ABI on every machine is a setup failure waiting to happen. Do not "simplify" this
  by moving the server into Electron.

- **Provider schema dialects disagree.** OpenAI strict mode *requires*
  `additionalProperties: false` and every property listed in `required`; Gemini
  *rejects* `additionalProperties`. `toGeminiSchema()` in `models/google.ts` bridges
  them. Hand-write the pass schemas in `splitter/schemas.ts` — generated
  zod-to-json-schema output violates OpenAI's constraints.

- **Heuristic regexes are polysemy traps.** The dashboard rule deliberately does not
  match a bare "report", because "vehicles report their position" is not a request
  for a dashboard — and that one false positive grew a whole pair of modules nobody
  asked for. Add a comment whenever you narrow a pattern for this reason.

- **The prompt cache hides prompt changes.** Set `SPARK_CACHE=0` while tuning prompts
  or you will be reading yesterday's answer.

- **Narrowing does not survive into closures for destructured parameters.** This bit
  `SettingsView`. Use a default (`projectId = ''`) or a local const.

- **The offline provider is not a stub.** `models/fake.ts` + `heuristics.ts` is a real
  rule table, it is the zero-setup path, and it is the floor a real model must beat.
  Keep it working. If the eval set scores a local model below it, the honest
  recommendation is to use it instead.

---

## Where the unfinished work goes

| Feature | Where |
|---|---|
| Git integration (phase 5) | New `server/git/`, routes in `api.ts`; `.spark/` writer already exists |
| tree-sitter level 3 | `server/deps/check.ts`, `level3()` only |
| Running contract tests | `server/deps/`, then a new branch in `status/derive.ts` |
| Migration-window timers | `api.ts` change-request routes + a scheduled sweep |
| Splitter refinements | See `SPLITTER_ROADMAP.md` — start with B1/B2 and the seam checkpoint |
| A CLI | Talks to the existing HTTP API; no server changes needed |

---

## Working style expected here

- **Do not add dependencies casually.** The generated output is deliberately
  dependency-free so it never forces a library choice on the project it lands in, and
  the app itself is close to that too. If you need a package, say why in the commit.

- **Prefer honest limits over quiet approximations.** Level 3 says out loud that it is
  a text scan and reports at `warn` where a parser would `block`. That is the house
  style: be useful, and be clear about what you cannot see.

- **When the tool cannot decide, hand it to a person with enough context to decide
  quickly.** A half-correct draft someone fixes in ninety seconds beats a third retry
  and a spinner. The harness already works this way; keep new features consistent
  with it.

- **Watch for scope creep into a project manager.** Boards, claims and status invite
  endless feature requests that have nothing to do with the thesis. Re-read the one
  rule at the top before agreeing to build one.
