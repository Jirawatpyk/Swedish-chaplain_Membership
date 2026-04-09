<!--
SYNC IMPACT REPORT
==================
Version change: 1.0.0 → 1.1.0  (MINOR: Development Workflow materially expanded)
Bump rationale: Development Workflow & Quality Gates expanded from 6 to 10 gates to
                cover the full Spec Kit pipeline (adds Clarify, Checklist, Analyze,
                and Verify phases). Existing gates retained and renumbered; no
                principle removed or redefined — MINOR bump per Governance semver.

History:
  - 1.0.0 (2026-04-09) — Initial ratification. Replaced template placeholders with
                         10 principles (4 NON-NEGOTIABLE + 6 Core) and full governance
                         baseline.
  - 1.1.0 (2026-04-09) — Expanded Development Workflow & Quality Gates to 10 phases
                         (Spec → Clarify → Plan → Checklist → Tasks → Analyze →
                         Implement → Verify → Review → Release) to align with the
                         full Spec Kit command set.

Modified principles: None in 1.1.0.
  (From 1.0.0: all 10 principles are in place — I. Data Privacy & Security,
   II. Test-First Development, III. Clean Architecture, IV. Payment Security (PCI DSS),
   V. Internationalization (SV/EN), VI. Inclusive UX (Mobile First + WCAG 2.1 AA),
   VII. Performance & Observability, VIII. Reliability, IX. Code Quality Standards,
   X. Simplicity (YAGNI).)

Added sections in 1.1.0:
  - Development Workflow & Quality Gates — expanded from 6 to 10 named gates; each
    gate now references its concrete /speckit.* command.

Removed sections: None.

Templates requiring updates:
  ⚠ pending  .specify/templates/plan-template.md          — Constitution Check gates
             aligned in 1.0.0; no change needed for 1.1.0 workflow expansion, but
             confirm Phase ordering matches when /speckit.plan runs.
  ✅ reviewed .specify/templates/spec-template.md          — Compatible; no change.
  ⚠ pending  .specify/templates/tasks-template.md         — Consider explicit TDD
             ordering, audit-trail tasks, a11y/i18n task categories when
             /speckit.tasks runs.
  ✅ reviewed .specify/templates/checklist-template.md     — Generic; no change.
  ✅ reviewed .specify/templates/agent-file-template.md    — Generic; no change.

Runtime guidance docs:
  - No README.md / docs/quickstart.md present yet; create on first feature.
  - Global user guidance (C:\Users\Jirawat.p\.claude\CLAUDE.md) aligned.

Follow-up TODOs: None.
-->

# Swedish Chaplain Membership Constitution

## Core Principles

### I. Data Privacy & Security (NON-NEGOTIABLE)

Personal data MUST be handled under GDPR at every layer of the system.

- Every processing activity MUST have a documented lawful basis, explicit purpose, and
  retention policy. Data minimization and purpose limitation are mandatory.
- Data subject rights (access, rectification, erasure, portability, restriction, objection)
  MUST be implementable without code changes once the feature is live.
- All web code MUST defend against the current OWASP Top 10 (injection, broken access
  control, SSRF, insecure deserialization, etc.). Security tests MUST cover each class
  that applies to the touched code path.
- Authorization MUST be Role-Based Access Control (RBAC) with least privilege. There are
  NO implicit permissions: every protected resource checks an explicit policy.
- TLS 1.2+ is mandatory in transit. PII and credentials MUST be encrypted at rest
  (AES-256 or platform-equivalent). Secrets MUST NOT be committed to git.
- EU/EEA data residency MUST be preserved where GDPR mandates it.

**Rationale**: Members are a religious community with elevated privacy expectations; a
single breach is both a legal and a trust catastrophe. This is non-negotiable because
retrofit remediation for GDPR/OWASP violations is orders of magnitude more expensive
and damaging than getting it right at design time.

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

### V. Internationalization (SV/EN)

The product MUST ship Swedish (primary) and English (secondary) from day one.

- All user-facing strings MUST come from i18n resource keys. Hardcoded text is a merge
  blocker.
- Dates, numbers, and currency MUST be formatted with locale-aware APIs (`Intl.*`).
  Default currency is SEK; EUR/USD MUST be presentable where applicable.
- A missing `sv` string MUST fall back to `en` with a build-time warning; a missing `en`
  string fails the build.
- Content length variance between SV and EN MUST be accommodated by layouts (no
  truncation, no broken wrapping).

**Rationale**: The community is Swedish-speaking with bilingual staff and visitors;
locking language support to launch guarantees accessibility for both audiences and
avoids costly retrofits.

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
- **Data Protection**: GDPR compliance at design time; Data Protection Impact
  Assessment (DPIA) required for any feature touching sensitive categories (religion,
  health, minors).
- **Payment**: PCI-DSS-certified processor, tokenization only, no raw card data stored.
  SAQ A / A-EP eligibility maintained.
- **Accessibility**: WCAG 2.1 AA conformance verified on every release.
- **Localization**: SV (primary) and EN (secondary) from day one; infrastructure ready
  for additional locales.
- **Hosting & Residency**: Production workloads and member data MUST reside in the
  EU/EEA region.
- **Audit Retention**: ≥5 years for finance, authentication, and PII access records.
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

**Version**: 1.1.0 | **Ratified**: 2026-04-09 | **Last Amended**: 2026-04-09
