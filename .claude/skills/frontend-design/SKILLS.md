---
name: frontend-design
description: Design UI through the Google Stitch MCP before writing any front-end code. Use this skill whenever the task touches a screen, page, view, component, layout, modal, form, dashboard, or design system — including new UI, restyling existing UI, fixing spacing or visual hierarchy, or any "make this look better / this looks off" request. Use it even when Stitch is not mentioned and even when the request sounds like a small styling tweak.
when_to_use: Triggers include "build a page", "add a screen", "create a component", "design the UI", "restyle this", "the layout looks off", "make this look better", "add a modal/form/dashboard", or any work on files under ui/src/.
paths: ui/src/**, **/*.tsx, **/*.jsx, **/*.css
allowed-tools: mcp__stitch__*
---

# Front-end design via Stitch

UI in this project is designed in Stitch first, then translated into the codebase. Do not hand-write layout or styling from scratch.

## Procedure

1. Call `list_projects`. This repo's Stitch project is named after the repo. If it does not exist, create it with `create_project`.
2. Call `list_screens`. If a screen already matches the request, use it — do not generate a duplicate.
3. If no screen matches, call `generate_screen_from_text` with a prompt covering: the screen's purpose, the key elements it must contain, and every constraint from the section below.
4. Retrieve the result with `fetch_screen_code`. Use `fetch_screen_image` when you need to describe the visual result back to me.
5. Translate the output into this codebase's conventions. Never paste Stitch markup verbatim — map it onto existing components and tokens, keep our file and prop naming, and drop any inline styles in favour of our token classes.
6. Report the Stitch project and screen name so I can open and iterate on the design directly.

## Constraints for every Stitch prompt

- Stack: React + TypeScript with plain CSS. This project does NOT use Tailwind — do not emit utility classes
- Match the design tokens in `ui/src/theme.css` — no new colours, spacing values, or font sizes
- Lane colour (`--fe`/`--be`/`--sh`/`--infra`) is informational and must stay distinct from semantic colour (`--ok`/`--warn`/`--stop`); never use one for the other
- Every colour must be defined for both light and dark at token level, including the un-stamped system-preference case
- Reuse the shared components in `ui/src/bits.tsx` and the layout patterns in `ui/src/views/`
- Mobile-first, WCAG AA contrast minimum
- Keyboard accessible: visible focus states, labelled inputs, escapable overlays

## Iterating on an existing screen

For a change to UI that already has a Stitch screen, fetch that screen and regenerate from it rather than starting a new one. Keep one screen per view so the Stitch project stays a usable record of the design.

## When to skip Stitch

Bug fixes, state or data-fetching changes, copy edits, and single-property tweaks (one padding value, one colour swap). Say that you are skipping Stitch and why, then make the change directly.

## If Stitch is unavailable

Distinguish two failure modes and handle them differently.

**Quota or rate limit exhausted** — the error mentions quota, credits, limits, `RESOURCE_EXHAUSTED`, or HTTP 429. Do not retry, and do not stop working. Say in one line that Stitch credits are exhausted and you are designing directly, then build the UI yourself. Every constraint in this file still applies: same tokens, same `src/components/ui/` patterns, same accessibility bar. Before writing code, state the layout you intend in two or three sentences so I can redirect you cheaply. Assume Stitch stays unavailable for the rest of the session — do not call it again unless I ask.

**Broken connection or auth** — the tools are missing entirely, or the error mentions authentication, credentials, an invalid API key, or dynamic client registration. This is a configuration problem, not a credits problem. Stop and tell me, and do not fall back; I would rather fix the MCP setup than merge design that bypassed it.

If you cannot tell which it is, quote the error and ask.