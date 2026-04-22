# Orchestration Snippets for `/speckit.implement`

Paste the relevant preset as `$ARGUMENTS` when invoking `/speckit.implement`.
These complement (do NOT replace) the rules already encoded in `CLAUDE.md`
and `.specify/memory/constitution.md`.

Decision rule for which preset to use:

- **Small**: < 30 tasks in tasks.md, single bounded context, no payment/tax/PII
- **Medium**: 30–100 tasks, 2–3 bounded contexts, 1 domain specialist gate
- **Large**: 100+ tasks, multi-domain, ≥ 2 NON-NEGOTIABLE Constitution gates

---

## Preset 1 — Small spec (< 30 tasks)

```text
Main-solo. Follow [P] in tasks.md. Stop + ask for schema / audit enum / arch decisions.
```

Use this when you are 90% sure main agent can handle it alone. One line keeps
the prompt light and lets you iterate quickly. Escalate to Medium mid-flight
only if you discover a specialist gate you did not anticipate.

---

## Preset 2 — Medium spec (30–100 tasks)

```text
Orchestration:
- Main-solo for implementation work
- Sub only for:
  * <specialist>: <scope + when> (pick from list below)
- Respect [P] markers in tasks.md
- Never parallel-edit: i18n/messages/*, modules/*/index.ts, drizzle/migrations/**
- Stop + ask for: schema decisions, new audit enum values, forked architectural
  paths, Constitution violations without simpler alternative

Specialist catalogue (pick only what the spec needs):
- thai-tax-compliance-auditor  — VAT, bilingual PDF, Thai RD rules
- mobile-a11y-ux-reviewer       — WCAG audit after UI phase
- chamber-os-ux-architect       — UX standards after UI phase
- drizzle-migration-reviewer    — schema + RLS review per migration
- senior-tester                 — coverage audit after implementation
- feature-dev:code-reviewer     — code quality after major milestones
```

Fill in the specialist lines based on spec domain. Delete unused lines.

---

## Preset 3 — Large spec (100+ tasks, multi-domain)

```text
Orchestration:
- Main-solo for implementation; sub gates are sequential (not parallel) review passes
- Mandatory sub gates (each blocks the next phase):
  * <specialist>: <phase + scope>
  * <specialist>: <phase + scope>
- Parallel sub allowed within a phase when target files are disjoint and not in
  the forbidden-parallel list
- Forbidden parallel-edit: i18n/messages/*, modules/*/index.ts,
  drizzle/migrations/** (including meta/_journal.json), package.json,
  pnpm-lock.yaml, tsconfig.json, .specify/memory/constitution.md
- Respect [P] markers in tasks.md for parallel-safe task groups
- Commit cadence: atomic per logical unit, not 1-per-task
- Report after each phase: commit hashes, test counts, gate status, next phase
- Dispatch feature-dev:code-reviewer every 3 phases for checkpoint review

Specialist gates (adjust to domain):
- pci-saqa-guardian             — MANDATORY if touching payment / Stripe
- thai-tax-compliance-auditor   — MANDATORY if touching invoices / VAT
- pdpa-gdpr-compliance-officer  — MANDATORY if touching PII / export / consent
- security-threat-modeler       — STRIDE review on auth / RBAC / webhook surfaces
- reliability-guardian          — atomicity + audit trail review
- performance-slo-guardian      — SLO benchmarks after core ships
- observability-instrumentor    — metrics + traces injection post-core
- drizzle-migration-reviewer    — per migration

Stop + ask for:
- New audit event enum value (needs DB migration)
- Secrets / env var scope (prod/preview/dev)
- Schema / migration decision not in plan.md
- Forked architectural paths with ≥ 2 valid options
- Constitution violation with no simpler alternative (requires Complexity
  Tracking entry in plan.md)
- Spec ambiguity that /speckit.clarify did not resolve
```

---

## Anti-patterns (do not paste these)

- `/speckit.implement ทำทุกอย่างแบบ sub` — main loses roadmap
- `/speckit.implement spawn 10 sub ขนาน` — file races + context loss
- `/speckit.implement ข้าม gate ได้` — debug pain compounds
- Pasting the Large preset for a 15-task spec — over-engineering kills velocity

---

## When to promote to skill edit

If you paste the same preset ≥ 3 consecutive specs with only specialist names
differing, promote the common frame to `.claude/skills/speckit-implement/SKILL.md`
as an "Orchestration defaults" section and keep only the specialist picker
as paste-time `$ARGUMENTS`.

---

## Changelog
- 2026-04-22: Initial 3 presets — Small / Medium / Large
