# Workflow

How a change goes from an idea to production on Chamber-OS, and how the process improves itself. This file is the contract. The `feature-flow` skill (`.claude/skills/feature-flow/`) is the procedure Claude follows to meet it. Reviewer choice and the merge mechanics live in the `review-and-ship` skill.

**Review rules have one owner:** `.claude/skills/review-and-ship/SKILL.md` § 1 (D-043). This file states the outcome and links there; it does not restate the mechanics.

**Status: adopted.** This file owns the development process; the constitution (v2.1.0) keeps only the principles and no longer prescribes gates or reviewer counts (D-018). The Spec Kit commands remain usable for a step. What the process keeps, by choice:
- the Constitution Check;
- TDD, with the test going red first;
- independent review, and on sensitive surfaces ≥2 reviewers — for a solo maintainer, the solo-maintainer review in `review-and-ship` § 2 — with the security sign-off given by the `security-engineer` report in the staff review;
- the cross-tenant integration test;
- `plan.md` § Complexity Tracking for any deviation.

## Sizes

| Size | Looks like | Extra steps |
|---|---|---|
| **S** | One surface, the diff fits in one sentence (a bug fix, a copy change, a guard) | No spec file; the PR states the Done-when lines |
| **M** | A few files across one module, or one new screen | `specs/<nnn-name>/spec.md` with Done-when lines; agree the plan in plan mode before coding |
| **L** | Several modules, a migration, money / tax / tenancy / PII / auth, or more than a day of work | M, plus the `spec-review-panel` Workflow suggested on the spec (it runs on the user's opt-in), the plan cut into **slices**, and one PR per slice where possible |

When unsure, size up. Anything touching money, tax, tenant isolation, PII, auth or a migration is never **S**.

## Lifecycle

| Step | What happens | Tool |
|---|---|---|
| **1. Frame** | Say what changes for whom and why. For M / L, Claude interviews the user with `AskUserQuestion` (edge cases, trade-offs, what is out of scope) and writes `specs/<nnn-name>/spec.md`: user stories, **Done when** lines (each one observable and checkable), Out of scope, open questions. Check the premises against the code before writing them down, including a measured **usage line** (count · source · date) for every existing path the change keeps compatible — a path with no usage is a candidate for removal, not protection — and a MEASURED or doc-cited label on every provider fact the design relies on (for S, both go in the PR body). | `feature-flow` |
| **2. Branch** | `<nnn>-<short-name>` (for an L slice, `<nnn>-<short-name>-s<k>`) from an up-to-date `origin/main`, in a worktree under a short Temp path (`node_modules` per `run-chamber-os` § 1). Migrations take the next free number; merge any other open branch's migration first. | `git worktree` |
| **3. Plan** | Read the spec, `docs/decisions.md` and the module rules. M / L: Claude asks to enter plan mode (the user approves; the user can also switch to Plan mode themselves), drafts the plan, and presents it for approval on exit; then saves it as `specs/<nnn-name>/plan.md` from `.claude/skills/feature-flow/plan-template.md`. It covers the approach, files, data model, **test plan** (each Done-when line → the test that goes red first), Constitution Check, Complexity Tracking, rollout and risks. For L, `chamber-os-architect` and the surface reviewers read the plan before the user agrees it. No code is written before the user agrees. If the plan changes during build, update `plan.md` in the same commit. | plan mode, `superpowers:writing-plans` |
| **4. Build** | Small commits, test first: commit RED, then GREEN, following the plan's test plan. For UI presentation (React components, styles and markup; never `route.ts` handlers or server actions), copy, and size-S changes that are not guards, test and code may share a commit if the failing run is recorded with its output (the test name and its failure line) (D-023). A migration goes through the `new-migration` skill, and a new audit event type through `add-audit-event`. Debug with `superpowers:systematic-debugging`. Stop and ask on any conflict between sources (see Decisions). A mechanism a reviewer asks for is a plan change: its state-table and test-plan rows go into `plan.md` before its GREEN commit, unless it is carried (`feature-flow` § 4, `review-and-ship` § 1). Finish with `/simplify` on the diff (reuse, simplification, efficiency) before Check. | `superpowers:test-driven-development`, `new-migration`, `add-audit-event`, `/simplify` |
| **5. Check** | `pnpm check` green locally (lint, typecheck, the static gates). Then `pnpm test:coverage` (the pins CI enforces), `pnpm vitest run tests/contract/`, and the touched integration suites by path. When a subagent built the change, the main session runs these one at a time after the subagent hands back, with nothing editing the worktree. The subagent runs only its scoped tests and `pnpm check`. | `pnpm check` |
| **6. Verify** | `/verify`, run by the maintainer, watches the change work through its real surface (D-044). Claude cannot invoke `/verify`, and it never drives the change by hand in its place. It stops and hands over the exact command, ready to paste (`feature-flow` § 6). `/verify` drives every changed screen, route or cron on the branch's :3400 server (`run-chamber-os`), with one wrong-input probe. For UI it also checks 320 px, a 32 px default font, dark mode and TH/SV. Claude runs the touched e2e specs on **chromium and mobile-chrome** (`--workers=1 --retries=0`). The `/verify` report is the evidence for every Done-when line. A change that a user or operator does not drive gets no `/verify`, and the PR says so. | `/verify` (the maintainer), `run-chamber-os`, Playwright |
| **7. Review** | Review the change as built and verified, so every fix is reviewed, in subagents only. The contract: **no High and no Medium finding remains** (D-015); Lows are fixed or listed in the PR; for M / L, `spec-compliance-auditor` checks every Done-when line against the code and the Verify evidence; `whole-branch-reviewer` goes last only when the review was split (D-022). Everything else — which review for the diff, the surface reviewers, how a finding closes, the rounds and their cap, docs-only changes, the metrics line — is owned by `review-and-ship` §§ 1–2 (D-043). If review fixes touch the path Verify drove, Verify runs again (`feature-flow` § 7). | `review-and-ship` |
| **8. PR** | The PR template: Done-when lines, each with its evidence; the DoD checklist; review findings and how each was closed. The Vercel preview and its Neon branch come with the PR. All six required checks must be green. | GitHub |
| **9. Merge** | **Only when the user says so.** Squash and delete the branch (`review-and-ship` § 5). The merge deploys to production, and prod migrates inside that deploy. Then confirm the production deployment is `READY`, and update `docs/operational-state.md` if a flag or cutover moved. | `gh`, Vercel |
| **10. Improve** | The retro (below): what went wrong or slow, and the change that stops it happening again. Add one line to `docs/retro.md`. Skip it when nothing went wrong. | `docs/retro.md` |

## Who does what

The main session holds the conversation, the agreements and the plan; subagents get a fresh context. A reviewer never grades its own code: Claude Code's best practices note that a fresh context improves code review.

| Step | Who | Why |
|---|---|---|
| Frame, Plan | **Main session**; an `Explore` subagent may survey the code first | Needs the user and the agreements |
| Build, size S / M | **Main session** | A tight TDD loop that needs the conversation's context |
| Build, size L | **One subagent per slice, in order** (`superpowers:subagent-driven-development`, or `software-engineer`), with the main session checking each slice against the plan | A long build would fill and compact the main context, and a failure is easier to trace to one slice |
| Review | **Subagents, always** (`/code-review high <pr#>`, the surface reviewers and, for M / L, `spec-compliance-auditor`) | The writer is never the reviewer, and never the one who confirms its own evidence |
| Verify | **The maintainer**, who runs the `/verify` command Claude hands over. Claude prepares the branch and runs the e2e specs. | The check runs through the real surface, and Claude does not grade its own change by hand (D-044) |
| Fixes after review, PR, merge | **Main session** | Judgment, and the user's word for the merge |

- Subagents that edit files run one at a time, because they share the working tree.
- Read-only subagents may run in parallel.
- Use Opus for review and risky work, and Sonnet for bounded mechanical tasks.

## Slices (size L)

A **slice** is a vertical cut through one user story: the thinnest DB → use case → API → UI path that works, can be tested and can be demoed on its own. "An admin issues a full credit note" is a slice; "all the schema" is not. The plan lists the slices in build order. A story too big for one slice is split, and every slice names its Done-when lines.

- **Build one slice at a time.** It goes red, then green, and `pnpm check` passes before the next slice starts. Never build an L change in one pass.
- **No plan mode per slice.** The slices were planned once in `plan.md`. Only a slice that has to leave the plan (a new migration, a changed design) goes back into plan mode, updates `plan.md` and is approved again.
- **Review in two layers:**
  - **Every slice:** `/code-review high <pr#>` on that slice's PR (a target is required: with none, a pushed branch reviews nothing), plus the surface reviewers for what the slice touches (e.g. `drizzle-migration-reviewer` for a slice with a migration), plus `spec-compliance-auditor` on that slice's Done-when lines against their entries in `plan.md` § Evidence. Findings close before the next slice builds on them, as `review-and-ship` § 1 says; a carried finding is closed by the slice that inherits it.
  - **Evidence accumulates** in the one `plan.md` § Evidence, a block per slice, so the auditor of slice *k* sees exactly what slice *k* claims.
  - **Slices sharing one long-lived branch:** `whole-branch-reviewer` on the whole branch against `origin/main` at the end, for the seams between slices. One PR per slice needs no extra pass: `/code-review high <pr#>` already reads the PR's whole diff (D-022).
- **One PR per slice where possible.** Each PR must be safe to deploy on its own; use a default-OFF flag when it isn't user-ready yet. Slices share one long-lived branch only when a slice cannot deploy safely on its own even behind a flag (an expand/contract migration usually removes the need); record why in `plan.md` § Complexity Tracking. That shared branch is the plain `<nnn>-<short-name>`.
- **Name and track every slice.** Slice *k* builds on its own branch, `<nnn>-<short-name>-s<k>`, cut from `origin/main` after slice *k − 1* has merged. Before its PR merges, the slice's own row in the `plan.md` Slices table gets the PR number and `done`, so the table on `main` always shows which slices have shipped.
- **"Start slice N" names its feature.** When the user does not name it, read the Slices tables under `specs/*/plan.md`: if exactly one feature has slices not yet `done`, continue it; if several do, ask which.

## Definition of Done

A change is done when every line below that applies is true and its evidence is in the PR.

- [ ] Every Done-when line in the spec (or the PR, for size S) is met, with evidence: test names, numbers, screenshots. For M / L, `spec-compliance-auditor` confirmed each line against its evidence.
- [ ] M / L: `plan.md` exists, the user agreed it before build, and it matches what was built.
- [ ] L slice: this PR sets its own row in the `plan.md` Slices table to its PR number and `done` (D-020).
- [ ] Each behaviour has a test that went red before the code that made it pass: a RED commit, or for UI presentation (React components, styles and markup; never `route.ts` handlers or server actions), copy, and size-S changes that are not guards, the recorded failing run (D-023).
- [ ] `pnpm check` is green; `pnpm test:coverage` is green (not just `pnpm test`); `pnpm vitest run tests/contract/` is green.
- [ ] The touched integration suites are green, run by path against the `dev` branch. A tenant-scoped surface has a cross-tenant test.
- [ ] A migration is applied on `dev`, its DDL is confirmed in `information_schema`, and it is registered in `_journal.json` with a unique `when`.
- [ ] The touched e2e specs are green on chromium and mobile-chrome.
- [ ] Verify: the maintainer ran `/verify` on the final head, and its report is in `plan.md` § Evidence (or the PR). If the change has no surface a user or operator drives, the PR says so instead (D-044).
- [ ] Review is complete as `review-and-ship` § 1 defines it: no High or Medium left, findings carried into this slice closed, Lows fixed or listed, the review metrics recorded, Verify re-run if review fixes touched the path it drove, and `whole-branch-reviewer` done when the review was split (the `review-branch` Workflow, a per-module review, or slices sharing one long-lived branch).
- [ ] UI changes have had an `enterprise-ux-designer` pass. EN / TH / SV keys exist and are reviewed. 320 px reflow and a 32 px font have been checked.
- [ ] Sensitive surfaces (auth, RBAC, payment, PII, audit log, GDPR) have ≥2 reviewers — for a solo maintainer, the solo-maintainer review in `review-and-ship` § 2 — and the security checklist is signed.
- [ ] Docs are updated: a `docs/changelog.md` line; `docs/operational-state.md` if a flag moved; the module's `.claude/rules/modules/*.md` if the module gained a trap or a dependency; `docs/decisions.md` if a decision was made.
- [ ] A new feature flag is OFF and added only when the user is ready to deploy. Every unflagged behaviour is listed in the PR.
- [ ] No `test.fixme` or bare `test.skip` was added, and no secret, PII workbook or `.env*` file is in the diff.

## Decisions

`docs/decisions.md` records every decision that shapes how the code is written: numbered (D-001…), dated, with its context, the decision and its consequence. When sources disagree, the precedence in the root `CLAUDE.md` § Precedence settles it. A newer decision supersedes an older one by number; the older one stays in the file, marked superseded.

Record a decision when the user settles a question, when a review or an incident changes how something must be done, or when a plan picks between real alternatives. If a source contradicts a decision, stop and ask; don't pick one silently.

## Continuous improvement

The workflow, the rules and the tooling improve every time something goes wrong, not on a schedule.

**When to run a retro**:
- `main` went red;
- a reviewer found a new High after a fix round;
- a gate or a probe turned out to check nothing;
- the user corrected the same thing twice;
- a step took far longer than it should have;
- a fact in a doc turned out stale.

**Ask three questions**:
1. What went wrong or slow?
2. Why: an unclear rule, a missing guard, or a stale document?
3. What change stops it recurring?

**Output**: one line in `docs/retro.md`, **and** the change itself, in the same PR or in a named follow-up issue. The change can be a rule line, a test, a gate, a hook or a doc fix. Prefer a mechanical guard (test, gate, hook) over a sentence of advice. Claude's session memory is a local cache; the durable lesson lives in the repo.
