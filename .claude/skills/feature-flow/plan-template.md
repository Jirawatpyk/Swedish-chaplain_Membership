# Plan: <feature name>

Spec: `specs/<nnn-name>/spec.md` · Size: M / L · Agreed by the user on: <date>

## Approach

What we will build and how, in a few paragraphs. Name the alternatives considered and why each was not taken.

## Files and modules

The files to create or change, grouped by module. Name the `.claude/rules/modules/*.md` rules that apply, and any cross-module port touched (a change in one module's meaning leaves stale fixtures in the others).

## Data model and migration

Tables, columns, enums, RLS policies, triggers and indexes. The migration number and what it does; whether it is unflagged on deploy; how it rolls back. Write `n/a` if there are none.

## Slices (L only)

In build order. Each slice is the thinnest DB → use case → API → UI path that works and can be demoed on its own.

| # | Slice | Done-when lines it covers | Surface reviewers | PR |
|---|---|---|---|---|
| 1 | … | … | … | … |

## Test plan

One row per Done-when line. This is the build's task list: one behaviour per row, never one row per test file.

| Done-when line | Test that goes red first (file, name) | Level (unit / contract / integration / e2e) |
|---|---|---|
| … | … | … |

Also name the cross-tenant test (for a tenant-scoped surface) and the e2e specs to run on chromium + mobile-chrome.

## Constitution Check

Each of the 10 principles in `.specify/memory/constitution.md`: pass, or the deviation and where it is tracked.

## Complexity Tracking

| Deviation | Why it is needed | Simpler alternative rejected, and why |
|---|---|---|
| Solo-maintainer review (sensitive surfaces only) — the five checks in `review-and-ship` § 2 and where each is evidenced | No second human reviewer | — |

## Rollout

Feature flag (default OFF, added only when ready to deploy); what goes live unflagged on merge; deploy and migration order; how to roll back.

## Risks

What could go wrong, and how we would notice (a test, a gauge, a log line).
