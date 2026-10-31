---
name: feature-flow
description: Drive a Chamber-OS change from idea to production through docs/workflow.md — size it, interview and write the spec, plan, build test-first, check, review, verify in the running app, open the PR, merge on the user's word, and run the retro. Use when the user starts a feature or a fix of any size (S included — its Done-when lines go in the PR), or asks what the next step of a change is.
---

# Feature flow

`docs/workflow.md` is the contract: the lifecycle, who does what, the Definition of Done, Decisions and Continuous improvement. This skill is how Claude walks it. Read that file first if this session hasn't. Reviewer choice and merge mechanics are in the `review-and-ship` skill.

## 0. Before anything

- Read `docs/decisions.md`. If the request contradicts a decision, or two sources disagree, stop and ask (`CLAUDE.md` § Precedence). Never pick one silently.
- **Size it** (S / M / L, per `docs/workflow.md` § Sizes) and say the size and why in one line. When unsure, size up. Money, tax, tenancy, PII, auth and migrations are never S.
- A sensitive surface (auth, RBAC, payment, PII, audit log, GDPR) uses the solo-maintainer review: record its five checks in `plan.md` § Complexity Tracking (`review-and-ship` § 2).
- **Measure before you protect.** Before designing compatibility or safety for an existing path (a dispatch leg, an API, a flag-off branch, a migration of old rows), measure its real usage: a prod row count (the maintainer runs it, or a read-only query they order), or a log or metric count. Record the number, its source and the date in the spec's Premises. A path with no usage is a candidate for removal, not for protection (retro 2026-10-30, #701, D-041: two specs and nine review rounds kept a dispatch leg "LIVE" while prod held 0 rows of it).

## 1. Frame

- **S**: state the Done-when lines in the reply; they go into the PR, with the § 0 usage line when the change keeps an existing path compatible, and a MEASURED or doc-cited label on every provider fact it relies on.
- **M / L**: interview the user with `AskUserQuestion`. Cover the hard parts: edge cases, failure and refusal paths, roles, tenants, locales, money and tax effects, and what is out of scope. Skip questions the code already answers. Then write `specs/<nnn-name>/spec.md`:
  - user stories, each with **Done when** lines that are observable and checkable ("the refund row shows `succeeded` and the credit note number"), never vague ("works well");
  - **Out of scope**, and **Open questions** (which block the plan until answered);
  - the **premises checked against the code**: what already exists that would make this pointless or contradictory? It includes a **usage line** (count · source · date) for every existing path the change keeps compatible (§ 0), and every provider fact the design relies on, marked MEASURED (date) or cited from the provider's docs;
- **L**, or anything touching money / tax / tenancy / PII / auth / migrations: suggest the `spec-review-panel` Workflow. It runs only if the user opts in.

## 2. Branch

A worktree from an up-to-date `origin/main` at a short path (e.g. `%TEMP%\fNN`), with `node_modules` provided as `run-chamber-os` § 1 says (a junction only when the AURA versions match). The branch is `<nnn>-<short-name>`; for an L slice it is `<nnn>-<short-name>-s<k>`, cut from `origin/main` after the previous slice merged. Never work on the user's main checkout, and never `git stash`.

## 3. Plan (M / L)

Ask to enter plan mode (the EnterPlanMode tool; the user approves — or the user switches to Plan mode themselves). Draft in plan mode (`superpowers:writing-plans` helps). **Before presenting it, check that the spec's Premises carry the usage line for every path the plan keeps compatible (§ 0) and that every provider fact is labelled; a plan resting on premises without them is not ready to present** — this is where the guard bites, before any build cost (D-041). Present the plan for approval when leaving plan mode, then save it as `specs/<nnn-name>/plan.md` from `plan-template.md` in this skill's folder. It covers:
- the approach and the alternatives not taken;
- the files to touch and the module rules that apply;
- the data model and migration;
- for L, the **slices** in build order, each a thin vertical path with its own Done-when lines;
- the **test plan** — for every Done-when line, the test that goes red first: one row per behaviour, never one per file;
- the Constitution Check across all 10 principles, and Complexity Tracking for any deviation;
- rollout and risks.

For **L**, have `chamber-os-architect` and the surface reviewers for what the plan touches read it before the user does. These are read-only subagents and may run in parallel. Get the user's agreement before writing code. If the plan changes during build, update `plan.md` in the same commit.

## 4. Build

- **Who**: the main session builds S and M. For L, build **one slice at a time** (`docs/workflow.md` § Slices) with one subagent per slice, in order (`superpowers:subagent-driven-development`, or `software-engineer`). Check each slice against the plan, and run its per-slice review, before starting the next. When the user says "start slice N" without naming the feature, find it from the Slices tables in `specs/*/plan.md` (one feature with open slices: continue it; several: ask). Before a slice starts, read `spec.md`, the slice's row and Done-when lines in `plan.md`, and the merged diff of the previous slice (`gh pr diff <PR>`), and hand all three to its subagent. Subagents that edit files run one at a time.
- RED commit, then GREEN commit, per row of the test plan (`superpowers:test-driven-development`). A guard whose test never went red has not been exercised. Exception (D-023): for UI presentation (React components, styles and markup; never `route.ts` handlers or server actions), copy, and size-S changes that are not guards, test and code may share a commit, but run the test against the old code first and record that failing run in `plan.md` § Evidence (or the PR for size S). The exception is never money, tax, auth/RBAC, tenancy, PII, audit log, a migration, a guard or validation, or domain/application logic.
- For a migration, use the `new-migration` skill. For a new audit event type, use `add-audit-event`. For a bug, use `superpowers:systematic-debugging` before changing code.
- Use the module's rule (`.claude/rules/modules/*.md`) for its traps. A tenant-scoped repo threads `tx` from `runInTenant`.
- **A mechanism a reviewer asks for is a plan change** (D-043), whether the request comes during build or review. This covers a column, a counter, a deadline, a label or a query.
  - It may instead be carried to a later slice, only as `review-and-ship` § 1 allows.
  - Anything built here gets its state-table cells and test-plan rows added to `plan.md` before its GREEN commit, in the RED commit or earlier.
  - `spec-compliance-auditor` checks every test-plan row, so a mechanism with no row is a finding.
- **A slice inherits its carries.** Give the slice's subagent every finding an earlier slice carried into it (recorded in `plan.md` § Evidence). Each one closes in this slice (`review-and-ship` § 1).
- **A slice subagent runs only the scoped tests and `pnpm check`.** That means its own RED and GREEN runs and its mutation proofs. It does not run the full gates of § 5.
- When the build is complete, run `/simplify` on the diff (reuse, simplification, efficiency), then go to Check. For L, don't re-enter plan mode per slice; only a slice that has to leave the plan goes back to plan mode, updates `plan.md` and is approved again.

## 5. Check

`pnpm check` → `pnpm test:coverage` → `pnpm vitest run tests/contract/` → the touched integration suites by path. Report each command's result. A failure is reported with its output, never summarised as "mostly green".

**The main session runs these gates**, after the slice subagent has handed back and while nothing is editing the worktree.
- Run them one at a time. A subagent's gate run counts as a heavy job (`run-chamber-os` § Rules).
- A gate that runs while files change under it proves nothing, so run it again.
- If a run is killed for low memory, report that and ask before you start it again.

## 6. Verify

Meet `docs/workflow.md` step 6 (the contract: what to drive, which e2e projects, the UI probes, evidence per Done-when line) with the `run-chamber-os` skill as the recipe: worktree, :3400 after `rm -rf .next`, personas, Playwright attached.
- Drive the change with `/run` or the Browser pane. `/verify` runs only when the user invokes it.
- **Hand the user a ready `/verify` command** when the change touches money, tax, PII, auth/RBAC, tenancy or a path live in production. Claude cannot invoke it, so put the exact command in the Verify report and in the PR, ready to paste: the PR number, the worktree, the Done-when IDs, the persona, and any safety limit (for Resend, the sink address `delivered@resend.dev` only). The maintainer runs it before merge.
- A red that also fails on `main` is reported as pre-existing, with the evidence.
- Write the evidence against each Done-when line now. For M / L, append it to `plan.md` under `## Evidence`, one line per Done-when line; Review checks it there and the PR body copies it.

## 7. Review

Review the change as built **and verified**, so a fix found in Verify is reviewed too. In this order:
1. `/code-review high` on the whole diff: Claude runs it itself through the Skill tool with a target, `skill: "code-review", args: "high <pr#>"` (or `"high origin/main...HEAD"` before the PR exists); with no target a pushed branch reviews nothing. Or the `review-branch` Workflow when it applies.
2. The surface reviewers for what the diff touches.
3. For M / L, `spec-compliance-auditor` with `spec.md` and the Verify evidence in `plan.md` § Evidence (for an L slice, that slice's block): each Done-when line is checked against the code and against the evidence that claims it.
4. `whole-branch-reviewer` last, only when the review was split (the `review-branch` Workflow, a per-module review, or slices sharing one long-lived branch); otherwise `/code-review high` with its target has already read the whole diff (D-022).

Reviews run in subagents; the writer never reviews its own code. **No High and no Medium finding may remain.** How a finding closes, the rounds and their cap, the staff review on sensitive surfaces and docs-only changes are defined in `review-and-ship` §§ 1–2 (the one owner, D-043); follow them from there.

When review fixes touch the path Verify drove, run Verify again after the last fix that changes code, before merge. Any commit after that re-run may change only docs or evidence. Add a re-run block to `plan.md` § Evidence naming the commit it ran on, then run `spec-compliance-auditor` again on that block.

## 8. PR

Fill in `.github/pull_request_template.md`:
- for S, before `gh pr create`: the § 0 usage line and the provider-fact labels are in the body, or the PR is not opened (no auditor runs on S, so this is its only check);
- the Done-when lines with their evidence;
- the Definition of Done checklist, ticked only where the evidence exists;
- every review finding and how it was closed;
- the unflagged behaviours, if a flag is involved;
- for an L slice, right after `gh pr create`, commit this slice's row in the `plan.md` Slices table with the new PR number and `done`, before review round 1 (so the commit rides the first CI run).

The diff itself carries the `docs/changelog.md` line (Definition of Done).

Open with `gh pr create`, then bind the PR to the session.

## 9. Merge

Only on the user's explicit word (D-006), by `review-and-ship` § 5. For an L slice, its row in the `plan.md` Slices table already carries the PR number and `done` (set in the slice's own PR before merging). After the merge:
- confirm the production deployment is `READY`;
- update `docs/operational-state.md` if a flag or cutover moved.

## 10. Improve

When any retro trigger in `docs/workflow.md` § Continuous improvement fired during this change, ask the three questions. Then:
- add one line to `docs/retro.md`;
- make the change that stops it recurring, in this PR or a named follow-up issue;
- prefer a mechanical guard (test, gate, hook) over advice.

A new decision made along the way goes into `docs/decisions.md`. If nothing went wrong, skip the retro and say so.
