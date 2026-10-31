---
name: review-and-ship
description: How to review a change and get it merged on Chamber-OS — which project subagent reviews which surface, when to use the built-in /code-review or a saved Workflow, the Spec Kit gates, PR reviewer counts, main's required checks, and the merge flow. Use before opening a PR, when reviewing a diff or branch, at a /speckit review or ship gate, and before merging.
---

# Review and ship

## 1. Pick the review by diff size

This section is the single source for how review works; `docs/workflow.md` step 7 and `feature-flow` § 7 point here.

| Diff | Review |
|---|---|
| A small diff (one surface, roughly < 40 files / 5k lines) | The built-in **`/code-review high`** (or `/code-review high <pr#>` for a PR). Claude runs it itself through the Skill tool and **always names the target**: `skill: "code-review", args: "high <pr#>"`, or `args: "high origin/main...HEAD"` before the PR exists. Prefer `<pr#>` whenever a PR exists: it diffs against the PR's own base, which is right for a stacked branch too. With no target it diffs against the branch's upstream, which is empty once the branch is pushed, so it would review nothing. It reviews the diff for correctness bugs and returns the findings here. Always pass `high`: with no level the command reuses the last level typed, and `xhigh` / `max` are not the default here. Then dispatch the surface reviewers from § 2 for the surfaces the diff touches. |
| A large diff, or any money / tax / tenancy / PII / auth / migration branch | The **`review-branch`** Workflow (`.claude/workflows/`). An inline `/code-review` scopes itself down on a big diff: on the F5 refund branch (123 files) it produced 6 findings, 5 of them misreads, while the fan-out found 3 real bugs it never reached. |
| A size M / L change, always | **`spec-compliance-auditor`**, given `spec.md` and the Verify evidence in `plan.md` § Evidence. It checks each Done-when line against the code and against the evidence that claims it. A line with no evidence, or evidence that does not prove it, is a **High** finding. |
| The review was split: the `review-branch` Workflow, a per-module review, or slices sharing one long-lived branch | **`whole-branch-reviewer`** last: the seams between the parts that no single reviewer read together. A normal PR skips it, because `/code-review high` with the PR as its target already reads the whole diff against `origin/main` (D-022). |
| A defect class found once that must be closed everywhere | The **`sweep-class`** Workflow, with the known instances as `examples`. |
| A spec touching money, tax, tenancy, PII, auth or a migration | The **`spec-review-panel`** Workflow, after clarify and before plan. |

- **`/code-review ultra`** (or `/code-review ultra <PR#>`) is a multi-agent **cloud** review of the branch. The user triggers it and it is billed, so Claude never launches it; suggest it for a large, high-stakes branch.
- A Workflow runs only on explicit opt-in ("use a workflow" / `ultracode`), never on Claude's own initiative. Otherwise, describe what it would do and roughly what it costs, and ask. If the user declines, review per module: `/code-review high <path>` for each touched module, the § 2 surface reviewers, then `whole-branch-reviewer`.
- No High or Medium finding may remain at merge (D-015). A finding is never waived. It closes in one of three ways:
  - it is fixed;
  - it is refuted with evidence, and the reviewer confirms that on a re-run;
  - for an L slice only, a **Medium** is **carried to the slice that owns it** (D-043). A High is never carried, because every merge deploys and a carried High would ship live.
- A carry needs all of these, and `spec-compliance-auditor` checks each one:
  - The concern is named for a later slice *k* of the same spec in the agreed plan: `plan.md` at this branch's base commit (`git show $(git merge-base origin/main HEAD):specs/<nnn-name>/plan.md`) if it exists there, otherwise `plan.md` at the commit that first added it (`git log --diff-filter=A --format=%H -- specs/<nnn-name>/plan.md | tail -1`). *k*'s row in § Slices must name the concern **in words**; an ID alone (such as `DT3`) does not count. A target cannot be added after the plan was agreed.
  - Slice *k*'s PR has not merged. Check with `gh`, not the Slices row: the row says `done` before the merge.
  - The carry is recorded in `plan.md` § Evidence with *k*'s number.
- A concern no later slice names is fixed or refuted in this slice. It is never carried to a slice invented for it.
- **The receiving slice closes what it inherits.** Slice *k*'s brief and its first review round's args list every finding carried into it. Each one closes there: fixed, or refuted and confirmed. It may be carried again only if a later slice already names it. Slice *k*'s auditor checks each one.
- Take findings with `superpowers:receiving-code-review`: verify each one against the code before acting on it.
- Low findings are fixed or listed in the PR.
- Any code change after review goes back through review.
- **Rounds:** a normal change gets one review round, then the raising reviewer re-checks each fix. Run another `/code-review` round only when the last one had a High or Medium that changed code; stop once the latest round finds only Lows. The command is told to surface at least 5 findings, so re-running it to chase Lows never converges. A sensitive surface (auth, RBAC, payment, PII, audit log, GDPR) gets ≥ 2 rounds plus the staff review (§ 2).
- **A docs-only change gets no `/code-review`** (D-043): one that touches only Markdown in `docs/`, `.claude/` or `specs/`, or the PR template. Claude checks it against the files it changes and runs `pnpm check`; the maintainer reads it. A change that also touches code, tests, scripts or config is reviewed as code.
- **A cap on rounds** (D-043):
  - size M: 3 `/code-review` rounds;
  - size L, or any sensitive surface: the ≥ 2 full rounds above plus at most 2 targeted rounds.
  At the cap, stop fixing. Bring the open findings to the maintainer, each with a recommended closure: fix, refute, or carry. The maintainer decides each one, and may re-grade a Medium to Low with the reason written in the PR. Record the round count and the decision in the PR's Review findings and in `plan.md` § Evidence.
- **From round 3 on, each round is targeted** (D-043).
  - Run it on the fix commits since the last round only: `/code-review high <first-fix-sha>^..HEAD`.
  - It confirms that each item from the last round is closed.
  - It reports only **new** High or Medium findings that those commits introduce.
  - Tell it not to pad to a minimum count. An empty list is a valid answer. Pass this sentence verbatim in the args: *"Review ONLY these fix commits. Confirm each item from the last round closed. Report ONLY new High or Medium findings these commits introduce, each with a concrete failure scenario; do NOT pad to a minimum count, an empty list is a valid answer. Do not re-raise decided items."*
  - A round that returns only closed items, decided items or Lows ends the review (the stop rule).
  - A **decided item** is a finding already closed by one of the three closures above and recorded in `plan.md` § Evidence (for size S, in the PR). A refutation counts only once the reviewer that raised the finding confirms it on a re-run.
  - If a targeted round finds a new Medium in a mechanism the plan puts in a later slice, carry the finding to that slice rather than build more here.
- Review runs after Verify, so the reviewed code is the code that works. When review fixes touch the path Verify drove, run Verify again after the last fix that changes code, before merge (`feature-flow` § 7).
- Tell every reviewer to report only gaps that affect correctness or the stated requirements. A reviewer asked to find gaps always finds some, and chasing every one over-engineers.

## 2. Which project subagent reviews which surface

Dispatch the project agents in `.claude/agents/`, not `general-purpose`. File-mutating agents run **sequentially**; read-only reviewers may run concurrently. Use `model: "opus"` for gate work and anything where a wrong answer is expensive, and `"sonnet"` for bounded mechanical tasks (aliases only, never a version string).

| The diff touches | Reviewer |
|---|---|
| Invoice / payment / refund / credit-note / renewal-billing numbers or states | `financial-integrity-reviewer` |
| Thai tax documents, VAT, §87 numbering, BE display | `thai-tax-compliance-auditor` |
| Stripe, checkout, anything near card data | `pci-saqa-guardian` |
| Auth, RBAC, API routes, server actions, `proxy.ts`, secrets | `security-engineer` (signs the security checklist) |
| A new feature's threat surface (spec / plan time) | `security-threat-modeler` |
| PII, retention, erasure, DSAR / GDPR export, a new processor | `pdpa-gdpr-compliance-officer` |
| A migration, schema, RLS policy, index or trigger | `drizzle-migration-reviewer` |
| Writes, transactions, audit events, error paths | `reliability-guardian` |
| **Any user-facing UI** (always, on top of the code review) | `enterprise-ux-designer` (pass `focus: visual` or `focus: smart-features` to deepen a lens); add `mobile-a11y-ux-reviewer` for responsive / a11y depth |
| `src/i18n/messages/*.json` or new user-facing text | `i18n-translation-reviewer` |
| Hot paths, SLO budgets | `performance-slo-guardian` |
| Logs, spans, metrics, alerts | `observability-instrumentor` |
| A financial figure shown to a human (KPIs, exports) | `financial-reporting-analyst` |
| Test quality, coverage gaps, edge-case hunt, ship-readiness verdict | `senior-tester` |
| Does the code satisfy every acceptance scenario or Done-when line in the spec? | `spec-compliance-auditor` (mandatory for M / L, § 1) |
| An architecture decision or module boundary | `chamber-os-architect` |

Auth, RBAC, payment, PII, audit-log and GDPR surfaces need **≥2 reviewers**, one of whom signs the security checklist (`specs/001-auth-rbac/security.md` § 5 for F1). Other PRs need ≥1. With no second human reviewer, the **solo-maintainer review** below replaces the second reviewer (this skill owns the rule; the constitution, since v2.0.0, leaves review mechanics to the process). Enumerate its five checks in `plan.md` § Complexity Tracking:

| Check | How |
|---|---|
| 1. Repeated independent review rounds | ≥ 2 rounds of `/code-review high <pr#>` + the § 2 surface reviewers, each in fresh subagents, until the latest round finds no High or Medium (from round 3 on, rounds are targeted to the fix commits, § 1); record the finding counts per round in the PR |
| 2. Staff review (correctness, security, tests) | `security-engineer` + `senior-tester` on the same diff, plus `whole-branch-reviewer` only when the review was split (D-022, D-036); a second round when any BLOCKER / CRITICAL / HIGH is found |
| 3. Coverage + real-infrastructure tests | the pinned coverage thresholds, and integration tests on Neon for every security-critical use case |
| 4. Defence in depth | DB- or platform-level enforcement (RLS, constraints, triggers) for every invariant that can live there |
| 5. Post-remediation verification | the reviewer that raised a finding re-runs on its fix in a new subagent; the writer never self-attests |

**Security sign-off** is the `security-engineer` report in the staff review — one security pass, not a separate step. Record its verdict in the PR as the sign-off; the maintainer does not co-sign. The built-in `/security-review` is optional, for a quick generic second look; it does not replace that report.

## 3. Spec Kit gates (an accepted way to run the steps)

`/speckit.specify` → `/speckit.clarify` → `/speckit.plan` → `/speckit.checklist` → `/speckit.tasks` → `/speckit.analyze` → `/speckit.implement` → `/speckit.verify` → `/speckit.review` → `/speckit.ship`

These commands remain usable for the matching `docs/workflow.md` steps; the process rules are the workflow's, not the commands'. A Spec Kit `tasks.md` has one task per behaviour the spec states, each naming the test that must go RED first — never one task per test file, and never the shape of the previous feature's tasks.md (template: `.specify/templates/tasks-template.md`). Every plan runs the Constitution Check against the 10 principles (`.specify/memory/constitution.md`); a deviation needs a `plan.md` § Complexity Tracking entry with the rejected simpler alternative. The `speckit-*` skills are user-invoked only (D-019): run one by name when you want it; Claude does not pick them.

## 4. Before pushing

- Run `pnpm check` once after the last edit; it contains lint, typecheck and the static gates, so do not run `pnpm lint` / `pnpm typecheck` again on top.
- Run `pnpm vitest run tests/contract/` (~4.3 min) before opening a PR; contract tests run in CI, not pre-push.
- Pre-push runs only what CI does not (D-033): a per-module integration gate when `src/modules/<m>/**` is touched, and an API-route gate when `src/app/api/**/route.ts` is touched. On a branch's first push it diffs against `merge-base origin/main HEAD`. The hook is heavy, so give `git push` a 5-minute timeout.
- Emergency override: `SKIP_INTEGRATION_PREPUSH=1 git push`. If you use it, run the touched risk surface manually and disclose that in the PR.
- e2e in CI covers only the `@critical` set (`e2e-critical.yml`, advisory, on every PR) and the full suite nightly (`e2e-nightly.yml`). A touched spec outside `@critical` still runs locally with `--workers=1` before the PR. Runbook: `docs/runbooks/e2e-ci.md`.

## 5. Merging

- `main` is protected. The required checks are `Lint · typecheck · static gates`, `Unit + contract (shard 1/2)`, `(shard 2/2)`, `Architecture governance tests`, `Integration smoke (tenant isolation + money invariants)` and `Unit + contract coverage vs pinned thresholds` (20–40 min). There are no required reviewers (the solo-maintainer review, § 2); `enforce_admins: false` lets an admin override for a hotfix; force-push and branch deletion are blocked. Verify the live list with `gh api repos/Jirawatpyk/Swedish-chaplain_Membership/branches/main/protection --jq '.required_status_checks.contexts'`.
- **Merge only when the user says so.**
- Auto-merge is disabled on the repo (`gh pr merge --auto` is refused), and enabling it is a repo-setting change the user has not asked for.
- To wait for the checks, watch them with a Monitor that polls `gh pr checks <n> --json name,bucket --jq …`. There is no `jq` binary on the workstation; use gh's built-in `--jq`.
- Once every check has passed, run `gh pr merge <n> --squash --delete-branch --repo Jirawatpyk/Swedish-chaplain_Membership`. Run it from outside a detached worktree.
- Every merge to `main` deploys to production, and prod migrations run in that deploy.
