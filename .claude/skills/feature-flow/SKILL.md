---
name: feature-flow
description: Drive a Chamber-OS change from idea to production through docs/workflow.md — size it, interview and write the spec, plan, build test-first, check, review, verify in the running app, open the PR, merge on the user's word, and run the retro. Use when the user starts a feature, a fix bigger than one sentence, or asks what the next step of a change is.
---

# Feature flow

`docs/workflow.md` is the contract: the lifecycle, the Definition of Done, Decisions and Continuous improvement. This skill is how Claude walks it. Read that file first if this session hasn't. Reviewer choice and merge mechanics are in the `review-and-ship` skill.

## 0. Before anything

- Read `docs/decisions.md`. If the request contradicts a decision, or two sources disagree, stop and ask (`CLAUDE.md` § Precedence). Never pick one silently.
- **Size it** (S / M / L, per `docs/workflow.md` § Sizes) and say the size and why in one line. When unsure, size up. Money, tax, tenancy, PII, auth and migrations are never S.
- Say which flow the change uses: this one, or the Spec Kit gates (D-009, pilot).

## 1. Frame

- **S**: state the Done-when lines in the reply; they go into the PR.
- **M / L**: interview the user with `AskUserQuestion`. Cover the hard parts: edge cases, failure and refusal paths, roles, tenants, locales, money and tax effects, and what is out of scope. Skip questions the code already answers. Then write `specs/<nnn-name>/spec.md`:
  - user stories, each with **Done when** lines that are observable and checkable ("the refund row shows `succeeded` and the credit note number"), never vague ("works well");
  - **Out of scope**, and **Open questions** (which block the plan until answered);
  - the **premises checked against the code**: what already exists that would make this pointless or contradictory?
- **L**, or anything touching money / tax / tenancy / PII / auth / migrations: suggest the `spec-review-panel` Workflow. It runs only if the user opts in.

## 2. Branch

A worktree from an up-to-date `origin/main` at a short path (e.g. `%TEMP%\fNN`), with `node_modules` as a junction to the main checkout. The branch is `<nnn>-<short-name>`. Never work on the user's main checkout, and never `git stash`.

## 3. Plan (M / L)

Enter plan mode. The plan names:
- the files to touch, and the module rules that apply;
- the data model and migration;
- the Constitution Check across all 10 principles;
- for every Done-when line, **the test that goes red first**: one test per behaviour, never one task per file.

A deviation goes in `plan.md` § Complexity Tracking with the rejected simpler alternative. Get the user's agreement before writing code.

## 4. Build

- RED commit, then GREEN commit, per behaviour. A guard whose test never went red has not been exercised.
- Schema: hand-written SQL, `pnpm db:migrate` (the dev branch), DDL confirmed via `information_schema`, then the touched integration suites run by path.
- Use the module's rule (`.claude/rules/modules/*.md`) for its traps. A tenant-scoped repo threads `tx` from `runInTenant`.
- Dispatch file-mutating subagents one at a time.

## 5. Check

`pnpm check` → `pnpm test:coverage` → `pnpm vitest run tests/contract/` → the touched integration suites by path. Report each command's result. A failure is reported with its output, never summarised as "mostly green".

## 6. Review

Follow `review-and-ship` §§ 1–2:
1. `/code-review high` on the diff, or the `review-branch` Workflow when it applies.
2. The surface reviewers for what the diff touches.
3. `whole-branch-reviewer` last.

Fix every High, with no waivers. Fix every Medium, or write the reason down for the PR. After substantial fixes to a reviewer's findings, run that reviewer again on the fixes.

## 7. Verify

Watch the change work in the running app, not only in tests. The `run-chamber-os` skill is the recipe for starting it: worktree, :3400, cold `.next`, personas, Playwright attached, and the UI probes.
- Start a dev server in the worktree on **:3400** after `rm -rf .next`. The user's :3100 is never started or killed.
- Use `/verify` or the Browser pane to drive every changed screen, route or cron, including one wrong-input probe.
- Run the touched e2e specs on chromium and mobile-chrome with `--workers=1 --retries=0`. A red that also fails on `main` is reported as pre-existing, with the evidence.
- UI also gets: 320 px, a 32 px default font, dark mode, and TH and SV.
- Evidence (numbers, screenshots) goes against each Done-when line.

## 8. PR

Fill in `.github/pull_request_template.md`:
- the Done-when lines with their evidence;
- the Definition of Done checklist, ticked only where the evidence exists;
- every review finding and how it was closed;
- the unflagged behaviours, if a flag is involved.

Open with `gh pr create`, then bind the PR to the session.

## 9. Merge

Only on the user's explicit word (D-006), by `review-and-ship` § 5. After the merge:
- confirm the production deployment is `READY`;
- update `docs/operational-state.md` if a flag or cutover moved;
- add the `docs/changelog.md` line if the PR didn't.

## 10. Improve

When any retro trigger in `docs/workflow.md` § Continuous improvement fired during this change, ask the three questions. Then:
- add one line to `docs/retro.md`;
- make the change that stops it recurring, in this PR or a named follow-up issue;
- prefer a mechanical guard (test, gate, hook) over advice.

A new decision made along the way goes into `docs/decisions.md`. If nothing went wrong, skip the retro and say so.
