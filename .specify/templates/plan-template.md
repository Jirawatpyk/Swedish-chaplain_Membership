# Implementation Plan: [FEATURE]

**Branch**: `[###-feature-name]` | **Date**: [DATE] | **Spec**: [link]
**Input**: Feature specification from `/specs/[###-feature-name]/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

[Extract from feature spec: primary requirement + technical approach from research]

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: TypeScript 5.7+ strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) · Node 22 LTS · Next.js 16 App Router · React 19 (locked — see CLAUDE.md § Locked-in tech stack)  
**Primary Dependencies**: Drizzle ORM · next-intl · react-hook-form + zod · shadcn/ui + Tailwind v4 · Resend · Stripe `^22` (feature-specific additions: [list, or "none" — a new npm dependency needs a Constitution X justification below])  
**Storage**: Neon Postgres `ap-southeast-1` with RLS + `runInTenant`; Upstash Redis for rate limiting; Vercel Blob for files (tables touched by this feature: [list])  
**Testing**: Vitest (unit/contract) · live-Neon integration (`pnpm test:integration <path>`) · Playwright + axe (`--workers=1`) — coverage pins in `vitest.config.ts`  
**Target Platform**: Vercel `sin1` (Fluid Compute, native Vercel Cron, UTC) — documented deviation from Thailand-primary hosting  
**Bounded contexts touched**: [`src/modules/<context>` list — new context? yes/no]  
**Performance Goals**: [feature-specific p95 targets per `docs/observability.md`; default API p95 < 400 ms (Constitution VII)]  
**Constraints**: [feature-specific — e.g. money in satang, §87 gap-free numbering, PDPA lawful basis, feature flag name `FEATURE_*`]  
**Scale/Scope**: [feature-specific — e.g. 150 members / 5,000 contacts today; rows, screens, cron cadence]

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*
*Source: `.specify/memory/constitution.md` (current version — cite principles by number; CLAUDE.md § Governance names the version)*

**NON-NEGOTIABLE gates** (any FAIL blocks the plan; no waivers):

- [ ] **I. Data Privacy & Security** — Lawful basis + purpose documented for any new PII
      touched; permission checks (`hasPermission(role, key)`) on every new protected route,
      server action and API route; OWASP risks for touched surfaces identified and mitigated;
      TLS 1.2+ and at-rest encryption confirmed for new data.
      **Tenant isolation (v1.4.0 sub-clauses, Review-Gate blocker if any is missing)**: every
      tenant-scoped query runs inside `runInTenant(ctx, tx => …)` and uses that `tx`; every new
      tenant-scoped table has `tenant_id` + RLS policies + `FORCE ROW LEVEL SECURITY`; a
      cross-tenant probe integration test is listed in tasks.md; the deny path emits a
      `*_cross_tenant_probe` audit event; any super-admin bypass is gated, logged and covered.
- [ ] **II. Test-First Development** — Failing tests (contract / acceptance) planned BEFORE
      implementation tasks and observed RED first; live-Neon integration test for every new
      use case; coverage pins acknowledged (Domain 100% line, Application 80% line + branch,
      100% branch on security-critical use cases — `vitest.config.ts`).
- [ ] **III. Clean Architecture** — New code maps to Presentation / Application / Domain /
      Infrastructure with the dependency rule preserved; no framework/ORM types leak out
      of Infrastructure; module boundaries named.
- [ ] **IV. Payment Security (PCI DSS)** — If payment is touched: no raw PAN/CVV stored or
      logged; processor tokenization only; audit events listed; SAQ scope unchanged.

**Core principle gates** (FAIL must be justified in Complexity Tracking):

- [ ] **V. Internationalization (EN/TH/SV)** — All new user-facing strings use i18n keys;
      EN (canonical) + TH + SV resources planned in the same change (`pnpm check:i18n`);
      TH mandatory for tax documents; locale-aware formatting for dates/numbers/currency;
      Buddhist Era display-only for `th-TH`, storage stays ISO 8601 UTC.
- [ ] **VI. Inclusive UX (Mobile First + WCAG 2.1 AA)** — Designs start at 320px;
      WCAG 2.1 AA conformance checklist attached; shared component library used.
- [ ] **VII. Performance & Observability** — Performance budgets (LCP <2.5s, INP <200ms,
      CLS <0.1; API p95 <400ms) stated; logging / metrics / traces plan listed.
- [ ] **VIII. Reliability** — Error paths enumerated; transactional boundaries defined;
      idempotency keys on money/state-changing endpoints; audit-log entries listed.
- [ ] **IX. Code Quality Standards** — TypeScript strict, ESLint clean, Conventional
      Commits, and review requirements (≥1 / ≥2 for sensitive code) acknowledged.
- [ ] **X. Simplicity (YAGNI)** — No speculative abstractions; any added complexity
      recorded in Complexity Tracking with rejected simpler alternative.

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```text
# Chamber-OS layout (CLAUDE.md § Source layout) — list only the paths this feature adds or changes
src/modules/<context>/
├── index.ts                     # public barrel — the ONLY cross-context import surface
├── domain/                      # pure types + policies; no next / drizzle-orm / resend / @upstash / react
├── application/                 # use cases + ports; Result<T,E>; no ORM / HTTP / React
│   ├── ports/                   # incl. audit-port.ts (event type catalogue lives here)
│   └── use-cases/
└── infrastructure/              # Drizzle repos (thread `tx` from runInTenant), gateways, schema.ts

src/app/(staff)/admin/<area>/    # staff pages + server actions
src/app/(member)/portal/<area>/  # member self-service
src/app/api/<area>/route.ts      # route handlers (cron routes: `export const GET = POST`)
src/components/<area>/           # presentation only — never imports domain/ or infrastructure/
src/i18n/messages/{en,th,sv}.json

drizzle/migrations/NNNN_<name>.sql + meta/_journal.json   # hand-written SQL, unique `when`

tests/unit/<context>/  tests/contract/<context>/  tests/integration/<context>/  tests/e2e/
```

**Structure Decision**: [Document the selected structure and reference the real
directories captured above]

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., new npm dependency `x`] | [what the feature cannot do without it] | [why the existing primitive / hand-rolled version was rejected] |
| [e.g., super-admin path that bypasses `runInTenant`] | [operator need] | [why a tenant-scoped path was insufficient — and how it is gated, logged and tested] |
