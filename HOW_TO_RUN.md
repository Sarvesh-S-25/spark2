# How to run SparkX

Everything below assumes you are in the project folder — `C:\Users\sarve\Desktop\spark2`.

---

## 1. Install

```
npm install
```

This takes a couple of minutes the first time. Two notes:

- **`better-sqlite3` is a native module.** npm downloads a prebuilt binary for your
  Node version, so this normally just works. If it tries to compile from source and
  fails, install the Windows build tools once: `npm install --global windows-build-tools`,
  or install Visual Studio Build Tools with the "Desktop development with C++" workload.
- **Electron is an optional dependency.** If its ~100 MB download fails, `npm install`
  still succeeds and everything except `npm run app` keeps working. You can run
  SparkX perfectly well in a browser tab.

Then check the whole thing type-checks:

```
npm run check
```

This is the one step I could not run for you — the sandbox I built this in has no
access to the npm registry, so no dependencies and no type definitions were
installable there. Every file was syntax-checked and the splitter, contract builder
and all three code generators were run end-to-end, but the type checker has not
seen the code with real library types. If `npm run check` reports anything, paste it
to me and I will fix it.

---

## 2. Configure (optional)

```
copy .env.example .env
```

SparkX works with **no key and no internet**. Leaving `SPARK_PROVIDER=fake` uses the
built-in heuristic planner, which recognises common project shapes and produces a
real, contract-closed split with no model involved. It is deterministic and free,
and it is the floor a real model has to beat.

To use your OpenAI key, edit `.env`:

```
SPARK_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

Gemini and Ollama are wired the same way — `SPARK_PROVIDER=google` with
`GOOGLE_API_KEY`, or `SPARK_PROVIDER=ollama` with Ollama running locally. You can
also route individual passes:

```
SPARK_PROVIDER=ollama
SPARK_PROVIDER_PASS_B=openai      # spend the key only on the hard pass
```

Restart the server after changing `.env`.

---

## 3. Load the worked example (recommended first run)

```
npm run seed
```

This creates the "Live map tracker" project from the plan, splits the brief, locks
its contracts, generates code for all three language packs into
`workspace/live-map-tracker/`, and runs a dependency check. It prints everything it
does. Add `--reset` to wipe the database first: `npm run seed -- --reset`.

---

## 4. Run it

**In a browser (simplest, always works):**

```
npm run dev
```

Then open <http://localhost:5173>. This starts the API server on port 5178 and the
Vite dev server on 5173 with hot reload.

**As a desktop app:**

```
npm run app
```

This builds the UI and opens an Electron window. The window starts the API server as
a child process and shuts it down when you close it.

**Server only** (for the API, or if you want to drive it from curl):

```
npm run start
```

---

## 5. The five-minute tour

1. **Projects** → open "Live map tracker" (or create your own).
2. **Brief & split** → the brief is there. Hit **Re-split** and watch the three passes
   run. Look at the capabilities list: if something there is wrong, everything
   downstream is confidently wrong, which is why it is the first thing shown.
3. **Requirements** → filter to *I can start now*. `fe.gesture-controller` will be in
   that list: it consumes no backend contract at all, so touch pan/zoom can be built
   while the backend is still choosing a database. That is the whole product in one row.
4. **Contracts** → click `markers.list`. Try to edit it — it is locked, so you can't;
   you have to open a change request, and SparkX computes whether your change is
   additive, widening or breaking from the schema diff rather than believing you.
5. **Generate** → write the files, then look in `workspace/live-map-tracker/`:
   `src/spark/client/markers-list.ts` is what the frontend developer calls on day one,
   `server/spark/routes/markers-list.ts` is the backend's skeleton, and
   `server/spark/tests/markers-list.test.ts` is the failing test they have to make pass.
6. **Dependency check** → run it. Now go and rename a field in one of the generated
   files by hand and run it again: `GENERATED_EDITED`.

---

## 6. Try the evals

```
npm run eval
```

Runs ten briefs — six realistic, four awkward on purpose (a CLI tool with no
frontend, a static site with no backend, a third-party-API widget) — and scores
contract completeness, closure rate, lane purity and scope discipline. Use it
whenever you change a prompt or switch models. For the stability metric, run it
twice with the cache off:

```
set SPARK_CACHE=0 && npm run eval
```

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | API server + Vite with hot reload. The one you'll use. |
| `npm run start` | API server only, port 5178. |
| `npm run app` | Build the UI and open the Electron desktop window. |
| `npm run seed` | Load the live-map worked example. `-- --reset` wipes first. |
| `npm run eval` | Score the splitter against the golden brief set. |
| `npm run check` | TypeScript type check across server and UI. |
| `npm run build:ui` | Production UI build into `dist-ui/`. |

---

## Where things live

| Path | What |
|---|---|
| `data/spark.db` | Your SQLite database. Delete it to start over. |
| `workspace/<project>/` | Default output directory for generated code. |
| `.env` | Your keys and model routing. Gitignored. |
| `server/` | API, splitter, contract layer, generators, checker. |
| `ui/src/` | The React app. |

---

## If something goes wrong

**"Cannot reach the SparkX server"** in the UI — the API is not running. `npm run start`
in a second terminal and read the error it prints.

**`npm run seed` fails on better-sqlite3** — the native module did not build. See the
install note above.

**Port 5178 already in use** — set `PORT=5179` in `.env` and restart.

**The split produces nothing useful** — check **Settings**. If your provider says
"unavailable", SparkX has no model to talk to. Set `SPARK_PROVIDER=fake` and you will
at least get a real split to look at while you sort the key out.

**Electron opens a blank window** — the server did not start in time. Run
`npm run start` first, confirm <http://localhost:5178/api/health> answers, then
`npm run app`.

---

## What I need from you

1. **Run `npm install` and then `npm run check`**, and send me anything it reports.
   This is the one verification I could not do myself.
2. **Run `npm run seed` and tell me what it prints.** It exercises the splitter,
   the contract state machine, all three generators and the checker in one go, so
   its output tells us almost everything about whether the wiring is right.
3. **Decide the name.** This ships as `SparkX` with a `.spark/` directory and a
   `spark` command name. The project is called Spark2. Worth settling before it is
   in a repo.
4. **If you want the Git phase built next**, I need to know: GitHub, and one repo or
   two (frontend and backend separately)? The `.spark/` directory design assumes one.

## What is not built yet

These are real gaps, not oversights — they are the parts of the plan that come after
what I built, and each one is called out in `ARCHITECTURE.md` where the code for it
would go:

- **Git integration.** No repo connect, no branch-per-module, no PR bodies, no
  `spark check` GitHub Action. Phase 5 of the plan.
- **Level 3 checking is a text scan, not a parse.** It finds missing implementations
  and undeclared calls by searching for path strings. It works and it is useful, but
  it reports at warning strength where tree-sitter would block, and it cannot see a
  signature mismatch inside a function. Swapping in tree-sitter is a change to
  `server/deps/check.ts` alone.
- **Contract tests are generated but not run.** SparkX writes the failing test; it
  does not yet execute your project's test command and fold the result into status.
  That is why `contract_met` currently means "files exist and contracts are locked"
  rather than "the tests pass".
- **The 48-hour silence rule and migration windows are policy, not code.** Change
  requests, acks, objections-need-reasons and break-glass all work; the timers that
  auto-ack a minor change after 48 hours are not wired to a clock.
- **No CLI or VS Code extension.** The local HTTP API they would use exists and is
  documented — that is why the server is a real HTTP surface rather than functions
  the UI imports.
