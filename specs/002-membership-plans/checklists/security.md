# Security Checklist: F2 — Membership Plans

**Purpose**: Validate the **quality of tenant-isolation, RLS, audit, probe-detection, and data-integrity requirements** in the F2 spec + plan + contracts + data-model + research. This is a **unit-test suite for English** — each item asks whether the requirements themselves are complete, unambiguous, measurable, consistent, and traceable. It does NOT test implementation behaviour.
**Created**: 2026-04-11
**Feature**: [spec.md](../spec.md)
**Depth**: Formal release gate (Constitution v1.4.0 Principle I is NON-NEGOTIABLE — any ambiguity here is existential-class risk)
**Audience**: Maintainer self-review at `/speckit.tasks`, review agents at `/speckit.review`, staff-review triangulation at `/speckit.staff-review`, release reviewer at `/speckit.ship`

---

## Tenant Isolation — Application Layer Requirements

- [ ] CHK001 Is the `TenantContext` branded-type contract fully specified — including construction validation, allowed slug pattern, and rejection rules for invalid input? [Completeness, Data-model §2.5]
- [ ] CHK002 Is the rule *"every tenant-scoped use case MUST take `TenantContext` as an explicit dependency parameter"* stated as a requirement the reviewer can check mechanically, not as prose? [Clarity, Plan §I Principle I clause 1]
- [ ] CHK003 Are the exact modules that must import `TenantContext` from `@/modules/tenants` (rather than deep-import or redefine) enumerated explicitly? [Completeness, Plan Project Structure, Quickstart §3]
- [ ] CHK004 Is the behaviour of `asTenantContext(slug)` on invalid input (empty, uppercase, invalid characters, >63 chars) specified unambiguously? [Clarity, Research §1]
- [ ] CHK005 Are the requirements for **where `TenantContext` is resolved in the request flow** (middleware? per-route? server-action-only?) explicit enough that the reviewer can spot a missing resolver call? [Clarity, Plan §Principle III, Research §1]

## Tenant Isolation — Database Layer Requirements

- [ ] CHK006 Are the exact RLS policy text strings specified for both `membership_plans` and `tenant_fee_config`, including the `USING` clause, `WITH CHECK` clause, and `FORCE ROW LEVEL SECURITY` statement? [Completeness, Data-model §3.2–§3.3]
- [ ] CHK007 Is the permissive policy on the extended `audit_log` (`USING (tenant_id IS NULL OR tenant_id = current_setting(...))`) specified consistently across plan.md, research.md, data-model.md, and quickstart.md? [Consistency]
- [ ] CHK008 Is the `runInTenant(ctx, fn)` helper's semantics specified clearly — specifically, that it MUST use `SET LOCAL` (not session `SET`), and that calling patterns outside an explicit transaction are forbidden? [Clarity, Research §2 + §2.3]
- [ ] CHK009 Are the Neon-serverless + pgBouncer interaction assumptions documented AND tagged as empirically unverified pending the smoke test in `scripts/verify-rls-set-local.ts`? [Traceability, Research §2.4]
- [ ] CHK010 Does the spec define what happens when a tenant-scoped query runs **without** a `TenantContext` in production (vs. development with `DEBUG_RLS_STATE=1`)? Is the "silent zero rows" behaviour explicitly named as the safe-default? [Edge Case, Research §2.5]

## Tenant Isolation — Test Requirements

- [ ] CHK011 Is the two-tenant cross-tenant integration test specified with enough precision that a reviewer can tell whether an implementation satisfies Constitution v1.4.0 Principle I clause 3? [Measurability, Plan §I clause 3, Quickstart §6.1]
- [ ] CHK012 Are the four operations the test must exercise — SELECT, INSERT, UPDATE, DELETE — enumerated explicitly, with an expected "0 rows affected" assertion for each cross-direction? [Completeness, Quickstart §6.1]
- [ ] CHK013 Is the requirement that test tenants MUST use UUID-suffixed slugs (`test-swecham-${uuid}`) documented as a test-isolation rule rather than a "nice to have"? [Clarity, Plan §II, Quickstart §6.1]
- [ ] CHK014 Is the `createTestTenant` helper's cleanup contract specified — specifically, WHAT rows it must delete and from WHICH tables — so parallel CI runs provably cannot interfere? [Completeness, Quickstart §6.1]
- [ ] CHK015 Is the test blocker status of `tests/integration/plans/tenant-isolation.test.ts` stated explicitly as a **Review-Gate blocker** (not just "should pass")? [Traceability, Plan §I clause 3]

## Probe Detection & Audit Requirements

- [ ] CHK016 Is the 404-never-403 rule for cross-tenant reads specified as an explicit contract invariant in `plans-api.md`, not just a behavioural aspiration? [Clarity, Contracts §2]
- [ ] CHK017 Is the rule *"request-path code MUST NEVER run a `BYPASS RLS` query"* stated explicitly as a security requirement? [Completeness, Plan §I clause 4]
- [ ] CHK018 Are the request-path logging requirements — specifically that every admin 404 appends a `plan_not_found` info-severity event — specified with the exact payload shape? [Clarity, Data-model §2.6]
- [ ] CHK019 Is the split between request-path responsibilities (`plan_not_found` only) and F13 periodic-scan responsibilities (`plan_cross_tenant_probe` escalation) documented clearly enough that no one accidentally implements the escalation in request-path code? [Clarity, Plan §I clause 4, Contracts §2]
- [ ] CHK020 Is the `plan_cross_tenant_probe` escalation logic specified — including what "match" means, what triggers escalation, and where the logic lives (F13, not F2)? [Completeness, Data-model §2.6]

## Audit Log Extension Requirements

- [ ] CHK021 Is the complete list of 10 new `audit_event_type` enum values consistent across plan.md, data-model.md, research.md, and contracts? Does every file count the same 10 values and use snake_case consistently? [Consistency, Plan §VIII, Data-model §2.6]
- [ ] CHK022 Is the migration `0007_audit_log_f2_extension.sql` specified with a filename that is consistent across all referencing files? [Consistency]
- [ ] CHK023 Is the Postgres-specific rule *"ALTER TYPE ADD VALUE cannot run inside a transaction block"* documented as a constraint on the migration structure, not as an implementation note? [Clarity, Research §12]
- [ ] CHK024 Are the audit payload diff-shape requirements normative — specifically the `{ [field]: { before, after } }` contract, the "only changed fields" rule, and the special shapes for create / delete / clone / probe events? [Completeness, Data-model §2.6a]
- [ ] CHK025 Is the rule *"audit payload zod schema is the single source of truth shared by the writer and the test suite"* explicit, with the schema file path specified? [Traceability, Data-model §2.6a]
- [ ] CHK026 Is the append-only guarantee preserved? Specifically, is it documented that F1's `audit_log_immutable` trigger automatically applies to F2 events without modification? [Completeness, Plan §VIII]

## Data Integrity Requirements (Money, RLS, Currency)

- [ ] CHK027 Is the rule *"`currency_code` is immutable in F2 after any plan exists"* stated consistently in spec.md (FR-016 + edge case), contracts/plans-api.md (§13 + §14), and nowhere contradicted by an earlier section allowing the change? [Consistency, Critique R1]
- [ ] CHK028 Is the 422 error code `currency_code_immutable_in_f2` documented with the exact response envelope including `current_currency_code`, `attempted_currency_code`, `non_deleted_plan_count`, and the remediation pointer? [Completeness, Contracts §13–§14]
- [ ] CHK029 Is the integer minor-units pattern specified consistently across all money fields — `annual_fee_minor_units`, `min_turnover_minor_units`, `max_turnover_minor_units`, `registration_fee_minor_units` — with no lingering references to a `currency_code` column on `membership_plans`? [Consistency, Critique P3]
- [ ] CHK030 Does the spec specify that VAT calculations MUST operate in integer minor units, with no floating-point intermediate values, and is this traceable to Constitution Principle IV? [Clarity, Research §6, Plan §IV]
- [ ] CHK031 Is the allowed-ISO-4217-currency list defined explicitly (allow-list enforcement) with specific tokens, or is it left as "some currencies"? [Clarity, Data-model §2.4]

## Role-Based Access Control Requirements

- [ ] CHK032 Is the RBAC matrix for plans (admin CRUD, manager read-only, member blocked) specified with one entry per role × resource × action, not as prose? [Completeness, Research §3]
- [ ] CHK033 Is the manager role's read-only access to `tenant_fee_config` specified with explicit "no edit UI" requirement, not left as an implementation detail? [Clarity, Spec FR-017]
- [ ] CHK034 Is the member role's denial-of-access requirement paired with the URL-probe redirect-without-leak rule? [Coverage, Spec FR-029]
- [ ] CHK035 Is the rule *"cross-tenant probe response MUST be 404 not 403, AND MUST NOT leak existence"* reconciled with the RBAC "403 forbidden" response on role denial? Are the two cases distinguishable in the contract? [Consistency, Contracts §2 + §14]

## Secrets, Logging & Forbidden Patterns

- [ ] CHK036 Are the "forbidden fields in logs" (passwords, session IDs, tokens, Authorization headers, tenant slugs beyond a hash) inherited from F1's logging policy documented as applicable to F2, not silently assumed? [Traceability, Plan §VII]
- [ ] CHK037 Is `TENANT_SLUG` environment-variable handling specified — specifically, the zod validator in `src/lib/env.ts` must refuse empty / invalid values at boot? [Clarity, Quickstart §1]
- [ ] CHK038 Is `DEBUG_RLS_STATE=true` explicitly documented as dev-only, with a production-env assertion that refuses to boot if the flag is set in production? [Edge Case, Research §2.5, Quickstart §8.1]

## Traceability to Constitution v1.4.0 Principle I

- [ ] CHK039 Can every one of Principle I's five sub-clauses (app-layer, db-layer, test, audit, super-admin) be traced to a specific requirement in the F2 artefacts? [Traceability, Plan §I]
- [ ] CHK040 Is clause 5 (super-admin impersonation) explicitly marked as "N/A in F2 — no super-admin console exists; F13 will add this" rather than silently omitted? [Completeness, Plan §I clause 5]

---

## Notes

- Check items off as completed: `[x]`
- Each item is a **test of the requirement's quality**, not of the implementation. Answer "yes / passes" only if the written requirement is itself unambiguous, complete, and internally consistent — not if you can imagine a reasonable implementation.
- Gaps found (items marked failing) require spec/plan/contract edits BEFORE `/speckit.tasks` for tenant-isolation items (CHK001–CHK015 + CHK039) because they are blocker-class per Constitution v1.4.0 Principle I.
- Non-blocker items (clarity / consistency) can be captured as follow-up spec edits during `/speckit.review` passes without gating `/speckit.tasks`.

**Target pass rate for `/speckit.ship`**: 40/40 (100%). F2 is solo-maintainer territory — the staff-review agent and the maintainer co-sign this checklist at the security-review stage of `/speckit.ship`, same pattern as F1.
