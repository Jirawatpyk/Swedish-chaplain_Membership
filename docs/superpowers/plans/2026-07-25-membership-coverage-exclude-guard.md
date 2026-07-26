# Membership-bill coverage + GiST EXCLUDE guard — Implementation Plan

> **For agentic workers:** the always-on read-guard (107 `findLiveMembershipBill`) CANNOT be made correct (two adversarial design+red-team rounds both found a critical double-bill OR a mass wrong-refusal of migrated members). Root cause: `invoices` never stored the TRUE charged coverage window, so any read-guard approximates → under-blocks (double-bill) or over-blocks (refuses legit renewals). This plan replaces the approximation with a **persisted coverage window + a Postgres GiST EXCLUDE constraint** — the one mechanism that closes all four holes uniformly at INSERT time, path-agnostic, concurrency-safe, orphan-safe.

**Goal:** No two live, not-fully-reversed membership §86/4 documents may cover the same (tenant, member, coverage period) — enforced by the DB, not application code.

**Why the DB (not a guard):** the double-bill exposure already exists on `main` (no guard at all) and 107's guard is broken both ways. A GiST EXCLUDE constraint rejects the second overlapping INSERT with SQLSTATE `23P01` regardless of which of the 3 mint paths runs, under any concurrency, with no advisory lock.

## Global Constraints
- Money/tax LIVE-PROD: a double-bill double-remits 7% output VAT in ภ.พ.30. Correctness > speed.
- The true charged window is ALREADY computed at every mint as `membershipCoverage = { kind:'window', fromIso, toIso }` (confirm-renewal.ts:797 & auto-draft:501 = `[periodTo, periodTo+term)`; admin-renew:551 = `[periodFrom, periodTo)`; first_payment/erased OMIT it → `{kind:'from_payment'}` → NULL coverage). Persist THAT verbatim; never recompute a different window.
- `btree_gist` is available (v1.7) but not installed → `CREATE EXTENSION IF NOT EXISTS btree_gist` in the migration.
- Migration numbering: next free on this branch = **0281** (107 occupies 0274–0280). `when` strictly after 0280. DON'T `db:migrate` the shared `dev` branch (has both schemas). Test on a FRESH Neon branch.
- Two-layer tenant isolation: every new repo read threads the `runInTenant` tx, never pool-global `db`. Mandatory cross-tenant integration test.
- Tests that MUST pass after: `confirm-renewal-anchored-plan-year-pin`, admin-renew `refunded frontier`. MUST keep refusing: admin-renew `107-T9` (line 768), issueAutoDrafted `(d)` (line 363).

---

## Coverage & blocking rules (the spec the constraint encodes)
- `coverage_from`/`coverage_to timestamptz NULL`: stamped = `membershipCoverage.fromIso/toIso` when `kind='window'`; NULL for `from_payment` (first-payment/erased) shapes.
- A bill **blocks** iff: `coverage_from IS NOT NULL` AND it is a live, not-fully-reversed membership document — status ∈ {`draft`,`issued`,`paid`,`partially_credited`} OR (`credited` AND a retains-coverage credit note exists, mirroring `coverageRetainedExistsSql`). `void` and fully-`credited`-without-retains never block (re-billable). Event invoices (`plan_id IS NULL`) never block.
- The EXCLUDE forbids two blocking rows for the same `(tenant_id, member_id)` whose `tstzrange(coverage_from, coverage_to, '[)')` overlap (`&&`).

## File structure
- `drizzle/migrations/0281_membership_coverage_exclude.sql` (NEW) — extension, columns, generated/maintained `blocks_coverage`, EXCLUDE `NOT VALID`.
- `src/modules/invoicing/infrastructure/db/schema-invoices.ts` — add `coverageFrom`/`coverageTo`/`blocksCoverage` columns.
- `src/modules/invoicing/application/use-cases/create-invoice-draft.ts` — persist coverage window on the membership-draft insert (already has `input.membershipCoverage`).
- `src/modules/invoicing/**` mint/issue path — map PG `23P01` on the invoices EXCLUDE → the existing `invoice_already_exists`/`duplicate_live_bill` domain error.
- `scripts/backfill-membership-coverage.ts` (NEW) — recompute coverage for existing membership bills; orphans → NULL (never block retroactively) + report.
- `src/modules/renewals/application/use-cases/_lib/live-membership-bill.ts` + confirm-renewal / admin-renew / issue-auto-drafted — REMOVE the broken plan_year read-guard (or demote to a friendly pre-check that defers to the constraint); keep the refusal-mapping.

## Phases (each ends testable)
1. **Migration + schema columns** (no behavior yet): extension, `coverage_from/to`, `blocks_coverage` (maintained via generated column or trigger from status+coverage), EXCLUDE `... NOT VALID`. Apply on a fresh Neon branch; assert it creates.
2. **Persist coverage at mint**: `create-invoice-draft` writes `coverage_from/to` from `input.membershipCoverage`; `blocks_coverage` follows status. Unit + contract tests.
3. **Map 23P01 → domain error** in the mint/issue path so a blocked INSERT returns `invoice_already_exists`/`duplicate_live_bill` (not a 500). Integration test: two overlapping mints → second returns the domain error.
4. **Remove the broken read-guard** from the 3 use-cases; the constraint is now the authority. Re-run: anchored-pin + refunded-frontier PASS; 107-T9 + issueAutoDrafted(d) still refuse (now via 23P01).
5. **Backfill** existing membership bills' coverage (recompute cycle-linked from linked cycle + term; orphans/first-payment → NULL). Then `ALTER TABLE ... VALIDATE CONSTRAINT` in a SEPARATE migration/step guarded to detect pre-existing overlaps (report, don't crash prod deploy).
6. **Verify + adversarial review**: fresh-branch integration suite green; re-red-team the constraint approach; cross-tenant isolation test.

## Operational / rollout notes
- Constraint ships `NOT VALID` so deploy never blocks on legacy overlaps; `VALIDATE` runs after backfill + overlap-report. If prod has real pre-existing overlapping live bills (double-bill from the no-guard era), surface them for human resolution before VALIDATE.
- First-payment double-bills (both NULL coverage) are NOT caught by this constraint — pre-existing, tracked separately (rare; different code path).
- This fix benefits `main` too (closes the pre-existing no-guard double-bill on the manual paths), independent of 107.
