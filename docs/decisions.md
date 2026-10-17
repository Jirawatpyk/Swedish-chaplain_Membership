# Decisions

Numbered, dated decisions that shape how Chamber-OS is built. The newest decision wins on a conflict; a superseded one stays here, marked. Precedence between this file and other sources: `CLAUDE.md` § Precedence. Add an entry when the user settles a question, when an incident or a review changes how something must be done, or when a plan picks between real alternatives (`docs/workflow.md` § Decisions).

Format: **D-NNN — title** (date) · *Context* · *Decision* · *Consequence*.

---

**D-001 — Host in Singapore, not Thailand** (F1)
- *Context*: the constitution says Thailand primary, but no major cloud (AWS/GCP/Azure/Vercel) has a TH region.
- *Decision*: Vercel `sin1` + Neon `ap-southeast-1` + Upstash Singapore. PDPA § 28 covers SG transfers; EU data subjects are covered by GDPR SCCs with Vercel and Neon.
- *Consequence*: documented in `specs/001-auth-rbac/plan.md` § Complexity Tracking. Moving to a Thai-local provider requires amending that deviation.

**D-002 — Migrations from 0019 on are hand-written SQL**
- *Context*: Drizzle snapshots stop at `0018`, so `drizzle-kit generate` produces wrong diffs (and blocks on a TTY prompt).
- *Decision*: write each `.sql` by hand, register it in `drizzle/migrations/meta/_journal.json`, apply with `pnpm db:migrate`.
- *Consequence*: never run `pnpm db:generate`. A duplicate `when` makes the migrator a silent no-op, so verify the DDL in `information_schema`.

**D-003 — Neon is branched: `dev` for local and tests, `main` for prod** (2026-06-23)
- *Context*: local work and integration tests used to share the production database.
- *Decision*: `.env.local` points at the `dev` branch; prod and per-PR preview branches migrate automatically on Vercel deploy (`vercel-build`); integration tests refuse a prod host.
- *Consequence*: `pnpm db:migrate` never touches prod. Map: `docs/runbooks/db-environment-branching.md`.

**D-004 — All cron runs on native Vercel Cron** (2026-07-17)
- *Context*: the Pro plan made native cron available; cron-job.org was an external moving part.
- *Decision*: every trigger lives in `vercel.json`; cron-job.org is a paused standby.
- *Consequence*: schedules are UTC (Bangkok −7 h), and handlers are invoked with GET (`export const GET = POST`).

**D-005 — AURA replaces the legacy UI kit** (spec 122)
- *Context*: the shadcn/Base UI kit was being customised screen by screen.
- *Decision*: adopt `@jirawatpyk/aura-react` + `@jirawatpyk/aura-tokens`, exact-pinned, module by module; the legacy kit is deleted at spec 122 US13. A gap in AURA is filed as a handoff item, and the app carries a labelled stand-in until AURA ships the fix.
- *Consequence*: `docs/aura-adoption.md` is the ledger; an unlabelled `.aura-*` reach fails the internal-class ratchet.

**D-006 — Merge only when the user says so; no auto-merge**
- *Context*: every merge to `main` deploys to production, and money paths are live.
- *Decision*: Claude merges only on the user's explicit word, by squash with branch deletion, after the six required checks pass. Repo auto-merge stays disabled.
- *Consequence*: `review-and-ship` § 5.

**D-007 — Setting a Vercel env var is a production deploy**
- *Context*: `vercel.json` has no `ignoreCommand`, so every merge deploys, and a flag set early is armed for whoever merges next.
- *Decision*: add a feature flag only when ready to redeploy immediately; new flags default OFF.
- *Consequence*: `docs/operational-state.md` records the observed state of each flag.

**D-008 — The built-in `/code-review` runs at the `high` level by default** (2026-10-17)
- *Context*: with no level given, `/code-review` reuses the last level typed.
- *Decision*: always run `/code-review high`. `xhigh` / `max` are opt-in, and `/code-review ultra` (cloud, billed) is the user's call. Large or high-stakes branches use the `review-branch` Workflow.
- *Consequence*: `review-and-ship` § 1.

**D-009 — Pilot a native Claude Code workflow in place of the Spec Kit gate commands** (2026-10-17) — *superseded by D-018*
- *Context*: the user prefers to move off Spec Kit: ten gates, heavy artefacts, and broken scripts on this install.
- *Decision*: `docs/workflow.md` + the `feature-flow` skill, piloted on the next feature. It keeps the constitution's substance (Constitution Check, TDD red-first, reviewer counts, cross-tenant test, Complexity Tracking).
- *Consequence*: the constitution's § Development Workflow still names the Spec Kit gates. Amend it in a separate PR, with a Sync Impact Report, after the pilot. Until then a feature may use either flow, and its PR says which.

**D-010 — Instructions are split by when they load** (2026-10-17)
- *Context*: a 44.7 KB `CLAUDE.md` loaded into every session and had gone stale.
- *Decision*: `CLAUDE.md` (identity, commands, precedence) + `.claude/rules/rules.md` load every session; architecture and per-module rules are path-scoped; review and workflow procedures are skills; changing state lives in `docs/operational-state.md`.
- *Consequence*: a fact that matters for one module goes in that module's rule; `CLAUDE.md` stays under 200 lines.

**D-011 — Hard bans are enforced by settings; DoD hooks wait for evidence** (2026-10-17)
- *Context*: CLAUDE.md is advisory, and a few commands had already caused damage when run (prettier across unrelated files, a shared `git stash`, `db:generate` diffs, prod scripts).
- *Decision*: `.claude/settings.json` `permissions.deny` blocks the usual spellings of `pnpm format`, `prettier --write`, `git stash`, `pnpm db:generate`, `pnpm db:push` and the `:prod` scripts, for both the Bash and the PowerShell tool. A deny rule matches command text, not the program, so the ban still covers every other spelling. A DoD line becomes a hook only after a retro shows it being skipped.
- *Consequence*: the user runs a denied command themselves when it is genuinely needed. A new ban is added here and to the deny list together.

**D-012 — The run recipe is a skill named `run-chamber-os`, not `verify`** (2026-10-17)
- *Context*: Claude Code runs a project skill named `verify` before every commit, and a cold dev server here takes minutes; without a recipe, `/verify` guesses the launch and gets the port, the database or the personas wrong.
- *Decision*: record the recipe as `run-chamber-os` (worktree, :3400, dev branch, personas, `playwright.attach.config.ts`, UI probes). `/verify` and `feature-flow` step 6 follow it.
- *Consequence*: a branch is verified against its own code on :3400, never against :3100 (which serves the main checkout) or the prod database. Claude may still start :3100 and open it in the built-in browser to look at `main`.

**D-013 — M / L changes keep a written plan; reviews never run in the writer's context** (2026-10-17)
- *Context*: a plan made only in plan mode lives in one conversation, so it is lost on compaction or hand-off, and a later reviewer has nothing to compare the code against. Here, a plan has mandated a defect that surfaced only at review round 7.
- *Decision*: M / L changes save `specs/<nnn-name>/plan.md` (template in the `feature-flow` skill), including a test plan that replaces Spec Kit's `tasks.md`; for L, `chamber-os-architect` and the surface reviewers read it before the user agrees. The main session builds S / M; L is cut into vertical slices, built one subagent per slice in order, each reviewed before the next; `whole-branch-reviewer` runs before every slice PR merges, plus a final seam pass when slices share a branch. Review always runs in subagents.
- *Consequence*: `docs/workflow.md` § Who does what; DoD and PR template lines for the plan.

**D-014 — Pilot features record the Spec Kit gate deviation in `plan.md`** (2026-10-17) — *superseded by D-018*
- *Context*: the constitution's § Development Workflow requires every feature to pass the Spec Kit gates, and its solo-maintainer substitute names `/speckit.review` and `/speckit.staff-review`. By `CLAUDE.md` § Precedence the constitution outranks D-009.
- *Decision*: until the constitution is amended, a `feature-flow` feature records in `plan.md` § Complexity Tracking that it replaces the Spec Kit gate commands with `docs/workflow.md`, **with the maintainer's explicit approval of that deviation, given in the session and recorded in the row** (the user's instruction is precedence #1). The constitution's substitute clause covers reviews and pushes, not gate skips, so the approval is per feature. The substitute's review checks map as in `review-and-ship` § 2: ≥ 3 rounds of `/code-review high` + surface reviewers; `whole-branch-reviewer` + `security-engineer` + `senior-tester` for the staff review; the raising reviewer re-runs on each fix.
- *Consequence*: on each pilot feature Claude asks once, at the plan step, for that approval, and records it. The amendment PR (with its Sync Impact Report) follows the first pilot feature.

**D-015 — No High or Medium review finding may remain at merge** (2026-10-17)
- *Context*: the first draft allowed a Medium to stay open with a reason in the PR.
- *Decision*: every High and every Medium is fixed. A finding closes unfixed only when it is refuted with evidence (code, test, measurement) and the reviewer confirms that on a re-run; it is never waived. Lows are fixed or listed in the PR.
- *Consequence*: `docs/workflow.md` step 7 (Review) and the DoD, the PR template, `review-and-ship` § 1 and the substitute mapping.

**D-016 — Mechanical guards stay minimal: only what cannot be undone** (2026-10-17)
- *Context*: the final setup audit found the "never" rules were prose only and reviewer subagents inherited every tool (mail, deploy). The maintainer wants Claude Code to work freely, with little blocking.
- *Decision*: enforce only the irreversible. `.claude/hooks/guard.mjs` (PreToolUse) blocks a shell command that reads `.env*` (not `.env.example`), writing a `.env*` file, and editing a migration already on `origin/main`; `permissions.deny` adds `Read(.env*)` and the PII workbooks to the existing list. The ten review-only agents get `tools: Read, Grep, Glob, Bash, WebFetch, WebSearch` (memory still grants Write/Edit for their own memory). `git add -A`, killing a dev server, and merge/deploy commands stay advisory — no `ask` prompts. A fail-open `return _exhaustive` is caught by `tests/unit/architecture/no-return-exhaustive.test.ts`.
- *Consequence*: adding a new block needs a retro showing the prose rule failed (D-011). The guard fails open on input it cannot parse.

**D-017 — Agent memory is per machine** (2026-10-17)
- *Context*: agents use `memory: project`, but `.claude/agent-memory/` is gitignored.
- *Decision*: keep it that way. Agent memories quote incidents and data that should not be committed, and the maintainer works on one machine. Worktrees and cloud sessions start without them.
- *Consequence*: an agent's durable lesson goes into the repo (a rule, a skill, a test), not only into its memory.

**D-018 — Constitution v2.0.0: principles only; the process lives in `docs/workflow.md`** (2026-10-17)
- *Context*: the constitution prescribed the ten Spec Kit gates and the review mechanics (≥2 reviewers, a five-check substitute naming `/speckit.review` ×3 and `/speckit.staff-review`, a co-sign footer), so every `feature-flow` feature needed a per-feature deviation (D-014). The maintainer judged that process outdated and asked for current best practice instead.
- *Decision*: amend to v2.0.0 (MAJOR). Remove § Development Workflow & Quality Gates and Principle IX's review mechanics; Principle IX keeps code-quality rules and requires only independent review and a security sign-off on sensitive surfaces. `docs/workflow.md` + the `review-and-ship` skill own the process: on sensitive surfaces ≥2 reviewers, or for a solo maintainer the solo-maintainer review (≥ 2 fresh-subagent review rounds until no High/Medium; staff review by `whole-branch-reviewer` + `security-engineer` + `senior-tester`; coverage + real-infrastructure tests; defence in depth; the raising reviewer re-checks each fix). The security sign-off is the `security-engineer` report in the staff review (one pass; `/security-review` is optional); the maintainer does not co-sign. Amendments need only the sole maintainer's PR approval.
- *Consequence*: D-009 and D-014 are superseded. Principles I–VIII and X are unchanged; `CLAUDE.md` § Precedence puts the constitution first on principles and `docs/workflow.md` first on process.

**D-019 — Verify before Review; review rounds by risk; plan mode is asked for; Spec Kit skills off** (2026-10-17)
- *Context*: a self-review of the workflow found that a bug fixed during Verify skipped review; "≥ 2 rounds" read as applying to every change; nothing said who opens plan mode; and ~57 `speckit-*` skills competed with `feature-flow`.
- *Decision*: the order is Check → **Verify → Review**, and any change after review goes back through it. A normal change gets one review round plus re-checks of each fix; a sensitive surface gets ≥ 2 rounds plus the staff review. At step 3 Claude asks to enter plan mode (the user approves, or switches modes themselves) and presents the plan for approval; L slices don't re-enter plan mode unless a slice leaves the plan. Every `speckit-*` skill is set to `disable-model-invocation: true`: the user can still run one by name, but Claude doesn't pick them.
- *Consequence*: steps 6 and 7 swap numbers in `docs/workflow.md` and the `feature-flow` skill.

**D-020 — Each L slice has its own branch and a status row in plan.md** (2026-10-17)
- *Context*: "start slice 2" in a fresh session on `main` gave no way to tell which feature it meant, slice branches had no naming rule, and nothing recorded which slices had shipped.
- *Decision*: slice *k* builds on `<nnn>-<short-name>-s<k>`, cut from `origin/main` after slice *k − 1* merged. The slice's own PR sets its row in the `plan.md` Slices table to the PR number and `done` before it merges, so `main` always shows shipped slices; no script maintains it. Slices share one plain `<nnn>-<short-name>` branch only when a slice cannot deploy safely on its own even behind a flag, with the reason in `plan.md` § Complexity Tracking. An unnamed "start slice N" continues the one feature with open slices, or asks when there are several.
- *Consequence*: the Slices table in `plan-template.md` gains Branch and PR · status columns; `docs/workflow.md` § Slices and the `feature-flow` skill (steps 2, 4, 9) say the same.
