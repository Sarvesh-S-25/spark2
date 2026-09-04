# SparkX — project instructions

@AGENTS.md

The import above carries the full brief: what SparkX is, the twelve invariants,
the repo map, conventions, and the gotchas. Read it as part of these
instructions, not as background reading.

## The build plan — read this before proposing any work

**The plan lives in `README.md`, under the heading `# The plan`.** Read that section
at the start of any task about building, extending or fixing SparkX.

It is phased, and the phases are ordered for a reason:

```
Phase 1  prove it runs        ← BLOCKS EVERYTHING
Phase 2  local-CLI engine
Phase 3  MCP server
Phase 4  web hardening
Phase 5  splitter quality
```

**Phase 1 is not optional and not skippable.** This codebase has never been
installed or executed — no `node_modules`, no first run. Until `npm run check` and
`npm run seed` pass, every other phase is building on ~7,000 lines of unproven code.

So, when asked to build something:

1. Say which phase it belongs to.
2. If Phase 1 has not passed yet, say so and offer to do Phase 1 first. Do not
   silently start Phase 2+ work.
3. Work through a phase in the order the plan lists, and stop at its "Done when".

`npm run preflight` is the zero-dependency check — it runs before `npm install` and
catches unresolvable imports and missing exports. Run it after any change that moves
code between files.

---

Deeper references, to open when a task actually needs them rather than up front:

- `ARCHITECTURE.md` — file-by-file, how every part works and why
- `SPLITTER_ROADMAP.md` — the four weaknesses in the splitter and seventeen fixes (Phase 5)
- `HOW_TO_RUN.md` — commands, setup, and what is not built yet

---

## Consult Gemini before you start

Gemini is the second opinion on this project, reached through the **Antigravity
CLI** (`agy`) — the standalone `gemini` CLI can no longer sign in with a Google
account. **Any task with a design decision in it gets referenced with Gemini
before implementation begins** — a
feature, a refactor, a schema or contract change, a bug whose cause is not yet
known, or anything touching more than one file.

Two ways, depending on size:

- **A whole task** → hand it to the `gemini-planner` subagent. It gathers the
  context, asks Gemini for a plan, checks the answer against this repo, and
  returns a plan with the disagreements marked.
- **A single question** → the `gemini-call` skill, or directly:

  ```bash
  node .claude/scripts/gemini.mjs --dirs server/splitter "your question"
  ```

**Prefer `--dirs` over reading files into context.** `agy` is an agent with its
own file tools, so `--dirs` tells it where to look rather than shipping contents.
Its context is large and mine is the scarce resource.

The wrapper is read-only by intent — it never passes
`--dangerously-skip-permissions`, so Gemini can read to answer but cannot change
anything. It advises; I act.

**Report what it said, then judge it.** Say what Gemini recommended, where I
agree, and where I do not and why. Never relay its answer as settled, and never
adopt it silently. It has not read this conversation and does not know this repo
as well as `AGENTS.md` does — **where the two conflict, the invariants win.**

**Skip it, and say so, for:** single-line edits, typos, renames, running a
command, reading a file, anything already specified precisely enough to just do,
and follow-ups inside a task Gemini has already reviewed. Consulting it about a
typo costs a minute and tells us nothing.

**Exit code 2 is a setup problem** — nothing installed, or authentication failed.
Stop and say so rather than proceeding as though the review happened; retrying
will not fix it. A quota error is exit 1: say so in one line and carry on alone.

---

## Before finishing any change

1. `npm run check` — there is no test suite yet, so the type checker is the
   safety net. It must pass.
2. If the change touches the splitter, contracts or generators, run
   `npm run seed` and read what it prints. It exercises the whole pipeline.
3. If the change touches the splitter's prompts or validations, run
   `npm run eval` with `SPARK_CACHE=0`.

Never report work as done without having run at least the first of these.
