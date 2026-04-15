# Implementation Plan: F3 — Member & Contact Management + Smart Features

**Branch**: `005-members-contacts` | **Date**: 2026-04-15 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/005-members-contacts/spec.md`
**Constitution**: [`.specify/memory/constitution.md`](../../.specify/memory/constitution.md) **v1.4.0**
**Predecessors**: F1 Auth & RBAC (PR #1), F2 Membership Plans (`002-membership-plans`)
**Carry-overs resolved**: F2 D1 (Partnership bundle-change warning) + F2 US7 (Inline Edit + Bulk Actions) — see [`specs/002-membership-plans/deferred-to-f3.md`](../002-membership-plans/deferred-to-f3.md)

## Summary

F3 delivers the **third Chamber-OS business feature**: the authoritative directory of member companies and their contacts, plus the smart surfaces that make day-to-day admin work feel effortless. F3 is the first F-stream feature that handles **PII at scale** (~131 SweCham members + their ~164 contacts on day one) and is therefore the first ≥2-reviewer security-sensitive merge after F1.

F3 closes both F2 carry-overs in one branch: the Partnership bundle-change warning (D1) is now backed by **real member counts** queried live from the `members` table, and the inline-edit + bulk-action editable-table primitive (US7) is introduced here where hundreds of member rows immediately justify the cost. F3 also extends the F2 `cmdk` command palette with a new "Members" group (smart feature #4 expansion), ships the per-member Timeline view (smart feature #8) backed by the existing append-only `audit_log`, and reserves the at-risk column slot consumed later by F8.

**Out of scope** (explicit YAGNI per Principle X, mirroring spec): bulk CSV import (Phase 5 / one-off migration script), at-risk scoring (F8), benefit-usage dashboard (F9), invoice history per member (F4), online renewal (F5), event attendance history (F6).

**Technical approach**: Reuse the F1+F2 stack unchanged — Next.js 16 App Router + React 19 + TypeScript 5.7 strict + Drizzle ORM on Neon Postgres + Postgres RLS via the F2 `runInTenant(ctx, fn)` helper + shadcn/ui + Tailwind v4 + next-intl + Vitest + Playwright. Add **one new bounded context** with two co-located aggregates: `src/modules/members/` (Member aggregate root + Contact entity owned by Member — modelled as a single bounded context because contacts have no independent lifecycle per the spec). Add `@tanstack/react-table` as the editable-table primitive for the directory (F2 US7 deferral). Reuse `src/modules/tenants/` (`TenantContext`), `src/modules/auth/` (session, RBAC guard, invitation use case + email-change atomic transaction), and the F2 `src/modules/plans/` public barrel (read-only — Members import `getPlanById(year, planId)` and `getAffectedMemberCount(tenantCtx, year, planId)` is *added* to plans? — no, it lives in `members` because it queries the members table; plans owns plan metadata, members owns the inverse query). Enterprise UX is a first-class concern: every screen passes the `docs/ux-standards.md` § 15 checklist. PII handling is a first-class concern: `date_of_birth` is collected only for Thai Alumni, redacted in non-essential views, encrypted at rest by Neon, and excluded from logs by name in `src/lib/logger.ts` redaction list.

## Technical Context

**Language/Version**: TypeScript 5.7+ strict (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`) — unchanged from F1+F2
**Runtime**: Node.js 22 LTS (Vercel default) — unchanged
**Framework**: Next.js 16 App Router + Cache Components + Turbopack — unchanged
**Primary Dependencies** (new in F3 unless marked):
  - **from F1+F2** (unchanged versions): `next@^16`, `react@^19`, `drizzle-orm` + `drizzle-kit`, `next-intl`, `zod`, `react-hook-form` + `@hookform/resolvers/zod`, `shadcn/ui` + `tailwindcss@^4` + `lucide-react`, `next-themes`, `sonner`, `cmdk` (palette — F3 extends with Members group), `@vercel/otel` + `@opentelemetry/api`, `pino`, `vitest`, `playwright`, `@axe-core/playwright`, `argon2id` (for invitation flow reuse).
  - **new in F3**:
    - `@tanstack/react-table@^8` — headless editable-table primitive (the F2 US7 deferral lands here). Powers US4 (inline edit + bulk actions) over the directory; integrates with shadcn `<Table>` for visual primitives. Pin verified at install via `pnpm view @tanstack/react-table@latest version` against React 19 compat.
    - `i18n-iso-countries@^7` — ISO 3166-1 alpha-2 → localized country name lookup for EN/TH/SV (Q3 clarification). Tiny (~70KB), tree-shakable per-locale; loaded lazily in the directory + member detail screens. Alternative considered: `Intl.DisplayNames` (built-in) — rejected because Node 22 server-side rendering with `Intl.DisplayNames` for Thai/Swedish localized country names depends on the ICU build shipped by Vercel runtime which we cannot guarantee across edge regions; the explicit data package removes the runtime dependency.
  - **shadcn/ui primitives newly installed for F3**: `checkbox` (multi-row select), `combobox` (country selector), `calendar` + `popover-extended` (date_of_birth picker for Thai Alumni). Existing F1+F2 primitives reused unchanged.
  - **rejected** (YAGNI): a search service (Typesense / Meilisearch / Postgres tsvector). Substring search across company_name + primary_contact (FR-016 — 500ms p95 on ≤5,000 rows) is delivered by **Postgres `pg_trgm` + GIN index** + a single LIKE/ILIKE query per the F1 pattern. Re-evaluate when SC-002 fails on real data or when search expands across modules in F9.
  - **rejected** (YAGNI): a separate `contacts` bounded context. Spec § Summary explicitly treats contacts as having no independent lifecycle — they live and die with their member. Co-located in `src/modules/members/` as a child entity, with its own repo port for testability but no separate module barrel.
  - **rejected** (YAGNI): real-time updates / SSE / presence. Phase 5 smart #14. Last-write-wins per US3 AS6 + edge case "Primary contact demotion race" — same pattern as F2.
  - **rejected** (YAGNI): a tenant-configurable enum service for `legal_entity_type`. Q3 clarification settled on free text (max 100 chars).

**Storage**:
  - Primary: PostgreSQL via Neon `ap-southeast-1` Singapore — unchanged. Adds two new tables (`members`, `contacts`) plus extensions to the existing `audit_log` (new event types + reuse the F2 `payload jsonb` column for override reason + email-change diffs).
  - Postgres RLS: every F3-introduced table has `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + `USING (tenant_id = current_setting('app.current_tenant', TRUE))` policy, identical to F2's pattern. The F2 `runInTenant(ctx, fn)` helper is reused unchanged.
  - Indexes: `CREATE INDEX CONCURRENTLY` outside the migration transaction for `members(tenant_id, status, plan_id)` (directory filter), `members(tenant_id, plan_year)` (year filter), `members USING GIN (company_name gin_trgm_ops)` (search), `contacts(tenant_id, member_id)`, `contacts(tenant_id, email)` UNIQUE, `contacts(tenant_id, member_id) WHERE is_primary = TRUE` UNIQUE partial index for FR-003.
  - Session / rate-limit cache: Upstash Redis (Singapore) — unchanged. F3 reuses F1's per-IP + per-account rate limit on the `/api/auth/invite/[token]` endpoint when members invite colleagues. F3 also adds a **per-actor token bucket on `/api/members/bulk`** (10 bulk ops / 10 min per `(tenant_id, actor_user_id)`) per FR-019b, reusing the F1 Upstash rate-limit adapter unchanged.

**Testing**:
  - `vitest` — unit + Application tests. Coverage thresholds: Domain 100% line; Application ≥80% line + 80% branch overall, **100% branch on security-critical use cases**: `enforce-tenant-context-on-member.ts`, `change-contact-email.ts` (atomic transaction + session revocation), `enforce-self-service-field-whitelist.ts` (FR-014 forged-payload guard), `bulk-action-cap.ts` (FR-019a 100-row enforcement), `archive-cascade-guard.ts` (FR-005 + invitation revocation).
  - `playwright` — E2E with the existing F1+F2 setup. New specs: `tests/e2e/members-create.spec.ts`, `members-directory-search.spec.ts`, `members-edit-with-bundle-warning.spec.ts`, `members-bulk-actions.spec.ts`, `members-self-service.spec.ts`, `members-timeline.spec.ts`, `members-archive-undelete.spec.ts`, `members-a11y.spec.ts` (axe-core), `members-i18n.spec.ts` (locale coverage).
  - `@axe-core/playwright` — WCAG 2.1 AA on every new screen.
  - **New cross-tenant integration test for F3** (Constitution v1.4.0 Principle I clause 3 — Review-Gate blocker): `tests/integration/members/tenant-isolation.test.ts` — creates two tenants with UUID-suffixed slugs, inserts members + contacts for each, and asserts zero cross-tenant visibility on SELECT / INSERT / UPDATE / DELETE plus audit-log emission of `member_cross_tenant_probe` on every probe attempt from both directions.
  - **New email-change atomic-transaction integration test** (FR-012a critical path): `tests/integration/members/contact-email-change-atomic.test.ts` — verifies the 6-step transaction (contact + user email update, session revocation, old-email disable, verification outbox enqueue, dual-channel notification outbox enqueue) commits as a single unit and rolls back entirely if any sub-step fails. **Chaos sub-scenarios**: (a) outbox insert throws → full rollback, (b) session revocation port throws → full rollback, (c) user email update conflict (race) → full rollback.
  - **New dual-channel revert-token integration test** (FR-012b): `tests/integration/members/email-change-dual-channel.test.ts` — verifies clicking the OLD-email revert token within 48h rolls back the change, invalidates the new-email verification, flags `requires_password_reset`, and emits `member_email_change_reverted`.
  - **New outbox permanent-failure chaos test** (FR-012c): `tests/integration/members/outbox-permanent-failure.test.ts` — simulates Resend 5xx on all retries; asserts the outbox row is marked `permanently_failed`, `email_dispatch_failed` is audited, and the admin "Re-send verification" action generates a fresh token.
  - **New bulk-action rate-limit test** (FR-019b): `tests/integration/members/bulk-action-rate-limit.test.ts` — 11th bulk action within 10 minutes returns 429 + emits `bulk_action_rate_limit_exceeded`.
  - **New RLS coverage cross-cutting test extension** (critique E12): extend `tests/integration/rls-coverage.test.ts` (F2) to include `members` + `contacts` in the `information_schema.tables` loop — any new tenant-scoped table without RLS + FORCE + policy = automatic red CI.
  - **New search perf test** (critique E5, SC-002): `tests/integration/members/search-perf.test.ts` gated by `RUN_PERF=1`; seeds 5,000 synthetic members across two tenants and asserts substring search p95 < 500ms on a representative query set.
  - **New invitation-bounce integration test** (spec edge case): `tests/integration/members/invitation-bounce.test.ts` — simulates a Resend `email.bounced` webhook; asserts invitation is marked `failed`, `invitation_bounced` audited, and the "Re-send invite" action produces a fresh invitation.

**Target Platform**: Web browsers (mobile Safari, Chrome Android, Chrome, Firefox, Safari, Edge — last 2 versions). Deployed on Vercel `sin1` + Neon `ap-southeast-1` — unchanged.

**Project Type**: Web application (Next.js full-stack, single repo, single deploy) — unchanged.

**Performance Goals**:
  - **Spec SC-001**: Create new member in ≤ 90 s wall-clock (US1) — UX target, not a server-side number.
  - **Spec SC-002**: Directory substring search ≤ 500 ms p95 perceived latency on 5,000 rows — Postgres `pg_trgm` + GIN index.
  - **Spec SC-004**: Bulk-change-plan on 100 members ≤ 5 s server time + zero partial-state failures.
  - **Spec SC-008**: Bundle-change warning real-count fetch ≤ 200 ms on plans with ≤ 500 assigned members.
  - **Constitution Principle VI**: LCP < 2.5 s, INP < 200 ms, CLS < 0.1 on mid-range mobile over 4G (every new screen).
  - **Constitution Principle VII**: Members API p95 < 400 ms, p99 < 800 ms.

**Constraints**:
  - Tenant isolation enforced at BOTH application and database layers — cross-tenant probe returns 404 (FR-022) and emits `member_cross_tenant_probe` immediately (not deferred to a periodic scan, unlike F2 plans where typo probes were deemed low-signal — for member PII any probe is high-signal).
  - PII redaction in logs: `email`, `phone`, `date_of_birth`, `tax_id`, `Authorization` headers, raw verification tokens — extend the F1 `pino` redaction list. User IDs hashed when correlated across requests (F1 pattern).
  - PDPA + GDPR dual compliance — `date_of_birth` collected only for Thai Alumni (Q5 + spec edge case), excluded from default API responses (opt-in via explicit `?include=date_of_birth` admin-only query param on the detail endpoint).
  - SV+EN+TH at release; missing EN key blocks build, missing TH/SV CI-fails on release branches.
  - WCAG 2.1 AA on every screen; full keyboard nav; `prefers-reduced-motion` honoured on timeline reveal animations (US6 AS4).
  - All timestamps ISO 8601 UTC; Thai Buddhist Era display-only for `th-TH`.
  - Soft-delete only — hard delete is NOT exposed in the UI (FR-005). Undelete window 90 days (Q-default — confirmed in spec assumptions).
  - Append-only audit log extended (not restructured) with new event types reusing the F2 `payload jsonb` column.
  - Bulk action server-side cap = **100 rows per batch** (FR-019a); UI blocks > 100 selection at the source.

**Scale/Scope**:
  - Today: 1 live tenant (SweCham), ~131 members + ~164 contacts.
  - 5-year target: ~15-20 tenants × ~1,000 members each = ~20,000 members platform-wide (well within Neon Singapore single-instance capacity).
  - Admin concurrency: < 5 staff per tenant, < 100 platform-wide — single Vercel region + single Neon instance remain sufficient.
  - Member self-service concurrency: ~10% of members active per month per tenant; F3 portal load is dominated by reads.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*
*Source: [`.specify/memory/constitution.md`](../../.specify/memory/constitution.md) **v1.4.0***

### NON-NEGOTIABLE gates (any FAIL blocks the plan; no waivers)

- [x] **I. Data Privacy & Security — including v1.4.0 Tenant Isolation clauses**
  - **PII surfaces introduced**: company contact data (name, email, phone, role), `date_of_birth` (Thai Alumni only), `tax_id` (Corporate + Partnership tiers), `member.notes` (admin notes — may contain incidental PII). All are subject to PDPA + GDPR dual compliance.
  - **Lawful basis**: contractual necessity (membership administration) for company + primary contact data; consent for secondary contact details + `date_of_birth`. Consent capture surface: invitation acceptance UI in F1 already shows the privacy notice — F3 extends the notice copy to enumerate the new fields.
  - **Purpose limitation**: contact data is used ONLY for membership administration and benefit delivery. Marketing use requires separate consent (deferred to F7 E-Blast).
  - **RBAC**: `admin` full CRUD; `manager` read-only on directory + member detail; `member` reads own profile + edits whitelisted fields only (FR-013, FR-014). Enforced by extending the F1 `rbac-guard.ts` with a `members:*` and `contacts:*` resource family — see research.md § 3.
  - **Tenant Isolation — two-layer defence-in-depth (Constitution v1.4.0 Principle I clauses 1-5):**
    1. **Application layer (clause 1):** every member-touching use case in `src/modules/members/application/**` takes a `TenantContext` as an explicit dependency parameter. Forgetting to pass it is a TypeScript compile error. `TenantContext` is imported from `@/modules/tenants` (the F2-introduced cross-cutting Domain-only module) — F3 does NOT redefine it. The composition root in `src/modules/members/members-deps.ts` wires the resolver output from `src/lib/tenant-context.ts`.
    2. **Database layer (clause 2):** `members` and `contacts` both have `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + a `USING (tenant_id = current_setting('app.current_tenant', TRUE))` policy. The F2 `runInTenant(tenantCtx, fn)` helper is reused unchanged. **Dev-mode safety net** `DEBUG_RLS_STATE=1` (F2-introduced) loud-fails in dev when a query runs with `app.current_tenant` unset; production silently relies on the RLS "zero rows" default.
    3. **Test enforcement (clause 3):** `tests/integration/members/tenant-isolation.test.ts` creates two tenants with UUID-suffixed slugs, inserts members + contacts for each, and asserts zero cross-tenant visibility on every CRUD operation from both directions, plus emission of `member_cross_tenant_probe` on each attempt. **Review-Gate blocker** — fails the gate if missing or red.
    4. **Audit (clause 4):** Cross-tenant probes return 404 (never 403 or 401) and emit `member_cross_tenant_probe` immediately at high severity (different from F2 plans where typo probes were low-signal — member PII probes are always high-signal). Payload includes `attempted_member_id`, `actor_user_id`, `actor_tenant_id`. Alert threshold: 1 event / 5 min (alarm), 5 events / hour (incident).
    5. **Super-admin impersonation (clause 5):** not applicable to F3 — no super-admin console exists yet (F13).
  - **OWASP Top 10 coverage** (delta vs F1+F2 for the touched surface): A01 Broken Access Control — RBAC + RLS + member self-service field whitelist (FR-014, FR-014a compile-time tuple); A02 Cryptographic Failures — at-rest AES-256 (Neon) + TLS 1.2+ (Vercel + HSTS) — inherited; A03 Injection — Drizzle parameterised queries, zod on every API boundary, no dynamic SQL; A04 Insecure Design — atomic transaction on contact email change (FR-012a) prevents the "stale session takes over via email rotation" attack; A05 Security Misconfiguration — `pg_trgm` extension created via migration, not enabled-by-default; **A07 Identification & Authentication Failures — the admin-impersonation ATO vector on FR-012a is explicitly mitigated by the dual-channel notification (FR-012a item vi) + 5-minute verification delay + revert token (FR-012b) + high-severity audit on every admin-initiated email change (see `spec.md` § Security considerations)**; A08 Software & Data Integrity — append-only audit log extended; A09 Logging Failures — `member_cross_tenant_probe` + `member_self_update_forbidden` + `member_contact_email_changed` + `email_dispatch_failed` + `bulk_action_rate_limit_exceeded` are high-severity audit events; A10 SSRF — N/A, no outbound URL fetches in F3.
  - **TLS 1.2+** + **at-rest AES-256** — inherited from F1+F2 unchanged.

- [x] **II. Test-First Development**
  - **TDD ordering**: every user story (US1–US7) has at least one acceptance test authored red and committed before the matching use-case implementation lands. `tenant-isolation.test.ts` and `contact-email-change-atomic.test.ts` are authored red at the very start of the implementation phase.
  - **Coverage thresholds** (extending the F2 `vitest.config.ts`):
    - Domain layer (`src/modules/members/domain/**`): 100% line — pure types, validators, override-reason enum + 500-char rule, primary-contact invariant rule, Thai 13-digit checksum, `MemberStatus` state-transition rules (`active` ↔ `inactive`, `* → archived`, `archived → active` only within 90-day window).
    - Application layer (`src/modules/members/application/**`): ≥ 80% line + 80% branch overall, **100% branch on security-critical use cases** listed in Technical Context.
  - **Contract tests** (`tests/contract/members/`): one file per REST endpoint, asserting request/response shapes against shared zod schemas.
  - **Integration tests** (`tests/integration/members/`): hit live Neon Singapore — RLS enforcement, primary-contact partial-index race, contact-email atomic transaction with simulated Resend failure rollback, bulk-action 100-row cap + 101-row rejection, archive cascade to invitation revocation, undelete-after-90-days rejection, command palette member lookup respects RLS.
  - **Red test suite on `main` = stop-the-line** — same as F1+F2.

- [x] **III. Clean Architecture**
  - **One new bounded context**: `src/modules/members/` (full four-layer Domain → Application → Infrastructure + Presentation via `src/app/`). Public barrel (`index.ts`); ESLint `no-restricted-imports` extended to forbid deep imports into `members/{domain,application,infrastructure}` from outside the module.
  - **Domain layer has zero framework imports** — no `next`, `drizzle-orm`, `resend`, `react`. Holds the `Member` aggregate root, `Contact` entity (child of Member, no independent lifecycle), `MemberStatus`, `OverrideReason`, value objects (`Email`, `Phone`, `TaxId` with country-aware validation, `IsoCountryCode`), and invariants (one primary contact, archive-window rule, Thai 13-digit checksum). `TenantContext` is imported from `@/modules/tenants`. `contacts.linked_user_id` is modelled in Member Domain as a **branded opaque `UserId`** — NOT imported from `@/modules/auth` (which would make Member Domain depend on Auth Domain types). The FK at the DB layer (declared in Infrastructure only) is a separate concern. ESLint rule scoped to `src/modules/members/domain/**` extends the F1+F2 rule list and forbids `@/modules/auth/domain/**` imports.
  - **Application layer orchestrates Domain via ports** — `MemberRepo`, `ContactRepo`, `AuditPort`, `ClockPort`, `EmailPort` (Resend wrapper), `SessionRevocationPort` (auth module port reused), `PlanLookupPort` (consumes F2 `plans` barrel). No Drizzle, Next, Resend, or React imports. All use cases return `Result<T, E>` (reusing `src/lib/result.ts`).
  - **Infrastructure layer** owns Drizzle schema, migrations, repo implementations, the `pg_trgm` search adapter, and the Resend `EmailPort` adapter. Drizzle-inferred types do NOT leak into Application — repos return Domain types.
  - **Presentation layer** (`src/app/(staff)/admin/members/**`, `src/app/(member)/portal/**`, `src/app/api/members/**`, `src/app/api/plans/[year]/[planId]/affected-members/route.ts`) calls the public barrel only.
  - **Cross-module imports**: `members` consumes `auth` (session, RBAC, invitation use case, session revocation port) + `tenants` (`TenantContext`) + `plans` (read-only plan lookup) — all via public barrels. No reverse dependency.
  - **Deliberate placement note**: the new `GET /api/plans/[year]/[planId]/affected-members` endpoint **routes under `/api/plans/`** for URL coherence with the F2 plan endpoints, but its handler imports the use case from `@/modules/members` because the inverse query (count members by plan) is a member-side concern. Routing path ≠ module ownership — explicit per Principle III.

- [x] **IV. Payment Security (PCI DSS)** — **Not applicable in F3.** F3 does not process payments. `tax_id` is a tax-compliance identifier (Thai 13-digit), not a payment instrument; it is collected for F4 invoicing readiness (Q5 clarification). No PAN, no CVV, no card data of any kind. F5 will re-validate SAQ-A.

### Core principle gates (FAIL must be justified in Complexity Tracking)

- [x] **V. Internationalization (SV + EN + TH)** — Static UI uses `next-intl` messages keyed under `admin.members.*` and `portal.profile.*` in `messages/{en,th,sv}.json`. Missing EN keys fail the build. TH+SV enforced on release branches via `pnpm check:i18n`. Country names rendered via `i18n-iso-countries` per locale. Override-reason enum localized as `admin.members.overrideReason.{board_approved|pending_renewal_grace|data_correction|other}`. Thai-specific content: `tax_id` validation error message in Thai uses Thai-language formatting; `date_of_birth` picker on Thai Alumni member uses Thai BE display per F1+F2 pattern. Toast messages, dialog confirmation labels, audit-event display strings all keyed.

- [x] **VI. Inclusive UX (Mobile First + WCAG 2.1 AA + Enterprise Standards)** — `docs/ux-standards.md` § 15 checklist is a merge blocker. Shimmer skeleton renders in the exact directory-table shape for CLS 0 (ux-standards § 2.1). sonner toasts on every mutation success/failure (ux-standards § 4.2). Confirmation dialogs on archive + bulk archive + contact remove (ux-standards § 4.1) — bulk archive over 5 rows requires the typed-phrase pattern per US4 AS3. aria-live region announces inline-edit saves + rollbacks + bulk results for screen readers (ux-standards § 7.3). `prefers-reduced-motion` swaps timeline reveal animation for an instant transition (US6 AS4). Light + dark parity via `next-themes`. Layouts start at 320px. Full keyboard navigation — Tab / Shift-Tab / Enter / Esc / arrow keys cover the directory grid, palette, inline edit, bulk select dialog, and create wizard. Focus returns to triggering element on dialog close. Automated WCAG 2.1 AA scan via `@axe-core/playwright` in `tests/e2e/members-a11y.spec.ts` covers all listed FR-024 surfaces. **Member self-service portal (`/portal`) inherits the same standards** — no degraded UX for the member persona.

- [x] **VII. Performance & Observability** — `pino` JSON logs with `logger.child({ tenant, member_id_hash })` for traceability. PII fields added to redact list (`email`, `phone`, `date_of_birth`, `tax_id`). `@vercel/otel` traces span Application → Infrastructure for every member use case with `tenant.id`, `member.id`, `actor.user_id`, `route.name` attributes. Vercel Speed Insights + Lighthouse CI inherited. SLOs: members API p95 < 400 ms, search p95 < 500 ms (SC-002), bundle-warning fetch p95 < 200 ms (SC-008), bulk-action 100-row p95 < 5 s (SC-004). `member_cross_tenant_probe` and `member_self_update_forbidden` are counted as `members.*.count` metrics with PagerDuty-equivalent alerts on threshold breach (1 cross-tenant probe / 5 min triggers alarm). Runbook addition to `docs/observability.md` § F3 Members during implementation.

- [x] **VIII. Reliability (Error Handling + Data Integrity + Audit Trail)** — Every error path returns a typed `Result<T, E>` — no thrown exceptions across the use-case boundary. Transactional boundaries:
  - Member create + first contact create + audit append = one transaction (FR-002).
  - Contact email change + linked-user email update + session revocation + verification email dispatch + audit append = **one transaction with the email send queued for after-commit dispatch via an outbox row** (Resend dispatch failure does NOT roll back the DB transaction — see research.md § 4 outbox pattern). Sub-step failure before commit rolls back entirely.
  - Bulk action over N (≤100) rows = one transaction wrapping all N updates + N audit events (FR-019). Server-side cap enforced even on a forged client request.
  - Archive + invitation revocation cascade = one transaction (edge case "Contact tied to a pending F1 invitation").
  - Undelete = one transaction (status flip + audit append + `archived_at` clear).
  - **Idempotency keys** on every mutation API endpoint (shared pattern with F1+F2): `Idempotency-Key` header required on POST / PATCH / DELETE.
  - **Audit log extends the F1+F2 `audit_log` table** via migration `0009_audit_log_f3_extension.sql` — 17 new event types added via top-level `ALTER TYPE audit_event_type ADD VALUE` statements (each outside any transaction block, per Postgres rules — same pattern as F2 migration `0007`). Reuses the existing `payload jsonb` and `tenant_id` columns from F2 — no new columns. New event types listed in FR-023 plus the 3 added during clarification (`member_contact_email_changed`, `user_sessions_revoked`, `email_verification_sent`). Retention ≥ 5 years (inherited).
  - Concurrent edit handling: last-write-wins with a toast telling the overwritten admin their change was replaced (matches F2 + edge case "Primary contact demotion race").

- [x] **IX. Code Quality Standards** — TypeScript strict (incl. `noUncheckedIndexedAccess`), ESLint clean, Prettier, Conventional Commits enforced by commit-msg hook. **Solo-maintainer substitute** (Constitution v1.3.1) applies as in F1+F2: direct push to `main` after Review Gate sign-off is permitted because no second human reviewer is available; the substitute stack is ≥6 `/speckit.review` automated passes + ≥2 `/speckit.staff-review` rounds + the F1+F2 test bar (now extended with the F3 integration + cross-tenant + email-atomic tests) + maintainer co-signature on the security checklist (which IS authored for F3 because F3 touches PII and email-change flows — see Phase 1 deliverables).

- [x] **X. Simplicity (YAGNI)** — Key YAGNI decisions explicitly made:
  - **No separate `contacts` bounded context.** Contacts are a child entity of Member with no independent lifecycle (spec § Summary). Co-located in `src/modules/members/`.
  - **No CSV import in F3.** Phase 5 / one-off migration script (R6 + spec assumptions).
  - **No real-time updates / SSE / presence.** Phase 5 smart #14.
  - **No at-risk scoring logic in F3.** F8 owns the rule engine. F3 only adds a nullable `member_risk_flag` column + a placeholder UI cell in the directory.
  - **No benefit-usage dashboard.** F9 + depends on F6/F7 data.
  - **No event attendance history tab.** F6 will add it as part of EventCreate Integration; pre-shipping an empty placeholder tab trains admins to ignore it (same reasoning as F2 D1 deferral).
  - **No invoice history tab on member detail.** F4 will add it; F3 ships a "Renewal history" stub backed by audit-derived plan changes (US6 already covers this via Timeline).
  - **No tenant-configurable `legal_entity_type` enum.** Free text per Q3.
  - **No multi-admin-contact-per-member model.** Spec assumptions confirm one primary contact, ever.
  - **No global email uniqueness.** Per-tenant unique only — a consultant can hold portal access across multiple tenants under one email. Edge case in spec.
  - **No hard delete in UI.** Soft delete + 90-day undelete window only (FR-005).
  - **No new search service.** `pg_trgm` + GIN handles SC-002 on the spec's 5,000-row target. Re-evaluate on real-world failure or F9 multi-entity search.
  - **`affected-members` endpoint is plain count, not analytics.** It returns `{ current_count, new_signup_warning_text }` only — no per-member list, no projections — sufficient for the bundle-change dialog (Q clarification not needed because spec was explicit).

**All 10 gates PASS.** No new F3-specific Constitution deviations. Two deviations inherited from F1 (Singapore hosting region + solo-dev review substitute) carry over unchanged — see Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/005-members-contacts/
├── plan.md                  # This file
├── spec.md                  # Feature specification (with Clarifications Q1–Q5)
├── research.md              # Phase 0 output
├── data-model.md            # Phase 1 output
├── quickstart.md            # Phase 1 output
├── contracts/
│   └── members-api.md       # Phase 1 output — REST endpoint contracts
├── checklists/
│   └── requirements.md      # Spec quality checklist (from /speckit.specify)
├── security.md              # PII threat model + security checklist (authored before /speckit.tasks; ≥2-reviewer prerequisite)
└── tasks.md                 # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── app/                                                # Presentation layer
│   ├── (staff)/admin/
│   │   └── members/
│   │       ├── layout.tsx                              # members section shell + breadcrumb
│   │       ├── page.tsx                                # Directory list (US2, US4 inline + bulk)
│   │       ├── new/page.tsx                            # Create member (US1)
│   │       ├── [memberId]/
│   │       │   ├── page.tsx                            # Detail view (US2 deep link)
│   │       │   ├── edit/page.tsx                       # Edit form (US3 + bundle warning)
│   │       │   ├── timeline/page.tsx                   # Timeline (US6)
│   │       │   └── archived-banner.tsx                 # Conditional banner for archived members (US7)
│   │       └── _components/
│   │           ├── members-table.tsx                   # TanStack Table wrapper (US4)
│   │           ├── bulk-action-bar.tsx                 # Multi-select toolbar
│   │           ├── bundle-change-warning-dialog.tsx    # F2 D1 carry-over (US3 AS4-AS5)
│   │           ├── member-form.tsx                     # Shared create/edit form (RHF + zod)
│   │           ├── override-reason-dialog.tsx          # FR-006a enum + optional note
│   │           └── archive-confirm-dialog.tsx          # Typed-phrase confirmation (US4 AS3)
│   ├── (member)/portal/
│   │   ├── layout.tsx                                  # Member shell — replaces F1 placeholder
│   │   ├── page.tsx                                    # Profile dashboard (US5 landing)
│   │   ├── edit/page.tsx                               # Whitelisted-field edit (FR-014)
│   │   └── contacts/invite/page.tsx                    # Colleague invite (US5 AS4)
│   ├── api/members/
│   │   ├── route.ts                                    # POST create, GET list (paginated)
│   │   ├── [memberId]/route.ts                         # GET detail, PATCH update, POST archive, POST undelete
│   │   ├── [memberId]/contacts/route.ts                # POST add, GET list
│   │   ├── [memberId]/contacts/[contactId]/route.ts    # PATCH update, DELETE remove, POST promote-primary, POST invite
│   │   └── bulk/route.ts                               # POST bulk action with 100-row server cap
│   ├── api/portal/
│   │   ├── profile/route.ts                            # GET own profile (member self-service)
│   │   └── profile/route.ts (PATCH)                    # PATCH whitelisted fields
│   └── api/plans/[year]/[planId]/affected-members/route.ts  # F2 D1 carry-over count endpoint
│
├── modules/members/                                    # New bounded context
│   ├── index.ts                                        # Public barrel
│   ├── domain/
│   │   ├── member.ts                                   # Aggregate root, status, invariants
│   │   ├── contact.ts                                  # Child entity, primary invariant
│   │   ├── value-objects/{email,phone,tax-id,iso-country-code,override-reason}.ts
│   │   └── policies/{primary-contact-invariant,archive-window,thai-tax-id-checksum,age-eligibility,turnover-validation,startup-duration}.ts
│   ├── application/
│   │   ├── ports/{member-repo,contact-repo,audit-port,clock-port,email-port,session-revocation-port,plan-lookup-port}.ts
│   │   ├── use-cases/{create-member,update-member,change-plan,promote-primary-contact,add-contact,update-contact,change-contact-email,remove-contact,archive-member,undelete-member,bulk-action,inline-edit,member-self-update,invite-portal,invite-colleague,timeline-list,affected-members-count,directory-search}.ts
│   │   └── members-deps.ts                             # Composition root
│   └── infrastructure/
│       ├── db/{schema-members,schema-contacts,migrations}.ts
│       ├── repos/{drizzle-member-repo,drizzle-contact-repo}.ts
│       └── adapters/{resend-email-port,auth-session-revocation-port,plan-lookup-adapter}.ts
│
├── components/
│   └── command-palette/members-group.tsx               # Extends F2 palette (smart #4)
│
├── lib/
│   ├── logger.ts                                       # ADD email/phone/dob/tax_id to redact list
│   └── env.ts                                          # ADD ISO_COUNTRIES_DATA_PATH (build-time only)
│
└── i18n/messages/{en,th,sv}.json                       # +~150 keys under admin.members.* + portal.profile.*

drizzle/migrations/
├── 0008_members_contacts.sql                           # Two new tables, RLS policies, partial indexes, pg_trgm GIN
└── 0009_audit_log_f3_extension.sql                     # 17 new ALTER TYPE ADD VALUE statements (top-level)

tests/
├── contract/members/                                   # one file per endpoint
├── integration/members/
│   ├── tenant-isolation.test.ts                        # Constitution Principle I clause 3 — Review-Gate blocker
│   ├── contact-email-change-atomic.test.ts             # FR-012a transactional integrity
│   ├── primary-contact-race.test.ts                    # Partial-index race per edge case
│   ├── bulk-action-cap.test.ts                         # 100/101 row enforcement
│   ├── archive-cascade.test.ts                         # Invitation revocation + session disable
│   ├── undelete-window.test.ts                         # 90-day rule
│   └── seed-fixtures.ts                                # Two-tenant fixture builder
├── unit/members/                                       # Domain + Application unit tests
└── e2e/                                                # Playwright specs listed in Testing § above
```

**Structure Decision**: Co-locate Member + Contact in **one bounded context** (`src/modules/members/`) per Principle X — Contacts have no independent lifecycle. Reuse F2's `tenants` cross-cutting module unchanged. Place the inverse-query `/api/plans/[year]/[planId]/affected-members` route under `/api/plans/` for URL coherence but import its use case from `@/modules/members` (Principle III boundary clarity). All other paths follow the F1+F2 patterns.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Hosting region: Singapore (`sin1`) instead of Thailand | No major cloud has a TH region; ~25ms Bangkok latency acceptable; PDPA Section 28 + GDPR SCCs cover transfer | True in-country residency would require a Thai-local provider with weaker DX, weaker durability SLOs, and no CDN — net worse for PII protection. Inherited from F1; unchanged in F3. |
| Solo-maintainer review substitute (≥2 reviewers requirement waived) | Solo developer; no second human reviewer available | Blocking merge until a second reviewer joins would freeze delivery indefinitely. Substitute = ≥6 automated `/speckit.review` passes + ≥2 `/speckit.staff-review` rounds + extended test bar + maintainer co-signature on `security.md`. Inherited from F1+F2. |

No other Constitution deviations introduced by F3.

## Migration Rollback Plan

Two migrations ship in F3:

- **`0008_members_contacts.sql`** — creates `members` + `contacts` tables, the `pg_trgm` extension (idempotent — `CREATE EXTENSION IF NOT EXISTS`), all indexes (created via `CREATE INDEX CONCURRENTLY` outside the migration txn per Postgres requirement), and RLS policies. **Rollback**: `DROP TABLE contacts, members CASCADE;` + `DROP EXTENSION pg_trgm;` (safe only if no other feature depends on it — F3 is the first user). Safe to roll back on a fresh deploy with no production member data. If production data exists, recovery is via a point-in-time restore on Neon, not a manual rollback.
- **`0009_audit_log_f3_extension.sql`** — adds 20+ new values to the `audit_event_type` enum via top-level `ALTER TYPE … ADD VALUE` statements, each outside any transaction block per Postgres rules (same pattern as F2 `0007`). **Each statement is wrapped in an idempotency-safe DO block** to tolerate partial-failure re-runs:
  ```sql
  DO $$ BEGIN
    ALTER TYPE audit_event_type ADD VALUE 'member_created';
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  ```
  A mid-run failure on statement #N no longer blocks re-application — statements #1…#N-1 are skipped on retry, and #N onward proceed cleanly. **Rollback is IMPOSSIBLE** — Postgres does not support `DROP VALUE` on enum types. Forward-fix policy: if a new audit event type is erroneous, ship `0010` to stop emitting it; never attempt to remove it from the enum. Audit readers must tolerate orphaned enum values.

**Feature flag**: `FEATURE_F3_MEMBERS` gates every F3 route + use case. Default `true` on all environments; kill-switch value `false` causes F3 routes to return `503 read_only_mode` + hides the Members entry from navigation + the command palette, keeping F1 + F2 fully functional. Verified via `tests/integration/members/feature-flag-kill-switch.test.ts`.

## Phase 0 Status

- [x] research.md authored — see [`research.md`](./research.md). All 10 research questions resolved. No remaining `NEEDS CLARIFICATION` markers.

## Phase 1 Status

- [x] data-model.md authored — see [`data-model.md`](./data-model.md). Two tables (`members`, `contacts`), RLS policies, indexes, audit-log extension catalogue.
- [x] contracts/ authored — see [`contracts/members-api.md`](./contracts/members-api.md). 11 endpoints + zod schemas + idempotency-key conventions.
- [x] quickstart.md authored — see [`quickstart.md`](./quickstart.md). New-developer onboarding for F3 surfaces.
- [x] CLAUDE.md updated — `Active Technologies` + `Recent Changes` sections refreshed via `update-agent-context.ps1`.

## Post-Design Constitution Re-Check

All 10 gates re-validated after Phase 1 design — **PASS**. No new violations introduced by the data model, contracts, or the bounded-context layout. No additional Complexity Tracking entries.
