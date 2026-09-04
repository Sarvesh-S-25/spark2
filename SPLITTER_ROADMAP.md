# Refining the splitter

The splitter is the piece that has to be genuinely good and the piece that fails
silently. Everything downstream — contracts, generated stubs, the board, the checker
— is confidently wrong if the split is wrong.

This is an honest account of what it does today, where it is weak, and seventeen
things that would make it better, ordered by leverage rather than by ambition.

---

## Where it stands

Three passes: **A** capabilities → **B** seams → **C** modules. Seams before modules,
which is the counterintuitive part and the reason the output holds together. The
model never writes JSON Schema — it fills in a flat field table from a closed
vocabulary and `compileSchema()` compiles it. Six structural validations run on the
raw output; only repairs with exactly one correct answer are applied, and each is
logged.

On the live-map brief the offline provider produces 9 contracts and 13 modules with
zero validation issues, and `fe.gesture-controller` correctly falls out as depending
on nothing.

### The four real weaknesses

1. **Pass B does two jobs at once.** It both enumerates the seams and specifies every
   field of every one, in a single response. That is the longest, most structured
   output in the whole system, produced by the pass that matters most, in one shot.
   It is where a small model breaks and where a repair loop is least likely to
   recover, because a single bad field invalidates the whole response.

2. **All three passes run blind.** You see the result after modules exist. But seams
   are the load-bearing artifact — a wrong seam produces two wrong modules and a
   wrong contract — and by the time you can see it, it has already been persisted.

3. **Nothing measures whether the split is good at its actual job.** The validations
   check that it is *well-formed*: closed, acyclic, lane-pure. None of them ask the
   question the product exists to answer — *how much work can two people do in
   parallel starting now?* A split can pass every check and still serialise the whole
   project through one module.

4. **It has no memory.** Every brief is a cold start. The heuristic table encodes
   knowledge of project shapes that the real model never sees, and an accepted split
   teaches the tool nothing.

Everything below attacks one of those four.

---

## Tier 1 — mechanical, cheap, high certainty

These are refinements to what exists. None of them change the concept; all of them
raise the floor.

### 1. Split Pass B into B1 (enumerate) and B2 (specify)

*Attacks weakness 1. Do this first.*

**B1** returns only the seam skeleton — one line each, no fields:

```jsonc
{ "seams": [
  { "key": "markers.list", "kind": "http", "direction": "client_to_server",
    "summary": "markers inside the visible bounding box", "capability_ids": ["see-markers"] }
]}
```

**B2** runs **once per seam**, with only that seam's skeleton plus the capabilities it
serves, and fills in the field table, transport and error codes.

Why this is the highest-leverage change in the document:

- Each B2 call is tiny, so a 7B model is being asked something it can actually do.
- The calls are **independent** — run them with `Promise.all`, so wall-clock goes
  *down* despite there being more calls.
- Each is **separately cacheable**. Edit one seam, re-specify one seam.
- Each is **separately repairable**. One malformed field table no longer costs you
  the entire seam list.
- A B2 failure degrades gracefully: you get eight good contracts and one you fill in
  by hand, instead of nothing.

Where: `splitter/prompts.ts` gains `PASS_B1_*` / `PASS_B2_*`; `splitter/index.ts`
gains a fan-out; `models/fake.ts` answers two more `schemaName` cases. The harness,
the cache and the accounting need no changes at all.

### 2. A seam checkpoint before Pass C

*Attacks weakness 2.*

Stop after B and show the seam table with the same edit affordances the contract
editor already has: rename a key, change `kind`, merge two seams, delete a
speculative one, add one the model missed. Then run Pass C on what the human
approved.

This is cheap — the UI component already exists on the Contracts screen — and it puts
the human decision at the point where one decision is worth ten downstream. Keep a
**Split it all** button for people who want the current behaviour.

### 3. Put the rubric in the prompt

Pass C is graded by six validations it has never been told about. Add them to the
system prompt as the checklist they are, with one-line examples of a violation:

```
Your output will be rejected if:
  · a module consumes a seam key that is not in the list you were given
  · two modules provide the same seam  (one provider, always)
  · a frontend module has kind service/job/api_route
  · any module is estimated L  (split it into two and emit both)
```

Models do measurably better when handed the marking scheme. Near-zero cost.

### 4. Recursive re-split of oversized modules

The plan promised auto re-split for `est_size: L`; today it is only a warning. Make
it real: take the L module alone — its summary, responsibilities and contracts — and
ask for two or three modules with a new internal seam between them. Bound the
recursion to depth 2 so it cannot run away.

An L module is a missed opportunity for parallelism, which is exactly the thing the
product is for.

### 5. Instability warning

Run B1 twice at temperature 0 with the cache off and compare the seam key sets. If
they disagree, say so on the split:

> *This split is unstable — two identical runs produced different seams. The brief is
> probably ambiguous about `<the keys that differed>`.*

Instability at temperature 0 means the prompt or the brief is under-specified, and
telling the user that is far more useful than silently picking one. Costs one extra
B1 call, which is now the cheapest call in the system.

---

## Tier 2 — make it measurably better

### 6. Pass 0 — triage and archetype

*Kills the whole class of "a CLI tool with a frontend lane" failures the eval set
already catches.*

Before Pass A, one small call:

```jsonc
{
  "archetype": "web_app",          // web_app | spa_only | static_site | cli |
                                   // mobile_app | library | data_pipeline | service
  "lanes_in_play": ["frontend", "backend", "shared"],
  "has_persistence": true,
  "has_realtime": true,
  "has_accounts": false,
  "third_party_only": false,       // true = it just calls someone else's API
  "missing_info": [
    "How many vehicles, and how often do they report?"
  ]
}
```

Then: lanes not in play are *forbidden* to Pass C, and `missing_info` becomes the
clarifying questions. A static-site brief simply cannot grow backend modules, because
the backend lane was never on the table.

### 7. Clarify loop — questions before splitting, answers stored on the plan

`missing_info` from Pass 0 becomes two or three multiple-choice questions in the UI.
The answers are appended to the plan revision, so the split stays reproducible and
"why does this module exist?" still has a readable answer.

The rule to hold: **at most three questions, and every one must change the split.**
Nobody fills in a form to use a tool. If you cannot say which modules an answer would
change, do not ask it.

### 8. A referee pass — Pass D

*The validations catch malformed. This catches badly-shaped.*

After Pass C, one cheap call that receives **only the graph** (no brief — that is why
it is cheap) and is asked for things a structural checker cannot see:

- a module doing two unrelated jobs
- a contract that is really two contracts
- a boundary in the wrong place — the seam is drawn where it is convenient rather
  than where the work divides
- a module needlessly on the critical path
- two modules that would always be edited together and should merge

It outputs **proposals with rationale, and never edits**. Each renders as
accept/reject next to the module it concerns. This preserves the report-then-repair
discipline: the machine may notice, the human decides.

### 9. A parallelism score — an objective function for splits

*Attacks weakness 3, and it is the idea I would most want to build.*

Right now "is this a good split?" is a matter of taste. Make it a number. All four
metrics are computable from data already in the database — no model involved:

| Metric | Definition | Why it matters |
|---|---|---|
| **Front load** | fraction of total estimated work startable at t=0 | how much can begin today |
| **Parallel width** | max simultaneously-Ready modules under an optimal contract-lock order | how many people the split can occupy |
| **Critical depth** | longest provider→consumer chain of unfinished modules | the floor on project duration |
| **Lane balance** | \|frontend work − backend work\| ÷ total | whether one person is the bottleneck |

Show them on the Overview screen as a small tile row, with the arithmetic visible on
hover. Then two things become possible that are not possible today:

- **The referee optimises against it.** Pass D can be asked to propose the single
  change that most raises front load, and you can verify whether it did.
- **The eval set gains a real metric.** Contract completeness measures whether the
  split is *complete*; front load measures whether it is *useful*. A splitter that
  scores 100% completeness and 15% front load is failing at its job while passing
  every test.

Where: `server/status/metrics.ts` (new), reading from `deriveAll()` and the contract
graph. Perhaps a day's work, and it changes how every other improvement gets judged.

---

## Tier 3 — make it better over time

### 10. Precedent retrieval

*Attacks weakness 4. The highest ceiling of anything here.*

Every split a human **accepts** is stored as a precedent: the brief text, the final
seam list, the final module list, and what the human changed from what the model
produced. On a new brief, retrieve the two or three nearest precedents and put them
in the B1 prompt as worked examples.

Two ways to find "nearest", and the cheap one is fine:

- **No key needed:** TF-IDF over brief text with cosine similarity, ~40 lines of
  plain TypeScript, no dependency. Good enough at this corpus size.
- **With a key:** an embeddings call, cached by brief hash in the existing
  `prompt_cache` table.

What this buys, in order of appearing:

1. The hard-coded `heuristics.ts` table stops being a hack and becomes the **seed
   corpus** — ship the nine known project shapes as pre-loaded precedents.
2. The tool learns *your team's* conventions. If you always name it `items.list`
   rather than `items.index`, it starts doing that.
3. **The human's edits are the training signal.** The diff between what the model
   produced and what the person accepted is the most valuable data the app generates,
   and today it is thrown away.

Where: a `precedent` table, `splitter/precedents.ts`, and three extra lines in the B1
prompt builder.

### 11. Contract identity matching across re-splits

Listed as an open question in the plan; it is implementable now. When a re-split
produces a seam that is semantically the same as an existing one under a different
key, match it instead of creating a duplicate: score on transport equality, then
schema-hash equality, then name similarity. Above a threshold, **propose the merge —
never do it silently**, because a wrong merge quietly rewires two people's work.

Without this, every re-split slowly accretes near-duplicate contracts, and the
contract table becomes the thing nobody reads.

---

## Tier 4 — work on projects that already exist

Nobody adopts a tool that demands a greenfield repo. These two are the difference
between a demo and something a team keeps using.

### 12. Delta split — add one feature to an existing project

Pass the existing contract and module lists as context and ask only for the **delta**:
new seams, new modules, and which existing contracts the feature needs to consume.
Existing locked contracts are read-only inputs to the prompt.

This is the common case after week one, and today the only option is a full re-split.

### 13. Reverse split — extract contracts from a repo

Point SparkX at an existing codebase and derive the contracts from the code: routes
defined, `fetch`/`axios` calls made, shared types already exported. Produce contracts
in `proposed` state for a human to confirm.

Level 3's `UNDECLARED_CALL` is already half of this — it finds endpoints the code
calls that no contract covers. Turn that finding's "create contract from this call"
action into a bulk import and the loop closes: a live project can be brought under
contract incrementally, one seam at a time, without stopping work.

---

## Tier 5 — say more per seam

### 14. `freshness` and `cardinality` — let the data flow pick the transport

Add two fields to every seam:

```jsonc
{ "cardinality": "one" | "many" | "stream",
  "freshness":   "on_demand" | "seconds" | "sub_second" | "eventual" }
```

They decide something juniors reliably get wrong: whether a boundary should be `http`,
`event`, or both. Then a new validation writes itself:

> `markers.list` is declared `http` but its freshness is `sub_second`. Polling an
> endpoint sixty times a minute is a websocket with extra steps — either relax the
> freshness or add an `event` seam beside it.

Two extra fields in the field table, one validation, and the tool starts teaching
architecture instead of just recording it.

### 15. Budgets as contract terms

Let a seam carry `p95_ms` and `max_payload_kb`. Generated contract tests assert them.
This turns non-functional requirements — the ones that always arrive as a complaint
in week six — into something with an owner and a failing test.

### 16. More than two lanes

`lane` is already a column with four values, but the prompts only really think in
frontend/backend. Add `mobile` and `worker`, and let Pass 0's `lanes_in_play` decide
which exist for this project. A brief with a mobile client and a background job is
three-way parallel, and the tool should be able to say so.

### 17. Capability × module coverage matrix

Uncovered capabilities are already a warning. Make the whole mapping visible as a
grid: capabilities down the side, modules across the top, a mark where a module's
acceptance statements serve a capability. Two failures become obvious at a glance
that are currently invisible — a capability with modules but no *checkable* statement
anywhere, and a module that serves no capability at all and therefore has no reason
to exist.

---

## Suggested order

**Now** — 1 (B1/B2), 3 (rubric), 5 (instability). All three touch only prompts and
`splitter/index.ts`, and together they make the current design as good as it can get.

**Next** — 9 (parallelism score) before anything else in Tier 2, because it is how
you will judge whether the rest of these actually helped. Then 2 (seam checkpoint)
and 6 (Pass 0 triage).

**Then** — 8 (referee) and 4 (recursive re-split), which both benefit from having the
score to aim at.

**When there is real usage** — 10 (precedents). It needs accepted splits to learn
from, so it is worth nothing on day one and a great deal on day thirty.

**When somebody else wants to use it** — 12 and 13.

---

## Ideas I would resist

Written down so they do not get proposed as improvements later.

- **One giant pass with a very long prompt.** Fewer calls looks like a simplification
  and is the opposite: it removes every independent repair boundary at once.

- **Letting the model write JSON Schema directly.** It is the obvious cleanup and it
  is the wrong one — the field table is what makes small models viable.

- **Auto-fixing anything that needs judgement.** Cycles, provider choice, merging
  contracts. The moment SparkX silently reshapes a boundary, people stop trusting
  the board, and the board is the product.

- **Fine-tuning a model on splits.** Precedent retrieval gets most of the benefit,
  needs no training run, works on any provider including a local one, and can be
  inspected and corrected by a person. Reach for retrieval before weights.

- **A "confidence score" from the model on its own output.** Self-reported confidence
  is noise. The instability check in item 5 measures the same thing behaviourally,
  which is worth something.
