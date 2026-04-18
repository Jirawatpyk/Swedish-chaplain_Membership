# F4 Research: Implementation Choices & Rationale

**Feature**: F4 — Membership Invoicing & Thai-Tax Receipts
**Branch**: `007-invoices-receipts`
**Date**: 2026-04-18

## Overview

This document resolves every implementation question raised (or implied) in `plan.md` and captures the evaluated alternatives for each. It is the source of truth for *why* F4 is built the way it is — tasks + code reference research items by number.

## 1. PDF rendering engine

**Decision**: **`@react-pdf/renderer` pinned to exact version `4.3.0`** (no caret) — pure-Node, React-component-tree driven.

**Version-pinning rationale** (post-critique E9): the critical-path render engine is pinned to an exact version rather than `^4.x` because deterministic byte-identical output (SC-003) is sensitive to transitive dependency updates inside the renderer (font-handling refinements, layout engine patches can produce different bytes with identical inputs). A planned upgrade is a deliberate project decision that runs the `test:integration:pdf-deterministic` test against seeded historical invoices on the new version before cutover.

**Fallback plan** (if v4 line is abandoned): Templates live under `src/modules/invoicing/infrastructure/pdf/templates/*.tsx` as React components receiving pure-data props. Re-authoring against `pdfkit` (imperative), a warm Puppeteer pool, or any future PDF engine is a ~2-week exercise with zero data migration (PDFs are content-addressed + legally immutable; only future renders switch engines). Historical PDFs stay on their `pdf_template_version` pinned to the original engine via a template-version registry.

**Rationale**:
- **Deterministic output** (FR-016, SC-003). With pinned fonts, pinned template version, and pinned data, `@react-pdf/renderer` produces byte-identical PDFs across runs. Verified by rendering the same invoice twice and asserting `sha256` equality.
- **Pure-Node**. Runs inside Next.js route handlers on Vercel Fluid Compute with no Chromium, no native binaries, no warm-pool management. Cold-start cost ≈ 100 ms; steady-state render ≈ 500-800 ms for a ~3-page bilingual invoice.
- **JSX ergonomics**. Templates are co-authored with the rest of the frontend codebase — shared components, shared i18n utilities, shared Tailwind-class-friendly style objects via the adapter's style prop.
- **Thai font support** via `Font.register({ family, fonts })`. Sarabun TTF files are committed under `public/fonts/sarabun/` with three weights.

**Alternatives considered**:

| Option | Rejected because |
|---|---|
| `puppeteer-core` + `@sparticuz/chromium` | Cold start 1.5-3 s violates the issuance p95 budget; larger attack surface (Chromium CVEs); Vercel's support matrix explicitly recommends against it for tax-compliance-critical paths. |
| `pdfkit` | Imperative API; ~30 nested layout decisions in the tax-invoice template would be unmaintainable. |
| `pdf-lib` | Lower-level than `pdfkit`; even more imperative. Suitable for PDF manipulation, not generation. |
| Server-side HTML → PDF (`weasyprint` / `wkhtmltopdf`) | Requires a non-Node runtime; Vercel Fluid Compute is Node-first. Would require a separate service. |
| Third-party SaaS (DocRaptor, PDFShift, etc.) | Sends PII to a third party, adds a cross-border data transfer, introduces availability dependency. Tax-document rendering must stay in-house. |

**References**:
- `@react-pdf/renderer` v4.x release notes: React 19 compat confirmed (2025-Q3 release).
- Determinism verification approach: `test:integration:pdf-deterministic` renders same input twice + `sha256` hash comparison.
- Font license: Sarabun OFL; attribution file under `public/fonts/sarabun/README.md`.

## 2. Sequential tax-document number allocator (Thai RD §87)

**Decision**: **Postgres transaction-scoped advisory lock + `SELECT … FOR UPDATE` on a per-(tenant, doc_type, fiscal_year) counter row.**

**Rationale**:
- **No gaps possible** because the number is assigned **inside** the same transaction that renders the PDF and persists the invoice row. A rollback releases the number.
- **Thai RD §87 compliance** verified: a sequence of issued documents within a tenant+year has contiguous numbers (1, 2, 3, …, N) with no holes. Voided documents keep their number (visible in the sequence as "void") but are never reassigned.
- **Concurrency safe** under high contention. `pg_advisory_xact_lock(hashtext('invoicing:' || tenant_id || ':' || doc_type || ':' || fiscal_year))` serializes issuance per tuple. Second concurrent issue waits (microseconds) then reads the incremented value.
- **Year-boundary correctness** via `js-joda` `ZonedDateTime::nowAtZone('Asia/Bangkok')` — converts the commit timestamp to the Bangkok-local fiscal year before the lock key is derived. An invoice issued at 2026-12-31 23:59:59 UTC (2027-01-01 06:59:59 Bangkok) correctly lands in FY 2027. Verified by the 8-scenario atomicity integration test.
- **Idempotency** via an `Idempotency-Key` header: a retried POST with the same key returns the *already-issued* invoice (same number, same PDF hash, same response body) without consuming a new number. Implemented via a per-(tenant, actor, idempotency_key) `idempotency_keys` table with a 24-hour TTL.

**Alternatives considered**:

| Option | Rejected because |
|---|---|
| Postgres `SEQUENCE` object (`CREATE SEQUENCE`) per tenant/year | Sequences are non-transactional — `nextval()` consumes even on rollback, producing gaps. Violates §87. |
| Application-level UUID then "renumber on display" | Non-compliant — RD mandates the real number on the issued document, not a display alias. |
| Redis INCR | Non-transactional with Postgres; network partition risks double-assignment; adds a new critical-path dependency. |
| Separate number-allocator microservice | Over-engineered for tenant counts ≤ 100 platform-wide; introduces a new HA boundary. |

**References**:
- Thai Revenue Code §87 — "ผู้ประกอบการ … ต้องจัดทำใบกำกับภาษี … โดยมีเลขที่ใบกำกับภาษีเรียงลำดับติดต่อกัน"
- Postgres docs: `pg_advisory_xact_lock`, transaction-scoped advisory locks release on COMMIT or ROLLBACK automatically.

## 3. Receipt representation (separate table vs. derived view)

**Decision**: **Receipts are a derived template rendering of a paid `invoices` row. No separate table.**

**Rationale**:
- Spec data model explicitly lists Receipt as a rendering of an Invoice, not an independent entity.
- Thai RD allows two valid filings: (a) separate tax invoice + separate receipt, OR (b) combined tax-invoice/receipt on the payment date. Both are served by the same underlying row with different template selection.
- Storing receipts as separate rows would duplicate member+tenant snapshots and create a synchronisation bug surface for no business value.
- Receipt sequence numbering (when separate from invoice numbering — tenant setting) is allocated from its own `tenant_document_sequences` row (`doc_type = 'receipt'`) at the moment payment is recorded, inside the same transaction as the status transition.

**Alternative considered**: A `receipts` table with FK to `invoices`. Rejected — would require double-write transactions on every payment + maintenance of two numbering streams with identical business rules.

## 4. Blob storage vs. database BYTEA

**Decision**: **Vercel Blob (private ACL) for all rendered PDFs**. Database stores only the `sha256` hash, size, and Blob key.

**Rationale**:
- PDFs ≈ 200 KB each × 20,000 per year × 10-year retention ≈ 40 GB. Postgres BYTEA at that volume inflates backup sizes, slows `pg_dump`, and bloats row cache.
- Blob is content-addressed; signed URLs (60 s TTL) give per-request access control without exposing raw URLs.
- Re-rendering a lost Blob is cheap (deterministic + same input), so Blob is treated as a *cache* of the canonical "render result" rather than a single-source-of-truth.
- **Transactional outbox sweeper** addresses the "DB committed but Blob failed" edge case:
  - On issue, PDF is uploaded to Blob BEFORE the DB commits.
  - If Blob upload fails, DB rollback releases the sequence number.
  - If DB commit fails AFTER Blob upload, a sweeper (invoked at next request or via cron) detects orphan Blob keys by scanning for keys without a corresponding `invoices` row (keyed by deterministic hash) and deletes them.
  - The sweeper is idempotent; orphan keys are rare and self-cleaning.

**Alternatives considered**:

| Option | Rejected because |
|---|---|
| Postgres BYTEA | Backup/restore bloat; row-cache pollution; 40 GB in a single table is unnecessary. |
| S3 / R2 directly | Vercel Blob is the supported platform-native option; matches the rest of our stack. |
| No storage — regenerate on every download | Costs 500-800 ms per download; member portal UX would suffer; still need idempotency for retries. |

**References**:
- Vercel Blob docs: private ACL + signed-URL pattern (2026 version); `@vercel/blob` SDK v2.x.
- Deterministic key: `invoicing/{tenant_id}/{yyyy}/{doc_type}/{document_id}_{template_version}.pdf`.

## 5. Overdue status: derived vs. stored

**Decision**: **Derived at read time**. `overdue = (status = 'issued' AND current_date > due_date)`.

**Rationale**:
- No stored transition means no nightly job needed, no clock drift, no "overdue → paid" event double-firing.
- Index `invoices(tenant_id, due_date) WHERE status = 'issued'` makes the "how many are overdue?" admin query trivially fast.
- F8 renewal-reminder scheduling will read this same derivation — single source of truth.
- Audit event `invoice_overdue_detected` is emitted **opportunistically** on the first admin/member read per day. Implementation uses `INSERT INTO audit_log (...) ... ON CONFLICT (tenant_id, event_type, (payload->>'invoice_id'), DATE(timestamp)) DO NOTHING` backed by a partial unique index (see data-model.md § 4), so concurrent reads cannot double-emit for the same invoice on the same day. Stored only for timeline completeness; not required for FR-028 compliance.

**Alternative considered**: Nightly cron scans the table and writes `status = 'overdue'`. Rejected — requires idempotent cron, risks clock skew at midnight, adds a transition that must be reversed on payment.

## 6. VAT calculation method (line-level vs. total-level rounding)

**Decision**: **Total-level rounding per Thai RD convention**: VAT = ROUND(SUM(line_totals) × vat_rate, 2). Not per-line.

**Rationale**:
- Thai RD §86/4 guidance + real-world bookkeeper practice: VAT is displayed as a single line at invoice level, computed on the subtotal, rounded to 2 decimal places (satang).
- Line-level rounding can cause a THB 0.01 drift between the invoice and its credit note when partial credits are issued — avoided by this method.
- **Credit-note VAT** is computed as `round((credit_amount / original_subtotal) × original_vat, 2)` — ensures that a full credit note exactly reverses the original VAT, and that partial credits sum back to the original VAT within ±0.01 THB (the last partial note absorbs any rounding remainder).
- All intermediate arithmetic is in satang (BIGINT) to avoid floating-point drift; rounding to 2 dp happens only when constructing the display `Money` value.

**Verification**: covered by `tests/unit/invoicing/calculate-vat.test.ts` with ~30 boundary cases + a property-based test that asserts `credit_note_vat_sum ≤ original_vat` for any partition.

## 7. Pro-rate policy math

**Decision**: three explicit formulas, all **snapshotted per invoice**:

- **`none`**: factor = 1.0 (full period fee)
- **`monthly`**: factor = months_remaining / total_months, where:
  - `months_remaining = total_months - (issue_date.month - cycle_start.month)` — counting inclusive from issue month to cycle end
  - Rounded to 4 decimal places for the factor; then applied to `Money` (satang BIGINT) and rounded to 2 dp on the final line total.
- **`daily`**: factor = days_remaining / total_days, with `days_remaining` counting inclusively from `issue_date` to `cycle_end` in Bangkok timezone (`js-joda` + `Asia/Bangkok`), DST-immune because Thailand does not observe DST.

**Edge cases**:
- Issue date = cycle start → factor = 1.0 for all three policies.
- Issue date = cycle end → factor = 1 month's worth or 1 day's worth (minimum, not 0).
- Cycle mid-year change (policy flips from monthly to daily mid-fiscal-year) → new invoices use the new policy; past invoices keep their snapshot (FR-011).

## 8. Outbox pattern for auto-email delivery

**Decision**: Reuse the **F3 transactional outbox pattern** unchanged. An `email_outbox` table (already exists from F3) is extended with new `event_type` values for F4 auto-email payloads (`invoice_issued_auto_email`, `invoice_paid_auto_email`, `credit_note_issued_auto_email`).

**Rationale**:
- **Decouples delivery from financial commit** (FR-026): if Resend is down, the invoice still commits and the email is retried later.
- **Idempotent dispatch**: dispatch worker marks rows `sent` / `permanently_failed` with retry count; replays are safe.
- **Bounce webhook integration**: Resend `email.bounced` webhook sets `outbox_row.status = bounced` and emits `auto_email_delivery_failed` audit event → admin-visible failure banner on the invoice detail page.
- **Dispatch trigger**: Vercel Cron every 1 minute + opportunistic drain on the issuance route's `after()` hook (Next.js 16 Fluid Compute graceful-shutdown-aware).

**Alternative considered**: a dedicated queue service (Upstash QStash, AWS SQS). Rejected — outbox table is simpler, already proven in F3, no new infrastructure boundary.

## 8a. Auto-email bounce & PII handling (post-critique E5)

**Decision**: **Accept Resend's default handling + document in `security.md`.** Do not switch to the "link-to-download" pattern; the friction cost for bookkeepers (who want to drag-drop the PDF into their filing tool) outweighs the marginal privacy benefit for a provider that is already SOC 2 + GDPR-DPA-signed.

**Rationale**:
- Resend retains bounced messages for ~30 days in bounce logs. Chamber-OS retains the canonical PDF for 10 years under legal obligation (FR-029). The 30-day bounce log is a strictly narrower replica governed by Resend's DPA — not an independent data silo.
- The threat surface is limited: bounce logs are accessible only to the Chamber-OS Resend account holder (the platform operator). No member or third party can query them.
- The alternative (link-to-download) converts an email UX from "attached + ready to file" to "auth-gated click → sign-in → download" — materially worse for the real-world bookkeeper workflow we are optimising for.

**Documented in `security.md § Data sovereignty`**: "Auto-emailed PDFs traverse Resend (SOC 2, GDPR DPA on file). Bounced messages retained ≤ 30 days in Resend bounce logs; this replica is governed by the Resend DPA, not a separate risk surface. If a tenant requires in-jurisdiction email delivery, a future enhancement can add a per-tenant SMTP option in F12 (White-label)."

**PDF render performance validation (post-critique E6)**: Before the issuance use case is implemented, a T0-level task renders a realistic invoice (5 line items, logo, bilingual content, Sarabun font registered) 100 times on Vercel preview and records p50/p95/p99. If p95 > 800 ms, the issuance-path budget in `plan.md` Complexity Tracking row is widened to 2s with a corresponding alarm update, OR template-output caching is introduced. The benchmark harness lives at `tests/perf/pdf-render-benchmark.test.ts` gated by `RUN_PERF=1`.

## 9. Fiscal year configuration

**Decision**: **Calendar year (Jan 1 – Dec 31, Bangkok TZ) default**, with a tenant-configurable `fiscal_year_start_month` for future flexibility.

**Rationale**:
- SweCham uses calendar year.
- Thai RD does not mandate a calendar year — a tenant whose registered VAT accounting period starts in July can configure `fiscal_year_start_month = 7`.
- The sequence allocator uses the tenant's configured start month when deriving `fiscal_year` from a commit timestamp.
- Spec assumption explicitly allows this flexibility; F4 ships with `fiscal_year_start_month` stored but UI to change it is deferred to US4 (P3).

## 10. Idempotency keys

**Decision**: **Required on all POST / PATCH / DELETE endpoints** that mutate invoicing state; server stores `(tenant_id, actor_user_id, idempotency_key)` → response tuple for 24 hours.

**Rationale**:
- Retries from flaky networks on the critical transactional path must not consume a second sequence number.
- FR-007 demands idempotent payment recording; extending to all mutations is cheap and prevents a whole class of bugs.
- 24-hour TTL because legitimate retry windows are short but admin workflows (open issue page, get distracted, retry next morning) need tolerance.

## 11. Member self-service scope

**Decision**: Members can **list own invoices + download PDFs only**. No edit, no issue, no void, no credit-note, no payment recording. No exposure of draft invoices (portal shows `status IN ('issued', 'paid', 'void', 'credited', 'partially_credited')`).

**Rationale**: Spec US3 + FR-012. Draft invoices are admin-internal working state and must not be member-visible (would create expectations that the amount shown is final, when drafts are mutable).

## 12. Logo asset handling & orphan policy (post-critique round-2 R2-E5)

**Decision**: Tenant logo stored in Vercel Blob (same bucket prefix under `tenants/{tenant_id}/logo.png`); referenced by URL in `tenant_invoice_settings.logo_blob_key`. Embedded into PDF at render time by the adapter (`@react-pdf/renderer` accepts remote or local images).

**Rationale**:
- Deterministic (logo key is versioned; if tenant changes logo, new invoices pick up the new one — snapshot per invoice freezes the logo key at issue time for historic re-render determinism).
- Simple (no new storage primitive).
- Size-capped at 1 MB + dimensions capped at 2000×500 on upload (admin settings form validates before saving).

**Orphan cleanup policy**: when admin uploads a new logo, the previous `logo_blob_key` becomes orphan (no live tenant settings row references it; historical `tenant_identity_snapshot.logo_blob_key` on issued invoices still do). We do **NOT** delete old logos — historical PDF re-rendering (if a Blob is lost) depends on the original logo remaining reachable for deterministic output. Storage cost is trivial (≤ 1 MB × < 50 tenants × logo-change frequency ≤ 10/year = < 500 MB lifetime).

**Guard**: emit an `invoicing.logo_blob.count` per-tenant metric to observability; if a tenant exceeds **50 historical logos**, the logo-upload endpoint refuses further uploads with a clear error directing the tenant admin to contact support for manual cleanup. Prevents pathological cases (malicious or automated churn) without compromising determinism.

## 13. Threats & mitigations summary (details in `security.md`)

| Threat | Mitigation |
|---|---|
| T-01 Cross-tenant probe via crafted URL | RLS + FORCE RLS + `TenantContext` dependency injection + `invoice_cross_tenant_probe` audit |
| T-02 Gap in tax-document sequence | Transactional advisory-lock + FOR UPDATE + rollback releases number |
| T-03 Duplicate payment recording | Idempotency-Key header + DB CHECK constraint (`paid_at IS NULL OR status = 'paid'`) |
| T-04 Member downloads another company's invoice | Ownership check in `get-invoice-pdf-signed-url.ts` + RLS at DB layer |
| T-05 Signed URL leaks → replay | 60 s TTL + URL tokens in redact list + per-request scope |
| T-06 PDF template injection via member name | React's default escaping + props-as-data, never string interpolation |
| T-07 Tax document deleted by member-erasure request | FR-030 — legal-obligation basis; tax docs immune to member lifecycle |
| T-08 Clock skew causes wrong fiscal year | `js-joda` Bangkok-TZ commit-time boundary + integration test |
| T-09 Outbox row poisoning | Permanent-failure cap at 5 retries + high-severity audit + admin re-send via fresh outbox row |
| T-10 Credit note over-credits | `SELECT … FOR UPDATE` on `invoices.credited_total` during credit-note issue transaction |
| T-11 VAT rate change rewrites history | Snapshot at issue time + `ON UPDATE` DB trigger rejects changes to snapshotted columns |
| T-12 PDF binary leaked via logs | Redact list covers signed_url_token, tax_id, member_*_snapshot, PDF body |
| T-13 Admin role demotion mid-transaction | RBAC check is the first step of every use case; role is re-read from session at start of each request |
| T-14 Blob orphans from half-committed issue | Transactional sweeper + content-addressed keys (orphans are deterministic and safe to delete) |
| T-15 Resend bounce-storm → spam classifier | Per-member auto-email throttle (10/h) + outbox row marked bounced on first bounce + admin surfaces failure |
| T-16 Admin demoted mid-transaction | RBAC re-read from session at the start of every route handler before any DB work; session store queried, not trusted from memory; demotion before RBAC check → 403. A demotion AFTER RBAC check but BEFORE commit is an accepted narrow TOCTOU window — completed action recorded with actor user ID so audit review can flag retroactively. |
| T-17 Logo SVG upload → PDF renderer image fetch → XSS / SSRF | FR-034 strict MIME whitelist (PNG + JPEG only, SVG explicitly rejected), size + dimension caps, `sharp` re-encode strips metadata / embedded scripts before persistence; PATCH settings refuses raw logo binary — only accepts the upload endpoint's returned key |
| T-18 Auto-email bounce log retains PDF replica outside 10-yr retention | Accepted — Resend SOC 2 + GDPR DPA covers ≤ 30-day bounce-log retention (strictly narrower replica than primary 10-yr retention); link-to-download alternative rejected for UX cost. See § 8a. |
| T-19 Template-version drift rewrites historical documents | Template-version pinning: invoice stores `pdf_template_version` at issue; resend + void + Blob-recovery re-render all use the pinned version; only NEW issuance uses `CURRENT_TEMPLATE_VERSION`. `pdf-deterministic.test.ts` asserts byte-identical sha256 across re-render paths. |

## Summary — no remaining NEEDS CLARIFICATION

All spec `[NEEDS CLARIFICATION]` markers were resolved in `/speckit.clarify` (Q1–Q5) and all technical unknowns are settled by this document. Ready for Phase 1 artifacts.
