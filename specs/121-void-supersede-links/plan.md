# Implementation Plan: Void-on-reissue supersede links ("Replaced by" / "Replaces")

**Branch**: `claude/vibrant-lovelace-oj4u5e` | **Date**: 2026-09-24 | **Spec**: this file (small feature, spec folded in below)
**Input**: follow-up to `106-void-on-reissue` (`docs/runbooks/void-on-reissue.md`, flag `FEATURE_VOID_ON_REISSUE` ON in prod)

## Summary

When a membership reactivation bill issues with `FEATURE_VOID_ON_REISSUE` on,
`issueMembershipBill` supersede-voids the member's strictly-older outstanding
new-flow bill through the manual `voidInvoice` use-case. Its `invoice_voided` audit
row carries `payload.superseded_by_invoice_id` (snake_case in storage; the use-case
input field is `supersededByInvoiceId`). Nothing reads it, so staff and members see a
bare "Void" with no pointer to the bill that replaced it.

This feature adds a **read path** and renders it in both directions:

| Surface | On the voided (old) bill | On the replacement (new) bill |
|---|---|---|
| Admin `/admin/invoices/[id]` | dashed "Replaced by **SC-…** · issued {date}" row inside the Voided section | "Replaces **SC-…**" field in the details grid |
| Portal `/portal/invoices/[id]` | "This bill was replaced by **SC-…** · issued {date}" inside the void block | "Replaces **SC-…**" line on the details card |

A manual void (no `superseded_by_invoice_id`) shows nothing new.

### Acceptance scenarios (each has a RED-first test — see tasks.md)

1. **AS1** Given an outstanding bill A and a reactivation bill B issued with the flag on,
   resolving A returns `replacedBy = { B.id, B's SC number, B.issue_date }`.
2. **AS2** Resolving B returns `replaces = [A]`.
3. **AS3** A manually voided bill (no `superseded_by_invoice_id`) resolves to
   `replacedBy = null` and appears in no `replaces` list.
4. **AS4** Tenant B can never resolve tenant A's link, in either direction, even when
   tenant B holds an `invoice_voided` row whose payload names a tenant-A invoice id
   (Constitution I.3 — Review-Gate blocker).
5. **AS5** Member scope (portal): a link whose other end belongs to a different member
   is dropped (and logged as an integrity anomaly). A member only ever gets links to
   their own invoices.

## Technical Context

**Language/Version**: TypeScript 5.7+ strict · Node 22 LTS · Next.js 16 App Router · React 19
**Primary Dependencies**: Drizzle ORM · next-intl — **no new npm dependency**
**Storage**: Neon Postgres + RLS + `runInTenant`. Tables read: `audit_log`, `invoices`. Tables written: none. One migration (`0305`) adds two partial expression indexes on `audit_log`.
**Testing**: Vitest unit (use-case branches) · real-Postgres integration `tests/integration/invoicing/invoice-supersession.test.ts`
**Bounded contexts touched**: `src/modules/invoicing` (port + adapter + use-case + barrel), presentation in `src/app/(staff)/admin/invoices/[invoiceId]` and `src/app/(member)/portal/invoices/[invoiceId]`
**Performance Goals**: two index-backed point reads per detail-page view (partial indexes hold only supersede-void rows); no change to the page's p95 budget
**Constraints**: audit log stays the single source of truth; no write-path change to `voidInvoice` / `issueMembershipBill`; money path untouched
**Scale/Scope**: supersede-voids are a small subset of `invoice_voided` rows (one per reactivation)

## Design decision — where the link is read from

**Chosen: read `audit_log` directly, backed by two partial expression indexes (migration 0305).**

```sql
-- forward: voided invoice → its replacement
CREATE INDEX audit_log_invoice_superseded_fwd_idx
  ON audit_log (tenant_id, (payload->>'invoice_id'))
  WHERE event_type = 'invoice_voided' AND (payload->>'superseded_by_invoice_id') IS NOT NULL;
-- reverse: replacement → the invoice(s) it superseded
CREATE INDEX audit_log_invoice_superseded_rev_idx
  ON audit_log (tenant_id, (payload->>'superseded_by_invoice_id'))
  WHERE event_type = 'invoice_voided' AND (payload->>'superseded_by_invoice_id') IS NOT NULL;
```

Existing indexes checked: `audit_log_tenant_event_ts_idx (tenant_id, event_type, timestamp DESC)`
narrows to a tenant's `invoice_voided` rows but then filters every one of them on a JSON
key; `audit_log_member_id_idx` / `audit_log_member_timeline_idx` are keyed on
`member_id`; `audit_log_overdue_once_per_day` is keyed on `invoice_id` but partial on
`invoice_overdue_detected`. None serves either lookup directly. The two new indexes are
partial on the supersede predicate, so they contain only supersede-void rows: tiny,
and only those writes pay the maintenance cost.

The lookup joins `invoices` on `(tenant_id, invoice_id)` to fetch the other end's
display number (`COALESCE(bill_document_number_raw, document_number)`), `issue_date`,
`member_id` and `status`. Both halves carry an explicit `tenant_id = $tenant`
predicate **and** run inside `runInTenant` (FORCE RLS). The explicit predicate is not
redundant for `audit_log`: its policy also admits `tenant_id IS NULL` (F1 identity)
rows.

Non-concurrent `CREATE INDEX` inside the migration transaction follows the
`0021_audit_overdue_idempotency.sql` precedent (drizzle wraps each migration in a tx;
`audit_log` volume is low). The same file records the runbook step for a CONCURRENTLY
rebuild if volume ever makes the lock visible.

### Rejected alternative — `invoices.superseded_by_invoice_id` column

A nullable FK written in the supersede-void transaction and backfilled from audit
would make the lookup a plain column read, but:

- it creates a **second source of truth** that can drift from the append-only audit row;
- it changes the money write path (`applyVoid`, the `invoices_enforce_immutability`
  trigger surface on a terminal `void` row) for a read-only UI feature;
- the backfill still needs the same JSON scan once, and a reverse lookup still needs
  its own index.

The index-only approach adds no write-path risk and keeps the audit log authoritative.

## Constitution Check

*Source: `.specify/memory/constitution.md` v1.4.2*

**NON-NEGOTIABLE**

- [x] **I. Data Privacy & Security** — No new PII: the link exposes an invoice id, its
      bill number and issue date, all of which the viewer can already see on the other
      invoice. Admin page keeps its `requirePagePermission('invoicing.read')` guard;
      portal keeps `requireSession('member')` + the `getInvoice` member-ownership check,
      and the new read adds a **member-scope filter** (AS5) so a portal link can never
      point at another member's invoice. **Tenant isolation**: both queries run inside
      `runInTenant(ctx, tx => …)` using that `tx`, with an explicit `tenant_id` predicate
      on `audit_log` and on the joined `invoices` row (app layer) plus FORCE RLS (DB
      layer). Cross-tenant integration test AS4 is in tasks.md. No new table → no new
      RLS policy. The deny path is a silent "no link" (the page already emitted its
      `invoice_cross_tenant_probe` for a foreign invoice id via `getInvoice` before this
      read runs; the link read never takes a user-supplied id other than that one).
- [x] **II. Test-First** — AS1–AS5 integration tests + unit tests for the use-case
      branches are written and observed RED before the adapter/use-case exist.
- [x] **III. Clean Architecture** — Port `InvoiceSupersessionReadPort` (Application),
      adapter `invoiceSupersessionAdapter` (Infrastructure, Drizzle-only),
      use-case `getInvoiceSupersession` + deps factory `makeGetInvoiceSupersessionDeps`,
      exported through `src/modules/invoicing/index.ts`. Pages import only the barrel.
- [x] **IV. PCI DSS** — Not touched (no payment data).

**Core**

- [x] **V. i18n** — New keys under `admin.invoices.detail.voidDetails.*`,
      `admin.invoices.detail.fields.replaces`, `portal.invoices.detail.void.*`,
      `portal.invoices.detail.fields.replaces` in EN + TH + SV. Dates via the existing
      locale-aware formatters (BE display-only for `th`), `issue_date` UTC-pinned like
      the surrounding fields.
- [x] **VI. Inclusive UX** — Links are real `<Link>`s with persistent underline (WCAG
      1.4.1), mono number, single-column at 320 px; dashed border is decorative, the
      text carries the meaning.
- [x] **VII. Performance & Observability** — Two index-backed point reads per view; a
      failed read is logged (`errKind`) and the row is hidden, never a 500.
- [x] **VIII. Reliability** — Read-only; `Result` return, graceful degrade on failure.
      No transactional boundary changes, no audit events added.
- [x] **IX. Code Quality** — strict TS, ESLint clean, Conventional Commits; reviewers:
      financial-integrity-reviewer, security-engineer (portal exposure),
      drizzle-migration-reviewer (0305).
- [x] **X. Simplicity** — One port with two methods, one use-case. No column, no
      backfill, no new audit event.

## Project Structure

```text
specs/121-void-supersede-links/{plan.md,tasks.md}

src/modules/invoicing/
├── index.ts                                                   # + barrel exports
├── application/ports/invoice-supersession-port.ts             # NEW port
├── application/use-cases/get-invoice-supersession.ts          # NEW use-case
├── application/invoicing-deps.ts                              # + makeGetInvoiceSupersessionDeps
└── infrastructure/adapters/invoice-supersession-adapter.ts    # NEW Drizzle adapter

src/app/(staff)/admin/invoices/[invoiceId]/page.tsx            # Replaced by / Replaces
src/app/(member)/portal/invoices/[invoiceId]/page.tsx          # Replaced by / Replaces
src/i18n/messages/{en,th,sv}.json

drizzle/migrations/0305_audit_log_invoice_supersede_idx.sql + meta/_journal.json

tests/unit/invoicing/get-invoice-supersession.test.ts
tests/integration/invoicing/invoice-supersession.test.ts
```

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Two partial expression indexes on `audit_log` (non-concurrent build) | Point lookups on a JSON key in both directions without scanning every `invoice_voided` row of a tenant | Relying on `audit_log_tenant_event_ts_idx` alone scans and JSON-filters all of a tenant's void rows on every detail view; a denormalised `invoices` column duplicates the audit truth and touches the money write path (see Design decision) |
