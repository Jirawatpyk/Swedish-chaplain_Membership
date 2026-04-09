<!--
SYNC IMPACT REPORT
==================
Version change: 1.1.0 → 1.2.0  (MINOR: domain identity corrected + TH locale + TH hosting)
Bump rationale: Correction of domain identity (project is the Thailand-Swedish Chamber
                of Commerce, not a "chaplain" organisation) + material expansion of
                Principle V (adds TH as a third mandatory locale, driven by Thai tax-
                invoice legal requirements) + Compliance section updates for Thailand
                primary hosting and Thailand PDPA alongside GDPR. No principle removed
                or redefined — MINOR bump per Governance semver.

History:
  - 1.0.0 (2026-04-09) — Initial ratification. Replaced template placeholders with
                         10 principles (4 NON-NEGOTIABLE + 6 Core) and full governance
                         baseline.
  - 1.1.0 (2026-04-09) — Expanded Development Workflow & Quality Gates to 10 phases
                         (Spec → Clarify → Plan → Checklist → Tasks → Analyze →
                         Implement → Verify → Review → Release) to align with the
                         full Spec Kit command set.
  - 1.2.0 (2026-04-09) — Domain identity corrected (SweCham / TSCC); Principle V
                         expanded to SV + EN + TH; Principle I and Compliance section
                         updated for Thailand primary hosting + PDPA + Thai tax-invoice
                         requirements + Thai Buddhist calendar handling.

Modified principles in 1.2.0:
  - Title: "Swedish Chaplain Membership Constitution"
           → "SweCham / TSCC Membership Constitution"
  - I. Data Privacy & Security — rationale rewritten (not a "religious community"),
                                  PDPA added alongside GDPR, residency updated.
  - V. Internationalization    — SV/EN → SV + EN + TH; TH is mandatory for tax-compliant
                                  invoices; adds Thai Buddhist calendar handling rule
                                  (store ISO 8601 UTC, display locale-aware).

Added/changed sections in 1.2.0:
  - Compliance & Technology Standards
      * Localization: SV + EN + TH
      * Hosting & Residency: Thailand primary (GDPR still applies to EU data subjects)
      * Data Protection: GDPR + Thailand PDPA (both apply)
      * Payment: Stripe recommended (see phases-plan.md Decision R2)
      * Thai tax-invoice compliance noted
      * Calendar handling: ISO 8601 UTC storage, locale-aware display

Removed sections: None.

Templates requiring updates:
  ✅ reviewed .specify/templates/plan-template.md   — Constitution Check still aligned.
  ✅ reviewed .specify/templates/spec-template.md   — Compatible; no change.
  ⚠ pending  .specify/templates/tasks-template.md   — Consider explicit TDD ordering,
             audit-trail tasks, a11y/i18n task categories when /speckit.tasks runs.
  ✅ reviewed .specify/templates/checklist-template.md  — Generic; no change.
  ✅ reviewed .specify/templates/agent-file-template.md — Generic; no change.

Runtime guidance docs:
  - docs/database-analysis.md       — authoritative domain model (v1, 2026-04-09)
  - docs/phases-plan.md             — 9-feature phase plan, decisions resolved
  - Global user guidance (C:\Users\Jirawat.p\.claude\CLAUDE.md) aligned.

Follow-up TODOs:
  - Repo folder rename `Swedish chaplain_membership` → `swecham-membership` (or
    `swedish-chamber-membership`) is a manual action for the user — cannot be done
    safely from within the active working directory. Tracked in phases-plan.md R6.
-->

# SweCham / TSCC Membership Constitution
<!-- Thailand-Swedish Chamber of Commerce — member, invoice, event, and renewal system -->


## Core Principles

### I. Data Privacy & Security (NON-NEGOTIABLE)

Personal data MUST be handled under **both Thailand PDPA and EU GDPR** at every layer
of the system. Because SweCham has Thai-resident admins + Thai tax obligations AND
Swedish/EU member data subjects, both regimes apply simultaneously — design for the
stricter of the two on every field.

- Every processing activity MUST have a documented lawful basis, explicit purpose, and
  retention policy. Data minimization and purpose limitation are mandatory.
- Data subject rights (access, rectification, erasure, portability, restriction, objection)
  MUST be implementable without code changes once the feature is live. Rights apply
  under **both** PDPA and GDPR — the union of the two is the effective rule.
- All web code MUST defend against the current OWASP Top 10 (injection, broken access
  control, SSRF, insecure deserialization, etc.). Security tests MUST cover each class
  that applies to the touched code path.
- Authorization MUST be Role-Based Access Control (RBAC) with least privilege. There are
  NO implicit permissions: every protected resource checks an explicit policy.
- TLS 1.2+ is mandatory in transit. PII and credentials MUST be encrypted at rest
  (AES-256 or platform-equivalent). Secrets MUST NOT be committed to git.
- **Primary data residency is Thailand** (see Compliance & Technology Standards for
  detail). Cross-border transfers of EU data subjects' personal data MUST rely on
  a lawful GDPR transfer mechanism (adequacy decision, SCCs, or explicit consent) and
  MUST be documented in the record of processing.

**Rationale**: SweCham / TSCC processes commercial member records (companies + named
contact persons) with dual regulatory exposure (Thai PDPA for in-country processing,
EU GDPR for Swedish and EU member data subjects). A breach is both a legal event in
two jurisdictions and a trust catastrophe for a chamber whose primary asset is its
network. Retrofit remediation for GDPR/PDPA/OWASP violations is orders of magnitude
more expensive and damaging than getting it right at design time.

### II. Test-First Development (NON-NEGOTIABLE)

TDD is mandatory. Code without a preceding failing test MUST NOT be merged.

- Red → Green → Refactor: write the test, watch it fail, write the minimum code to pass,
  then refactor. Each step is a distinct commit or clearly separated change set.
- Every user story in a spec MUST have at least one acceptance-level test before
  implementation starts.
- Contract tests are mandatory at every external and inter-module boundary.
- Business logic MUST have ≥80% line coverage; security-critical paths (authentication,
  authorization, payment, audit logging, PII access) MUST have 100% branch coverage.
- A red test suite on `main` is a stop-the-line event. No new feature work proceeds until
  it is green.

**Rationale**: TDD keeps the design testable, gives a real safety net for refactoring,
and prevents the regression cycles that typically plague membership and billing systems.

### III. Clean Architecture (NON-NEGOTIABLE)

The codebase MUST follow a layered, modular Clean Architecture.

- Layers: **Presentation → Application → Domain → Infrastructure**. The dependency rule
  is one-way — outer layers depend on inner; inner layers know nothing about outer.
- The Domain layer MUST contain zero framework, ORM, HTTP, or I/O imports. It is pure
  business logic and types.
- Each bounded context (e.g., Members, Payments, Events, Auth) lives as a module with a
  public interface. Cross-module calls MUST go through that interface; direct imports of
  another module's internals are forbidden.
- Framework/ORM types (e.g., Prisma models, Next.js request objects) MUST NOT leak past
  the Infrastructure layer.
- Any deviation MUST be recorded in `plan.md` Complexity Tracking with justification.

**Rationale**: A layered, modular core makes it possible to swap frameworks, add
channels (admin UI, mobile, API), and evolve the data model without rewriting the
business rules — essential for a system expected to run for many years.

### IV. Payment Security — PCI DSS (NON-NEGOTIABLE)

All payment processing MUST meet PCI DSS obligations.

- The system MUST NEVER store, log, or transmit raw PAN, CVV/CVC, or full track data —
  not in databases, logs, error reports, telemetry, or screenshots.
- Card capture and tokenization MUST be delegated to a PCI-DSS-certified processor
  (e.g., Stripe, Adyen) via their hosted fields or redirect flows. Self-hosted card
  forms are forbidden.
- Only processor-issued tokens and last-4 / brand / expiry metadata may be persisted.
- Every payment event (initiation, authorization, capture, failure, refund, dispute)
  MUST be written to the append-only audit log with correlation to the triggering actor.
- TLS 1.2+ is mandatory on every payment-touching endpoint. HSTS MUST be enabled.
- PCI scope MUST be minimized; at minimum, SAQ A / SAQ A-EP eligibility MUST be
  maintained. Scope changes require constitutional amendment.

**Rationale**: PCI violations expose the organization to fines, forced disclosure, and
loss of payment capability. Outsourcing sensitive data to a certified processor keeps
scope small and the risk manageable.

### V. Internationalization (SV / EN / TH)

The product MUST ship **three locales** from day one: **English (default)**,
**Thai**, and **Swedish**.

- All user-facing strings MUST come from i18n resource keys. Hardcoded text is a merge
  blocker.
- **Thai (TH) is mandatory** — not optional — because Thai tax-compliant invoices
  and receipts MUST be renderable in Thai per Thai Revenue Department requirements.
  A feature that omits a TH translation for any user-facing string is incomplete.
- Dates, numbers, and currency MUST be formatted with locale-aware APIs (`Intl.*`).
  **Primary currency is THB**; SEK, EUR, and USD MUST be presentable where applicable.
- **Calendar handling**: all timestamps MUST be stored in **ISO 8601 UTC** (Gregorian).
  The `th-TH` locale MAY display dates using the Thai Buddhist Era (BE = CE + 543)
  for user-facing surfaces where culturally expected (e.g. tax invoices); internal
  storage, APIs, logs, and audit records MUST remain Gregorian UTC. Mixing BE and CE
  in storage is forbidden — it is a source of off-by-543-years bugs and MUST NEVER
  ship.
- A missing `en` string fails the build. Missing `th` or `sv` strings MUST fall back
  to `en` with a build-time warning. Invoices and receipts MUST NOT fall back — a
  missing TH invoice string is a **blocker** for the Invoicing feature.
- Content length variance between SV, EN, and TH MUST be accommodated by layouts
  (no truncation, no broken wrapping). TH often needs different line-break rules
  than Latin scripts — verify with real Thai content.

**Rationale**: SweCham operates in Bangkok serving Swedish, international, and
Thai-speaking stakeholders. Thai tax law mandates Thai-language invoices; Swedish
members prefer SV for day-to-day use; English is the lingua franca. Shipping all
three from day one is cheaper than retrofitting, and TH is not negotiable for the
invoicing use case.

### VI. Inclusive UX (Mobile First + WCAG 2.1 AA + UX Consistency)

The interface MUST be designed mobile-first, accessible, and consistent.

- Layouts MUST work from 320px width and progressively enhance. Desktop-only flows are
  forbidden.
- Every page MUST conform to **WCAG 2.1 Level AA**: contrast ≥4.5:1 for text, full
  keyboard navigation, visible focus indicators, semantic HTML, ARIA only where native
  semantics are insufficient, alt text on all meaningful images.
- `prefers-reduced-motion` and `prefers-color-scheme` MUST be respected.
- UI MUST be built from a single shared component library. Ad-hoc one-off components
  require explicit justification in PR.
- Core flows (register, renew, donate, sign in) MUST be usable with a screen reader and
  verified on mobile Safari and Chrome for Android before release.

**Rationale**: Members span a wide age and ability range; excluding any group from
essential membership functions is both ethically and legally unacceptable.

### VII. Performance & Observability

The system MUST be measurably fast and observable in production.

- Web vitals budgets on mid-range mobile over 4G: **LCP < 2.5s, INP < 200ms, CLS < 0.1**.
- API latency budgets: **p95 < 400ms, p99 < 800ms** for interactive endpoints.
- Every service MUST emit structured JSON logs with a correlation ID threaded through
  every call in a request.
- RED metrics (Rate, Errors, Duration) MUST be exported per endpoint.
- Distributed tracing MUST cover at minimum: authentication, payment, and membership
  lifecycle flows.
- SLOs MUST be defined before GA; alerts MUST fire on SLO burn, not on symptoms.

**Rationale**: Without budgets and observability, regressions go unnoticed until they
hurt members. Measuring is cheap; guessing is not.

### VIII. Reliability (Error Handling + Data Integrity + Audit Trail)

The system MUST degrade gracefully and preserve data integrity.

- Every error path MUST be explicitly handled. Swallowing exceptions or returning a
  generic `null` on failure is forbidden.
- End users MUST see friendly, localized messages; technical detail MUST stay in logs.
- Any database operation that mutates more than one row or crosses aggregates MUST run
  inside a transaction.
- Money-moving and membership-state-changing endpoints MUST accept an idempotency key
  and MUST be safe to retry.
- An **append-only audit trail** MUST record: authentication events, permission changes,
  payment events, PII reads/exports, and admin overrides.
- Audit retention: **≥5 years** for financial and auth records, or longer if local law
  requires.

**Rationale**: Membership and payment systems must be trustworthy records. Audit and
integrity controls turn incidents from mysteries into investigations.

### IX. Code Quality Standards

The codebase MUST maintain strict, automated quality gates.

- **TypeScript `strict: true`** across the project. `any` is forbidden unless justified
  in-line with a comment AND in the PR description; reviewers MUST challenge each use.
- **ESLint** with the project's shared config runs in CI; errors block merges.
  Formatter (Prettier or equivalent) MUST match across editors via a committed config.
- **Conventional Commits** enforced by commit-msg hook. Commit messages are part of the
  product history, not noise.
- Every change requires ≥1 reviewer. Security-sensitive areas (auth, RBAC, payment,
  PII, audit log) require **≥2 reviewers**, one of whom MUST sign off on the security
  checklist.
- Direct pushes to `main` are forbidden; all changes arrive via PR with passing CI.

**Rationale**: Automated gates catch what humans miss and keep the bar constant as the
team grows.

### X. Simplicity (YAGNI)

Build only what the current acceptance criteria demand.

- No speculative abstractions, configurability, plugin systems, or generalization for
  hypothetical future needs.
- Prefer boring, well-documented tools over novel ones. "We might need X later" is not
  a reason to add X today.
- Three similar lines beat a premature abstraction. Refactor when a real third use case
  exists.
- If simplicity is broken, the reason MUST be captured in `plan.md` Complexity
  Tracking with the simpler alternative that was rejected and why.

**Rationale**: Complexity is the dominant source of bugs, slowdowns, and onboarding
pain. YAGNI preserves velocity and clarity.

## Compliance & Technology Standards

The following stack-level and regulatory constraints apply to every feature:

- **Language & Runtime**: TypeScript (strict). Node.js LTS.
- **Quality Tooling**: ESLint, Prettier (or equivalent), Conventional Commits,
  TypeScript strict mode — all enforced in CI.
- **Data Protection**: **Thailand PDPA + EU GDPR** both apply — design for the
  stricter rule on every field. Data Protection Impact Assessment (DPIA) required
  for any feature touching sensitive categories, cross-border transfers of EU data
  subjects' data, or automated decision-making.
- **Payment**: PCI-DSS-certified processor, tokenization only, no raw card data
  stored. **SAQ A eligibility MUST be preserved.** Recommended processor: **Stripe**
  (native THB + PromptPay support, strongest DX, hosted fields preserve SAQ A). See
  `docs/phases-plan.md` Decision R2 for rationale and alternatives.
- **Thai Tax Compliance**: Invoices and receipts MUST meet Thai Revenue Department
  requirements (TH language, VAT 7% calculation, tax ID on both parties, sequential
  tax receipt numbering). Feature F4 (Membership Invoicing) is the primary surface.
- **Accessibility**: WCAG 2.1 AA conformance verified on every release.
- **Localization**: **SV + EN + TH** from day one. EN is the fallback; TH is mandatory
  for invoices/receipts per tax law; SV is mandatory for member-facing surfaces.
- **Calendar & Time**: All stored timestamps in **ISO 8601 UTC (Gregorian)**. Thai
  Buddhist Era (BE) is a **display-only** concern for the `th-TH` locale, not a
  storage format. See Principle V.
- **Hosting & Residency**: **Thailand primary.** Production workloads and operational
  data MUST reside in a Thailand region (or nearest APAC if no TH region is available
  from the chosen provider, with written justification). Cross-border transfers of
  EU data subjects' personal data (e.g. Swedish member contact details) MUST rely on
  a lawful GDPR transfer mechanism. **EU replication is NOT required** unless a
  specific legal review concludes otherwise.
- **Audit Retention**: ≥5 years for finance, authentication, and PII access records
  (satisfies both Thai tax record retention and GDPR accountability).
- **Secrets**: Managed via a secret store (e.g., platform env vars / vault); never
  committed to git; rotated on personnel changes and on any suspected compromise.

## Development Workflow & Quality Gates

All work MUST flow through the full Spec Kit pipeline:

**Spec → Clarify → Plan → Checklist → Tasks → Analyze → Implement → Verify → Review → Release**

Each gate MUST pass before the next begins. Skipping a gate requires explicit
justification in `plan.md` Complexity Tracking and ≥2 maintainer approvals.

1. **Spec Gate** (`/speckit.specify`): user stories prioritized (P1/P2/P3),
   acceptance scenarios present, measurable success criteria, edge cases listed,
   assumptions and dependencies surfaced.
2. **Clarify Gate** (`/speckit.clarify`): every `[NEEDS CLARIFICATION]` marker in
   the spec MUST be resolved with the product/domain owner before planning. Open
   questions MUST NOT leak into Plan phase.
3. **Plan Gate** (`/speckit.plan`): Constitution Check MUST be executed and pass
   against all 10 principles. Any violation goes into Complexity Tracking with
   justification and a rejected simpler alternative. Technical Context, project
   structure, and Phase 0/1 outputs (research, data-model, contracts, quickstart)
   MUST be filled in. An unjustified violation blocks progress.
4. **Checklist Gate** (`/speckit.checklist`): domain-specific quality checklists
   produced (security, a11y, i18n, privacy, performance, payment where applicable).
   Each item is binary (pass/fail) and traceable to a principle or requirement.
5. **Tasks Gate** (`/speckit.tasks`): tasks grouped by user story so each story
   is independently deliverable. **TDD ordering enforced** — test tasks precede
   implementation tasks for the same unit. Cross-story dependencies called out.
   Parallelizable `[P]` tasks marked.
6. **Analyze Gate** (`/speckit.analyze`): static and cross-artifact analysis
   performed — spec ↔ plan ↔ tasks consistency check, missing coverage flagged,
   risks and Constitution drift highlighted. Findings MUST be addressed or
   accepted with rationale before implementation starts.
7. **Implementation Gate** (`/speckit.implement`): CI green, ESLint clean,
   TypeScript compiles under `strict`, test coverage thresholds met
   (≥80% business logic, 100% security-critical paths), Conventional Commit
   messages on every commit. No work on `main` directly.
8. **Verify Gate** (`/speckit.verify`): implementation validated against the
   spec's acceptance scenarios and success criteria end-to-end. Automated QA
   (`/speckit.qa`) run where applicable. Any gap against the spec is either
   fixed or explicitly deferred with a tracked follow-up.
9. **Review Gate** (`/speckit.review` / `/speckit.staff-review`): ≥1 reviewer on
   normal code; **≥2 reviewers** on security-sensitive changes (auth, RBAC,
   payment, PII, audit log, GDPR surfaces). A security reviewer MUST sign the
   security checklist from Gate 4 for sensitive areas. Review covers correctness,
   security, performance, a11y, and constitutional compliance.
10. **Release Gate** (`/speckit.ship`): rollback plan documented, feature flags
    in place for risky rollouts, observability dashboards and alerts updated,
    on-call informed, changelog generated, PR merged, deployment executed.
    Post-release smoke tests MUST pass; a retrospective
    (`/speckit.retrospective`) is strongly encouraged after each release.

Additional rules (apply across all gates):

- No direct commits to `main`.
- PRs MUST reference the spec/feature branch they implement.
- A failing test on `main` stops all other work until resolved.
- Secrets or PII accidentally committed MUST trigger immediate rotation and a
  postmortem, regardless of which gate detected the leak.
- Amendments to this constitution itself MUST also pass the Review Gate
  (≥2 maintainers) per Governance.

## Governance

This constitution supersedes ad-hoc team preferences and any individual contributor's
habits. When in conflict with an external document, this file wins unless the external
document is a superior legal or regulatory obligation (e.g., GDPR itself, PCI DSS spec,
Swedish law).

**Amendment procedure**:

1. Proposed as a PR against `.specify/memory/constitution.md`.
2. PR description MUST include: (a) the rationale, (b) the intended version bump
   (MAJOR / MINOR / PATCH), (c) a migration or remediation plan for any existing code
   that becomes non-compliant.
3. Requires approval from **≥2 maintainers**, one of whom was not the author.
4. On merge, the Sync Impact Report at the top of this file MUST be updated and any
   dependent templates (`plan-template.md`, `spec-template.md`, `tasks-template.md`)
   MUST be reviewed and updated in the same PR or a linked follow-up.

**Versioning policy** (semver):

- **MAJOR**: a principle is removed, renumbered in an incompatible way, or redefined
  such that previously compliant code becomes non-compliant.
- **MINOR**: a new principle or governance section is added, or an existing principle
  is materially expanded.
- **PATCH**: clarifications, wording, typo fixes, or non-semantic refinements.

**Compliance review expectations**:

- Every PR review MUST cross-check the change against the principles it touches.
- `/speckit.plan` Constitution Check gate MUST be re-run whenever the constitution is
  amended against any in-flight feature.
- Quarterly, maintainers MUST review the constitution against reality: is anything
  being routinely violated? Either fix the code or amend the constitution — drift is
  forbidden.
- Runtime development guidance for agents lives in `CLAUDE.md` (and equivalent agent
  files). Those files are subordinate to this constitution.

**Version**: 1.2.0 | **Ratified**: 2026-04-09 | **Last Amended**: 2026-04-09
