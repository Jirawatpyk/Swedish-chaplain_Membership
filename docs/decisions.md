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

**D-008 — The built-in `/code-review` runs at the `high` level by default** (2026-10-17) — *refined by D-022: always with a target*
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

**D-021 — An independent check of Done-when evidence; one owner for review rules** (2026-10-17)
- *Context*: the main session collected the Done-when evidence and ticked the DoD itself, so no reviewer checked that the evidence proves each line, which breaks "the writer is never the reviewer". The review rules were also written out three times (`docs/workflow.md` step 7, `feature-flow` § 7, `review-and-ship` § 1), and Verify twice.
- *Decision*: every M / L review runs `spec-compliance-auditor` with `spec.md` and the Verify evidence. A Done-when line with no evidence, or evidence that does not prove it, is a High finding. The Verify evidence is written to `plan.md` § Evidence, one line per Done-when line, so every review round reads the same record. `review-and-ship` § 1 is the single source for how review works; the workflow keeps the contract and `feature-flow` the order. Verify's recipe is `run-chamber-os`. The Spec Kit-only `tasks.md` rule moves from the always-loaded `rules.md` to `review-and-ship` § 3.
- *Consequence*: the `spec-compliance-auditor` agent learns to read Done-when lines; the DoD's evidence line names it.

**D-022 — `whole-branch-reviewer` runs only when the review was split** (2026-10-18)
- *Context*: `whole-branch-reviewer` was added as a seam pass after per-module reviews. When `/code-review high` is given the PR (or `origin/main...HEAD`) as its target, it reads the PR's whole diff, so on a normal PR the seam pass read the same diff twice. With no target the command diffs against the branch's upstream, and on a pushed branch that range is empty (measured on #581: 0 lines), so the target is part of the rule. Spec 123 slice 1 also showed that Claude did not know it can run `/code-review` itself.
- *Decision*: run `whole-branch-reviewer` last only when the review was split: the `review-branch` Workflow, a per-module review, or slices sharing one long-lived branch (at the end, for the seams between slices). A normal PR, sliced or not, relies on `/code-review high`, the surface reviewers and, for M / L, `spec-compliance-auditor`. The staff review on sensitive surfaces keeps it unchanged (solo-maintainer review, check 2). Claude runs `/code-review high` itself through the Skill tool, always with a target (`high <pr#>`, or `high origin/main...HEAD` before the PR exists).
- *Consequence*: `docs/workflow.md` step 7, § Slices and the DoD, `review-and-ship` § 1, `feature-flow` § 7 and the PR template say so.

**D-023 — Separate RED commits are required only where the risk is** (2026-10-18)
- *Context*: every change needed a RED commit and then a GREEN commit. For UI presentation, copy and small fixes the split commit added ceremony without adding safety. What actually protects us is seeing the test fail against the old code, and that can be recorded without a separate commit. Leading teams rarely require the split commit.
- *Decision*: constitution 2.1.0. For UI presentation (React components, styles and markup; never `route.ts` handlers or server actions), copy, and size-S changes that are not guards, the failing test and the code may share one commit, provided the failing run (the test against the old code) is recorded in `plan.md` § Evidence, or in the PR for size S. Money, tax, auth/RBAC, tenancy, PII, audit log, migrations and domain/application logic keep separate RED and GREEN commits.
- *Consequence*: Principle II, `rules.md`, `docs/workflow.md` step 4 and the DoD, `feature-flow` § 4 and the PR template say so.

**D-024 — Claude may run `pnpm db:verify:prod`** (2026-10-18)
- *Context*: spec 123 slice 2 found 0110-0113 unrecorded in prod's `drizzle.__drizzle_migrations`. Whether 0113's column change had landed could only be answered by reading prod, and the deny list blocked the one read-only script that does it, so the maintainer had to run SQL by hand.
- *Decision*: the maintainer lifted the deny on `pnpm db:verify:prod` (Bash and PowerShell). `scripts/verify-schema.ts` is SELECT-only. `db:migrate:prod`, `seed:system-actors:prod` and the `.env*` read guard stay as they are; this narrows D-016's list, it does not reopen it.
- *Consequence*: a change that makes `verify-schema.ts` write anything needs the deny restored first. It gained canaries for 0110-0112 (eight enum values) and 0113 (`renewal_cycles.plan_id_at_cycle_start` is `text`); both passed on prod on 2026-10-18 (target host printed and distinct from dev's). The script used to load `.env.local` on top of the caller's env file, which could point a "prod" run at dev; that second load is gone and the run prints its target host.

**D-025 — The guard blocks every spelling of a prod write script** (2026-10-18)
- *Context*: the security review of PR #588 (D-024) found that `permissions.deny` matches a command by prefix. So `pnpm run db:migrate:prod`, `pnpm -s db:migrate:prod`, `npm run …`, and `node --env-file=.env.production … scripts/run-migrations.ts` all still ran. The guard's `.env*` rule fires only together with a file reader, so it did not catch them either.
- *Decision*: `.claude/hooks/guard.mjs` reads each simple command of a shell line. Lines are split on `;` `&&` `||` `|` `&` `( )` `{ }` and backticks. A heredoc body is dropped unless a shell or node reads it. The command that runs is found past any `VAR=` assignments, and past a wrapper (`timeout`, `env`, `nohup`, `nice`, `exec`, `sudo`, `npx`, `xargs`, `bash`/`sh`/`pwsh`/`cmd` with any flags, `Start-Process`) to the next pnpm or node word. The guard blocks in two cases. First, a package-manager call whose script (the first non-flag word, past `run`) ends in `:prod`, unless it is `db:verify:prod`. Second, a command that names a prod env file (`.env.production`, `.env.prod*`, `*.bak.prod`) in any word, whether it uses `--env-file`, `source`, `.` or `cp`. The one exception is a node run whose only module is `scripts/verify-schema.ts`, with no eval flag and no extra `--import`/`-r`/`--loader` module. Text-only commands (`git`, `gh`, `echo`, `printf`) are not checked. This narrows D-016's "keep the guard minimal" for an irreversible action, which is the class D-016 keeps blocked.
- *Consequence*: a new read-only prod script has to be added to `READ_ONLY_PROD_SCRIPTS` (and `READ_ONLY_PROD_FILE`); every other `*:prod` script is blocked by default. Accepted residual risk, which only a deliberate attempt reaches (security review of #590): variable indirection (`X=db:migrate:prod; pnpm $X`), split quoting (`db:migrate:'prod'`), `eval` / `iex`, piping into `xargs pnpm`, shell functions and aliases, `node …/pnpm.cjs`, and a prod env pulled under another name (`vercel env pull … .env.vp`). A known false positive: text inside quotes that contains `; pnpm x:prod` is split and blocked. The `permissions.deny` lines stay as a second layer.

**D-026 — Staff fan-outs read the global `users` table until F10 `user_tenants`** (2026-10-24)
- *Context*: relay round R81 found a member's change-request submit taking 60–83 s on the dev branch. The submit queues one staff email per active reviewer, and the reviewers come from `listActiveUsersByRole`, which reads the cross-tenant `users` table (`users` has no tenant link before F10; see docs/saas-architecture.md § F1 migration path). Three callers share it: the change-request submit (`src/lib/members-change-request-deps.ts`), the outbox dispatcher's reviewer lookup, and the E-Blast marketing notifications (`src/lib/broadcast-marketing-deps.ts`).
- *Decision*: keep the global read while Chamber-OS is single-tenant deployed. The change-request fan-out is now one multi-row INSERT (`EmailPort.enqueueManyInTx`), so its cost no longer grows with the reviewer count. Scoping reviewers per tenant is F10 work (`user_tenants`), not a local patch.
- *Consequence*: **a second tenant must not share a database with SweCham until F10 scopes these three reads**: until then, every tenant's staff would be queued each other's member notifications. F10's plan must list the three call sites.

**D-027 — A plans state change and its audit row share one transaction** (2026-10-24)
- *Context*: every F2 plans mutation (create, clone, update, activate/deactivate, soft-delete, undelete, schedule and cancel a scheduled plan change) committed its write in the repo's own `runInTenant` and then appended the audit in a separate call. An audit failure returned `audit_failed` after the row had changed; a retried update then hit the empty-diff short-circuit, so the change was never audited. The cancel route even answered 200 + `X-Audit-Backfill-Required` and relied on an out-of-band backfill (R3-S4 / R4-I9, which read Constitution VIII as "audit writes are compliance-critical but NOT transactional with the domain mutation"). The members module already writes state and audit in one tx.
- *Decision*: Constitution VIII says "any database operation that mutates more than one row or crosses aggregates MUST run inside a transaction"; a state row and its audit row are two rows. Each plans use case hands the repo an `afterWrite` hook (`InTxHook`, `auditInTx`) that appends the audit through `AuditPort.recordInTx` on the write's tx and throws `PlanAuditAbort` on failure, so the write rolls back. `runInTenant` stays out of the plans Application layer (its files are reachable from client bundles). The cancel route answers a plain retryable 500 on `audit_failed`; the backfill header, its replay test and the `plans_cancel_audit_backfill_required_total` counter are removed. This supersedes R3-S4.
- *Consequence*: spec 126 (#7). `AuditPort.record` stays for the two F8 callers that still emit their F2 audit after their own tx — `accept-tier-upgrade` and `finalise-f2-plan-change-on-paid` (the latter post-commit on purpose: its audit INSERT fires the members last-activity trigger, which deadlocked inside the settlement tx) — left as a follow-up. `cancel-audit-failed-row-persists.test.ts` became `…-row-rolls-back.test.ts` with its assertions inverted.

**D-028 — The write freeze leaves sign-in, sign-out and heartbeat up** (2026-10-25)
- *Context*: spec 001 quickstart § 7.3, CLAUDE.md and four runbooks say sign-in stays alive under `READ_ONLY_MODE`, but `src/proxy.ts` refused every state-changing request and T044 pinned sign-in → 503 (following `research.md`). R86 (PR #648) found it live: during a freeze every signed-out staff member and member was locked out, and sign-out and the idle heartbeat failed too.
- *Decision*: the freeze skips exactly three POSTs, matched on the exact path (`READ_ONLY_EXEMPT_PATHS`): `/api/auth/sign-in` (a session row and its audit rows are the spec's tolerated read-after-write; rate limits and lockout still apply), `/api/auth/sign-out` (deletes only the caller's session — it reduces access) and `/api/auth/heartbeat` (the same `last_seen_at` write every page GET already makes). The CSRF Origin check still runs on all three.
- *Consequence*: every other write stays frozen, including password reset and change, invitation redemption, email verification and the renewal redeem-link. A new auth endpoint is frozen unless it is added to the list with a decision. `tests/unit/proxy/read-only-auth-exemption.test.ts` pins the list, the near-misses and the CSRF path.

**D-029 — Every tenant-scoped statement carries its own `tenant_id` predicate, alongside RLS** (2026-10-25)
- *Context*: issue #653. Principle I asks for isolation "at BOTH layers". Two readings had grown: renewals (Round 6 S-R5-6, ~61 methods) and plans (research § 7.1, 12 methods) relied on `runInTenant` + RLS alone and wrote no `WHERE tenant_id`, while invoicing, payments, broadcasts, events, members and insights wrote it, and insights gated it (retro 2026-10-23).
- *Decision*: the application layer is an explicit `tenant_id` predicate on every reference to a tenant-scoped table — each FROM / JOIN / UPDATE / DELETE, CTE bodies and subqueries included — bound to the repo's `TenantContext` slug (the same value RLS reads), or correlated to an already-fenced table's `tenant_id`. RLS stays the database layer. Inserts set `tenant_id` in VALUES. This supersedes S-R5-6 and plans research § 7.1.
- *Consequence*: a repo stays isolated if RLS is ever bypassed (an owner connection, a lost `SET LOCAL ROLE`, a policy regression). `tests/helpers/tenant-sql-shape.ts` records the SQL a repo actually sends through a Drizzle `pg-proxy` db and fails any reference without its predicate; each swept repo has a gate test that must call every repo method, and a bound predicate counts only when its parameter is the tenant. The sweep lands in slices (130 s1–s7: renewals s1–s3, plans s4, members s5–s6, the remaining modules s7 — widened 2026-10-26 when a tenant-table-aware scan found ~115 more statements than the `_tenantId`-only inventory).
- *Exempt*: pure `insert … values` (tenant in VALUES); `email_delivery_events`, which has no `tenant_id` and is read cross-tenant by `to_email` on purpose (`drizzle-bounce-event-query.ts`). *Known limit*: the checker counts predicates, it does not place them — one inside an OR branch still counts, so review an OR next to a tenant predicate by hand.

**D-031 — A Stripe replay adopts its NULL-tenant `processor_events` row on the owner connection** (2026-10-26)
- *Context*: finding L-1 of the `financial-integrity-reviewer` on PR #663. An event for an unregistered account leaves a rejection row with `tenant_id NULL` (audit 2026-04-25: such rows are "never promoted"). A dashboard replay after the account is registered dispatched it, but `markProcessed` as `chamber_app` cannot see a NULL-tenant row (the 0036 SELECT policy), so the row was never stamped and every replay dispatched again. A probe on Neon dev (26 Oct 2026) confirmed `chamber_app` cannot adopt it either. Rejected: changing the policy (every tenant would see every rejection row, Principle I); refusing to dispatch (the event could never be applied).
- *Decision*: `insertIfNew`, which already runs on the owner connection, adopts the row in its duplicate path when the delivery resolved a tenant: `tenant_id` set, `outcome = 'processed'`, only for `acknowledged_only` / `rejected_environment_mismatch` / `rejected_api_version_mismatch` rows of the same `processor_account_id` (or `''`, a platform-owner event recorded before the route's account fallback was configured) and `livemode`, never `rejected_signature`. Each adoption writes a `webhook_unresolved_event_adopted` audit row (10 y) naming the outcome it replaced, on the adoption's own owner transaction so neither commits without the other, because the UPDATE overwrites it (review rounds 1–2, maintainer's choice). `processWebhookEvent` dispatches no duplicate whose stored tenant is not the resolved tenant. This revises the 2026-04-25 "never promoted" rule.
- *Consequence*: the written tenant comes only from the server-side account lookup of a signature-verified event; RLS is unchanged. An operator replay of a payment that arrived before its account was registered now settles the invoice once. Adoptions and refusals are counted (`payments_webhook_unresolved_row_adopted_total`, `payments_webhook_duplicate_tenant_mismatch_total`, the latter alerted). The owner-role write bypasses RLS by design; the app predicate and the CHECK on `rejected_signature` are its walls. Spec 132.
