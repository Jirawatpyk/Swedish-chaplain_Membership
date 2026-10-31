# Plan: <feature name>

Spec: `specs/<nnn-name>/spec.md` · Size: M / L · Agreed by the user on: <date>

## Approach

What we will build and how, in a few paragraphs. Name the alternatives considered and why each was not taken.

**Paths kept compatible:** name each one and point at its usage line in `spec.md` § Premises (count · source · date lives there only, D-041). A path with no usage is a candidate for removal, not protection.

## Files and modules

The files to create or change, grouped by module. Name the `.claude/rules/modules/*.md` rules that apply, and any cross-module port touched (a change in one module's meaning leaves stale fixtures in the others).

## Data model and migration

Tables, columns, enums, RLS policies, triggers and indexes. The migration number and what it does; whether it is unflagged on deploy; how it rolls back. Write `n/a` if there are none.

## Slices (L only)

In build order. Each slice is the thinnest DB → use case → API → UI path that works and can be demoed on its own. Slice *k* builds on branch `<nnn>-<short-name>-s<k>`; its PR sets its own row to the PR number and `done` before it merges.

| # | Slice | Done-when lines it covers | Surface reviewers | Branch | PR · status |
|---|---|---|---|---|---|
| 1 | … | … | … | `<nnn>-<short-name>-s1` | — · open |

## Test plan

One row per Done-when line. This is the build's task list: one behaviour per row, never one row per test file.

If more than one writer can touch the same row (a cron that can overlap itself, a webhook racing a user action, a hold racing a send), add a **state table** before the build: the row's states × each external answer (probe, provider status) × each decision, with the handler and one named test per cell. A cell with no test is where the next review will land (retro 2026-10-29, spec 138).

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

## Evidence

Filled in from the maintainer's `/verify` report (`feature-flow` § 6), one line per Done-when line, with what it observed. A change with no driven surface cites its tests instead. For L, one block per slice. `spec-compliance-auditor` checks it at Review, and the PR body copies it.

During review, add each round's table before the next round starts. A later round treats an item as decided only if it is recorded here (`review-and-ship` § 1 defines a decided item and the closures).

Give each finding one line with its closure:
- the fixing commits (RED and GREEN shas);
- the refutation, its evidence, and the raising reviewer's confirming re-run;
- **carried to slice *k***, only as `review-and-ship` § 1 allows.

Record findings carried *into* this slice too, each with how it closed here.

A mechanism added at a reviewer's request gets its rows in § Test plan before its GREEN commit.

If review fixes, or a merge from `main` that resolves a conflict, touched the path Verify drove, add the new `/verify` report, naming the commit it ran on (`feature-flow` §§ 6–7).

## Rollout

Feature flag (default OFF, added only when ready to deploy); what goes live unflagged on merge; deploy and migration order; how to roll back.

## Risks

What could go wrong, and how we would notice (a test, a gauge, a log line).
