---
name: gemini
description: Delegate reading, research, planning and code review to Gemini via ./.agent/bin/agy-exec.sh instead of doing it yourself. Use this whenever answering or planning would need more than about three files read, tracing a call path across modules, finding every usage of a symbol, planning a change whose blast radius is unknown, or reviewing a set of files. Reach for it BEFORE broad exploration, not after — even when Gemini is not mentioned.
when_to_use: Triggers include "how does X work", "where is X used", "what would break if", "plan this refactor", "review these files", or any moment you are about to read a fourth file to answer one question.
argument-hint: "[plan|research|review|ask] [subject]"
arguments: [mode, subject]
allowed-tools: Bash(./.agent/bin/agy-exec.sh *)
---

# Gemini delegation

Gemini reads; you edit. Its context window is larger than yours and reading the
codebase is its job. Do not spend your own context on exploration you can
delegate.

## Current handoff state

Plan on file:
!`test -s .agent/plan.md && cat .agent/plan.md || echo "(none)"`

Latest status entries:
!`tail -30 .agent/status.md 2>/dev/null || echo "(none)"`

## Dispatch

```bash
./.agent/bin/agy-exec.sh $mode "$subject"
```

If no mode was given, pick one from what I asked for:

| Mode | Use when | Lands in |
| :--- | :--- | :--- |
| `plan` | a change needs ordered, verifiable steps | `.agent/plan.md` |
| `research` | a question about how the code works | `.agent/findings.md` |
| `review` | critique of named files or `git diff` | `.agent/review.md` |
| `ask` | a one-off you do not need on disk | printed only |

Long runs (whole-directory reads, refactor planning) go in the background so
you keep working; collect the result when it lands. Raise the budget for those
with `GEMINI_TIMEOUT=12m`.

## Writing the subject

Each run is a fresh session with no memory of previous ones, and quota is
metered by compute effort rather than request count — a vague subject makes
Gemini sweep the repo and can exhaust a Pro allowance in a couple of calls.

- Name exact paths: `src/auth/session.ts and src/middleware/auth.ts`, not
  "the auth code".
- One subject per call. Two unrelated asks gets a worse answer to both.
- State the shape you want back if the mode's default format does not fit.
- Never phrase it as a task to perform. "Plan the migration" is fine;
  "do the migration" invites subagent loops that cost real quota.

Good: `research "read src/api/ and src/db/. every path that writes to the users table, with file:line and whether it validates input"`

Bad: `research "tell me about the user code and fix the validation"`

## Acting on the output

Treat it as claims, not truth. It is a different model reading the same repo and
it can be confidently wrong about specifics.

- Before editing a file it named, open the cited lines and confirm they say
  what it claimed.
- If a claim contradicts the file, the file wins. Say the plan was wrong.
- Do not relay its findings to me as established fact without checking the part
  you are about to act on.
- After acting on a plan, append to `.agent/status.md`: what you did, what
  passed, what you rejected and why. Gemini reads that before replanning.

## Failure handling

The script exits with a distinct code per failure:

- **4 / `GEMINI_QUOTA_EXHAUSTED`** — allowance spent. Do not retry and do not
  call the script again this session. The message usually names the reset
  window (a Pro allowance refreshes roughly every five hours). Say which
  failure happened, then read files yourself, narrowly.
- **5 / `GEMINI_AUTH_ERROR`** — sign-in broken or the account tier lost access.
  Stop and tell me; this needs fixing outside the session.
- **6 / `GEMINI_EMPTY_OUTPUT`** — the pty capture failed. Retry once, then
  tell me and fall back.
- **127** — `agy` or `script` missing. Tell me and fall back.

Always name the failure. Silently switching to reading files yourself hides a
broken setup for days.