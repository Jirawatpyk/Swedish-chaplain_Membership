# Workflow

How a change goes from an idea to production on Chamber-OS, and how the process improves itself. This file is the contract. The `feature-flow` skill (`.claude/skills/feature-flow/`) is the procedure Claude follows to meet it. Reviewer choice and the merge mechanics live in the `review-and-ship` skill.

**Status: pilot.** This flow replaces the ten `/speckit.*` gate commands for features that opt in. It keeps the following from the constitution:
- the Constitution Check;
- TDD, with the test going red first;
- ≥2 reviewers plus the security sign-off on sensitive surfaces;
- the cross-tenant integration test;
- `plan.md` § Complexity Tracking for any deviation.

The constitution's § Development Workflow still names the Spec Kit gates. It will be amended in a separate PR, with a Sync Impact Report, once the pilot has run on a real feature (D-009 in `decisions.md`).

## Sizes

| Size | Looks like | Extra steps |
|---|---|---|
| **S** | One surface, the diff fits in one sentence (a bug fix, a copy change, a guard) | No spec file; the PR states the Done-when lines |
| **M** | A few files across one module, or one new screen | `specs/<nnn-name>/spec.md` with Done-when lines; agree the plan in plan mode before coding |
| **L** | Several modules, a migration, money / tax / tenancy / PII / auth, or more than a day of work | M, plus the `spec-review-panel` Workflow on the spec, and one PR per user story where possible |

When unsure, size up. Anything touching money, tax, tenant isolation, PII, auth or a migration is never **S**.

## Lifecycle

| Step | What happens | Tool |
|---|---|---|
| **1. Frame** | Say what changes for whom and why. For M / L, Claude interviews the user with `AskUserQuestion` (edge cases, trade-offs, what is out of scope) and writes `specs/<nnn-name>/spec.md`: user stories, **Done when** lines (each one observable and checkable), Out of scope, open questions. Check the premises against the code before writing them down. | `feature-flow` |
| **2. Branch** | `<nnn>-<short-name>` from an up-to-date `origin/main`, in a worktree under a short Temp path (`node_modules` as a junction to the main checkout). Migrations take the next free number; merge any other open branch's migration first. | `git worktree` |
| **3. Plan** | Read the spec, `docs/decisions.md` and the module rules. M / L: write the plan in plan mode and agree it before coding. It covers the files, the data model, the Constitution Check against all 10 principles, and the test that goes red first for each Done-when line. A deviation goes in `plan.md` § Complexity Tracking with the rejected simpler alternative. | plan mode |
| **4. Build** | Small commits, test first: commit RED, then GREEN. Schema changes are hand-written SQL applied to the `dev` branch (`pnpm db:migrate`), confirmed via `information_schema`, then the touched integration suites run. Stop and ask on any conflict between sources (see Decisions). | TDD |
| **5. Check** | `pnpm check` green locally (lint, typecheck, the static gates). Then `pnpm test:coverage` (the pins CI enforces), `pnpm vitest run tests/contract/`, and the touched integration suites by path. | `pnpm check` |
| **6. Review** | `/code-review high` on the diff, or the `review-branch` Workflow for a large or high-stakes branch, then the surface reviewers from `review-and-ship` § 2. **Fix every High, with no waivers. Fix every Medium, or give the reason in the PR.** After substantial fixes to a reviewer's findings, run that reviewer again on the fixes. `whole-branch-reviewer` goes last. | `review-and-ship` |
| **7. Verify** | Run the app and watch the change work. Use a worktree dev server on **:3400**, started with `rm -rf .next` (never the user's :3100). Drive every changed screen, route or cron in the browser, including one wrong-input probe. Run the touched e2e specs on **chromium and mobile-chrome** (`--workers=1 --retries=0`). For UI, also check 320 px, a 32 px default font, dark mode and TH/SV. Collect evidence (numbers, screenshots) for every Done-when line. | `/verify`, Browser pane, Playwright |
| **8. PR** | The PR template: Done-when lines, each with its evidence; the DoD checklist; review findings and how each was closed. The Vercel preview and its Neon branch come with the PR. All six required checks must be green. | GitHub |
| **9. Merge** | **Only when the user says so.** Squash and delete the branch (`review-and-ship` § 5). The merge deploys to production, and prod migrates inside that deploy. Then confirm the production deployment is `READY`, and update `docs/operational-state.md` if a flag or cutover moved. | `gh`, Vercel |
| **10. Improve** | The retro (below): what went wrong or slow, and the change that stops it happening again. Add one line to `docs/retro.md`. Skip it when nothing went wrong. | `docs/retro.md` |

## Definition of Done

A change is done when every line below that applies is true and its evidence is in the PR.

- [ ] Every Done-when line in the spec (or the PR, for size S) is met, with evidence: test names, numbers, screenshots.
- [ ] Each behaviour has a test that went red before the code that made it pass.
- [ ] `pnpm check` is green; `pnpm test:coverage` is green (not just `pnpm test`); `pnpm vitest run tests/contract/` is green.
- [ ] The touched integration suites are green, run by path against the `dev` branch. A tenant-scoped surface has a cross-tenant test.
- [ ] A migration is applied on `dev`, its DDL is confirmed in `information_schema`, and it is registered in `_journal.json` with a unique `when`.
- [ ] The touched e2e specs are green on chromium and mobile-chrome.
- [ ] Review is complete: every High fixed, every Medium fixed or reasoned, a reviewer re-run after substantial fixes, and `whole-branch-reviewer` done.
- [ ] UI changes have had an `enterprise-ux-designer` pass. EN / TH / SV keys exist and are reviewed. 320 px reflow and a 32 px font have been checked.
- [ ] Sensitive surfaces (auth, RBAC, payment, PII, audit log, GDPR) have two reviewers, and the security checklist is signed.
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
