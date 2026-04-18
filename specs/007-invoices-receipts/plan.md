# Implementation Plan: F4 — Membership Invoicing & Thai-Tax Receipts

**Branch**: `007-invoices-receipts` | **Date**: 2026-04-18 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/007-invoices-receipts/spec.md`
**Constitution**: [`.specify/memory/constitution.md`](../../.specify/memory/constitution.md) **v1.4.0**
**Predecessors**: F1 Auth & RBAC (PR #1), F2 Membership Plans (`002-membership-plans`), F3 Members & Contacts (`005-members-contacts`)

## Summary

F4 delivers the **fourth Chamber-OS business feature** and the Phase 1 "finish line": an admin can draft, issue, collect manual payment, void, or issue a credit note against Thai-tax-compliant membership invoices, with bilingual (TH + EN) PDFs that satisfy Thai Revenue Department requirements (§86/1, §86/9, §86/10, §87, §87/3). F4 is the first F-stream feature carrying **⚠ Finance** sensitivity (Constitution Principle VIII) and the first to materially exercise the transactional-atomicity guarantees that F1+F2+F3 have laid down.

F4 closes the "invoice history" hand-off left open by F3 spec line 1093 ("Invoice history and payments are out of scope — F4/F5") and extends the F3 member timeline with 6 new financially significant event types. F4 does NOT process online payments — that is F5. F4 records **manually reconciled** payments and generates the legal tax documents.

**Scope confirmed as full-maximal** (per user decision 2026-04-18 — velocity precedent from F3's 3-day delivery makes defer-for-time unnecessary): 7 user stories (US1–US7), **35 functional requirements** (post-critique refinement adds FR-001a draft preview, FR-034 logo-upload hardening, FR-035 document-number overflow guard), 11 success criteria, **8 clarifications resolved** (5 round-1 + 3 round-2 post-critique).

**Technical approach**: Reuse the F1+F2+F3 stack unchanged — Next.js 16 App Router + React 19 + TypeScript 5.7 strict + Drizzle ORM on Neon Postgres + Postgres RLS via `runInTenant(ctx, fn)` + shadcn/ui + Tailwind v4 + next-intl + Vitest + Playwright. Add **one new bounded context** `src/modules/invoicing/` housing three aggregates (`Invoice` root with `InvoiceLine` children; `CreditNote`; `TenantInvoiceSettings`) plus a cross-cutting `SequentialNumberAllocator` domain service. Add **`@react-pdf/renderer`** as the bilingual PDF engine with Thai font (`Sarabun` embedded via the Thai `google-fonts-sarabun` data files pinned at build time). Add an **outbox table + worker** for deferred auto-email delivery of PDFs (same pattern as F3's email-change atomic transaction). Reuse `@/modules/tenants` (`TenantContext`), `@/modules/auth` (session + RBAC), `@/modules/plans` (tier lookup for pricing), `@/modules/members` (member identity snapshot + timeline extension via its public `TimelinePort`). Enterprise UX per `docs/ux-standards.md`; WCAG 2.1 AA on every surface; SV+EN+TH at release; 10-year tax-document retention enforced by a dedicated lifecycle policy distinct from GDPR/PDPA right-to-erasure.

## Technical Context

**Language/Version**: TypeScript 5.7+ strict (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`) — unchanged from F1+F2+F3
**Runtime**: Node.js 22 LTS (Vercel default) — unchanged
**Framework**: Next.js 16 App Router + Cache Components + Turbopack — unchanged

**Primary Dependencies** (new in F4 unless marked):

- **from F1+F2+F3** (unchanged versions): `next@^16`, `react@^19`, `drizzle-orm` + `drizzle-kit`, `next-intl`, `zod`, `react-hook-form` + `@hookform/resolvers/zod`, `shadcn/ui` + `tailwindcss@^4` + `lucide-react`, `next-themes`, `sonner`, `cmdk` (F4 extends palette with Invoices group — smart #4 expansion), `@tanstack/react-table@^8` (F4 reuses the F3 editable-table primitive for the invoice list), `@vercel/otel` + `@opentelemetry/api`, `pino`, `vitest`, `playwright`, `@axe-core/playwright`, `resend` (F4 uses the F1 outbox-backed wrapper for PDF auto-email).
- **new in F4**:
  - **`@react-pdf/renderer@^4`** — React-based PDF engine. Chosen over `pdf-lib` (lower-level), `puppeteer`-style Chromium rendering (heavyweight, slow cold-start on Vercel), and `pdfkit` (imperative, no JSX ergonomics). `@react-pdf/renderer` gives us deterministic byte-identical output (FR-016 / SC-003) when fonts + template + data are pinned, renders in a pure-Node runtime (works in Vercel Fluid Compute without Chromium), and lets us author the template as a React component tree — aligning with the rest of our frontend. See research.md § 1.
  - **Thai font: Sarabun** (Google Fonts, OFL license) — embedded into the PDF at build time. TTF files committed under `public/fonts/sarabun/` with a `README.md` citing the license. Three weights (400, 500, 700) cover the tax-document layout. English fallback: system-safe `Helvetica` (already embedded in `@react-pdf/renderer` core).
  - **`@js-joda/core@^5`** + **`@js-joda/timezone@^2`** — correct fiscal-year boundary handling for the sequential-number allocator (Thailand timezone `Asia/Bangkok` is what determines which fiscal year a given ISO-UTC timestamp belongs to for Thai tax purposes). Chosen over raw `Date` / `Intl.DateTimeFormat` because the allocator's correctness under clock skew + DST + cross-midnight concurrency is the single most tax-compliance-critical code path in F4 (spec Edge Cases § "Clock skew at year boundary"); `js-joda` gives us immutable `LocalDate` / `ZonedDateTime` primitives with total-ordering guarantees and exhaustive timezone data. Used server-side only.
  - **`thai-baht-text@^1`** (~5KB) — converts `12345.67` → `"หนึ่งหมื่นสองพันสามร้อยสี่สิบห้าบาทหกสิบเจ็ดสตางค์"` for the Thai amount-in-words line required by Thai RD on invoices ≥ THB 1 (de facto industry convention, not strictly mandated by §86/4 but expected by all Thai bookkeepers and printed on every commercial invoice we've seen in SweCham's historical Excel workbook). English amount-in-words uses a tiny local helper (`amount-to-english.ts`) — no runtime dependency needed.
  - **`sharp@^0.33`** (pinned exact version) — server-side image re-encoder used by the logo-upload endpoint (FR-034) to strip EXIF / metadata / embedded scripts from tenant-supplied PNG / JPEG logos before Blob persistence. Native binary; Vercel Node runtime ships a compatible build. Any SVG or other MIME is rejected before `sharp` is invoked — `sharp` itself does not handle SVG in our configuration (double defense).
  - **@react-pdf/renderer exact-version pin**: pinned to `4.3.0` (no caret) rather than `^4` — see `research.md § 1` for the determinism + fallback rationale.
  - **shadcn/ui primitives newly installed for F4**: `select` (status filter), `date-range-picker` (issue-date filter), `radio-group` (credit-note full-vs-partial), `badge` (status chips). Existing F1+F2+F3 primitives reused unchanged.
- **rejected** (YAGNI):
  - A headless browser PDF pipeline (`puppeteer-core` + `@sparticuz/chromium` on Vercel Fluid Compute). Rejected because cold-start cost (1.5–3s) violates our p95 budget for the synchronous issue-and-render path (FR-003 transactional requirement) and Vercel does not recommend Chromium for tax-document-critical workloads. Pure-Node `@react-pdf/renderer` delivers deterministic, fast, reliably-sandboxed rendering with no Chromium attack surface.
  - A dedicated number-sequence microservice / separate database. Rejected because Postgres advisory locks + `SELECT … FOR UPDATE` on a single counter row per `(tenant_id, document_type, fiscal_year)` tuple satisfy Thai RD §87 "no gaps" with zero additional infrastructure. See research.md § 2.
  - `libxml2`-based Thai RD e-tax direct submission. Explicitly out of scope per `docs/phases-plan.md` R1 decision.
  - A separate Stripe / PromptPay integration. Explicitly F5.
  - A background queue / job runner for deferred PDF regeneration. Not needed: PDFs are rendered inside the same transaction that assigns the sequential number (FR-003); downstream re-renders (admin downloads) are cached.
  - A separate `receipts` table. Receipts are a **derived view** of paid invoices — the same invoice row transitions `issued → paid` and the "receipt PDF" is a different template rendering the same data. See research.md § 3 + data-model.md § 2.2.
  - A dedicated `auto_email` scheduler service. Reuses the F3 outbox pattern unchanged.

**Storage**:

- Primary: PostgreSQL via Neon `ap-southeast-1` Singapore — unchanged. Adds **four new tables**: `invoices`, `invoice_lines`, `credit_notes`, `tenant_invoice_settings`, plus **one sequence-tracker table**: `tenant_document_sequences` (one row per `(tenant_id, document_type, fiscal_year)` — holds the current max sequence number, updated inside the issue transaction). Extensions to `audit_log` (new event types only — reuses F2's `payload jsonb` column + `tenant_id`).
- Postgres RLS: every F4-introduced table has `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + `USING (tenant_id = current_setting('app.current_tenant', TRUE))` policy, identical to F2+F3 pattern. `runInTenant(ctx, fn)` reused unchanged.
- Indexes (all `CREATE INDEX CONCURRENTLY` outside migration txn):
  - `invoices(tenant_id, status, issue_date DESC)` — admin list + overdue derivation
  - `invoices(tenant_id, member_id, status)` — member page history (US7) + portal list (US3)
  - `invoices(tenant_id, fiscal_year, sequence_number) UNIQUE` — Thai RD §87 no-duplicates, no-gaps enforcement
  - `invoices(tenant_id, due_date) WHERE status = 'issued'` — partial index for overdue query (FR-028)
  - `invoice_lines(invoice_id)` — join to parent
  - `credit_notes(tenant_id, original_invoice_id)` — partial-credit accumulator (FR-022)
  - `credit_notes(tenant_id, fiscal_year, sequence_number) UNIQUE` — §87 for credit-note stream
  - `tenant_document_sequences(tenant_id, document_type, fiscal_year) UNIQUE` — one counter per stream
- **Blob storage for rendered PDFs**: reuse **Vercel Blob (private)** — PDFs are content-addressed by `sha256(tenant_id || document_type || document_id || template_version)` and stored under `invoicing/{tenant_id}/{yyyy}/{document_id}.pdf`. Deterministic hash means re-rendering produces the same key (SC-003). Private ACL; signed URLs issued per-request for downloads (60-second TTL). PDF metadata (hash, size, bytes rendered, template version) stored alongside the invoice row for audit.
- Session / rate-limit cache: Upstash Redis (Singapore) — unchanged. F4 adds a **per-actor token bucket on `POST /api/invoices/[id]/issue`** (20 issues / 5 min per `(tenant_id, actor_user_id)` — prevents accidental double-issue) and **per-member auto-email throttle** (max 10 auto-sends / hour per member to prevent bounce-storm from flipping us to a spam classifier) reusing the F1 Upstash adapter.

**Testing**:

- `vitest` — unit + Application tests. Coverage thresholds: Domain 100% line; Application ≥ 80% line + 80% branch overall, **100% branch on security-critical use cases**: `issue-invoice.ts` (transactional seq-number + PDF + persist), `issue-credit-note.ts` (partial-accumulation guard), `record-payment.ts` (idempotency guard FR-007), `void-invoice.ts` (terminal-state guard + paid-invoice refusal FR-008), `enforce-tenant-context-on-invoice.ts`, `allocate-sequence-number.ts` (advisory-lock retry + fiscal-year boundary).
- `playwright` — E2E with existing F1+F2+F3 setup. New specs: `tests/e2e/invoice-draft-issue.spec.ts`, `invoice-pay.spec.ts`, `invoice-void.spec.ts`, `credit-note-full.spec.ts`, `credit-note-partial.spec.ts`, `invoice-member-portal.spec.ts`, `invoice-member-page-integration.spec.ts` (US7), `invoice-auto-email.spec.ts`, `invoice-resend.spec.ts`, `invoice-pdf-determinism.spec.ts` (SC-003 byte-identical across re-renders), `invoice-a11y.spec.ts` (axe-core), `invoice-i18n.spec.ts` (TH+EN+SV coverage incl. PDF rendering).
- `@axe-core/playwright` — WCAG 2.1 AA on every new screen.
- **New cross-tenant integration test for F4** (Constitution v1.4.0 Principle I clause 3 — Review-Gate blocker): `tests/integration/invoicing/tenant-isolation.test.ts` — creates two tenants with UUID-suffixed slugs, issues invoices + credit notes for each, and asserts zero cross-tenant visibility on SELECT / INSERT / UPDATE / DELETE across all four F4 tables, plus emission of `invoice_cross_tenant_probe` on every probe attempt from both directions.
- **New transactional seq-number atomicity test** (FR-003 critical path, Thai RD §87 compliance): `tests/integration/invoicing/seq-number-atomicity.test.ts` — 8 chaos sub-scenarios:
  - (a) PDF render throws → seq number released, no DB row persists, Blob has no orphan
  - (b) Blob upload throws → rollback same as (a)
  - (c) DB commit throws after PDF render → Blob cleanup via transactional outbox sweeper
  - (d) Advisory lock contention (two concurrent issues on same tenant) → second waits + gets next number, no duplicate
  - (e) Year-boundary crossover (Dec 31 23:59:59 + Jan 1 00:00:01 concurrent issues) — each gets the correct fiscal year's next number
  - (f) `tenant_document_sequences` row missing → allocator creates it with sequence=1
  - (g) Audit log insert throws after PDF render → rollback same as (a)
  - (h) Idempotency-Key replay returns the identical invoice (same number, same PDF hash) without consuming a new number
- **New credit-note partial-accumulation test** (FR-022): `tests/integration/invoicing/credit-note-partial-accumulation.test.ts` — issues two partial credits summing to exactly the invoice total (transitions to `credited`), rejects the third partial credit, rejects a single partial exceeding remainder. **Includes concurrent-race scenario (post-critique R2-E1)**: two admins issue partial credits of 60% each on the same paid invoice simultaneously via `Promise.all()` — assert exactly one succeeds and the other fails cleanly with `conflict` ("credit amount exceeds remainder") because the loser of the `SELECT … FOR UPDATE` lock on the parent invoice row reads the updated `credited_total_satang` and bails.
- **New member-archive race test** (post-critique R2-E2 / FR-037): `tests/integration/invoicing/issue-vs-archive-race.test.ts` — starts an issue transaction that is paused mid-flight (via a test-only hook); concurrently archives the target member via the F3 archive use case; resumes the issue. Asserts the issue fails with the "member archived" error, no sequence number is consumed, and no orphan invoice row exists.
- **New auto-email outbox test** (FR-024, FR-026): `tests/integration/invoicing/auto-email-outbox.test.ts` — verifies (a) issue commits + outbox row enqueued inside same tx, (b) Resend failure does NOT roll back issuance, (c) bounce webhook flags the outbox row + surfaces admin-visible failure, (d) manual resend (FR-025) produces a fresh outbox row + audit entry.
- **New deterministic-PDF test** (FR-016, SC-003): `tests/integration/invoicing/pdf-deterministic.test.ts` — renders the same invoice twice at two different timestamps → asserts `sha256(pdfA) === sha256(pdfB)`. Covers invoice, receipt, credit-note, void-stamped invoice.
- **New F3 timeline integration test** (FR-033, US7): `tests/integration/invoicing/f3-timeline-integration.test.ts` — verifies all 6 F4 event types (`invoice_draft_created`, `invoice_issued`, `invoice_paid`, `invoice_voided`, `credit_note_issued`, `invoice_pdf_resent`) appear in the F3 member timeline in chronological order with correct actor + payload.
- **New retention-policy test** (FR-029, FR-030): `tests/integration/invoicing/retention-member-archive.test.ts` — archives a member with 3 paid invoices → invoices remain intact, timeline still enumerates them, admin invoice list still includes them.
- **New RLS coverage cross-cutting test extension** (critique carry-over from F3): extend `tests/integration/rls-coverage.test.ts` to include `invoices`, `invoice_lines`, `credit_notes`, `tenant_invoice_settings`, `tenant_document_sequences` — any new tenant-scoped table without RLS + FORCE + policy = automatic red CI.
- **New 50-writer concurrent-issuance load test** (post-critique E3): extends `seq-number-atomicity.test.ts` scenario (d) to 50 simultaneous `Promise.all()` issues against one tenant + fiscal year. Asserts unique sequence numbers, contiguous 1..50, wall-clock < 30s. Gated by `RUN_PERF=1`.
- **New property-based credit-note VAT test** (post-critique E7): `tests/unit/invoicing/calculate-credit-note-vat.test.ts` with `fast-check` — `forAll (totalSatang ≥ 100) (partition of totalSatang into N partials) (vatRate ∈ [0.0, 0.30]) → assert sum(credit-note-vats) ≤ original-vat + 1 satang tolerance`.
- **New logo-upload security test** (post-critique E4): `tests/integration/invoicing/logo-upload-security.test.ts` — verifies (a) SVG rejected with 422, (b) >1MB rejected, (c) out-of-range dimensions rejected, (d) EXIF stripped on accept, (e) PATCH settings rejects raw logo binary and only accepts returned `logo_blob_key`.
- **New draft-preview test** (post-critique P5): `tests/e2e/invoice-draft-preview.spec.ts` — clicks Preview on a draft → asserts (a) watermark visible, (b) `tenant_document_sequences.next_sequence_number` unchanged before/after, (c) no `audit_log` row created, (d) no `invoices.pdf_blob_key` set, (e) returned content-type is `application/pdf`.
- **New settings-form integration test** (post-critique P2): `tests/integration/invoicing/settings-form.test.ts` — CRUD lifecycle for tenant settings via the US4 UI path; asserts FR-010 invoice-refusal when required fields missing, snapshotting behaviour (FR-011) after settings change, and RLS isolation.
- **New PDF render benchmark** (post-critique E6): `tests/perf/pdf-render-benchmark.test.ts` gated by `RUN_PERF=1` — renders a realistic invoice 100× and records p50/p95/p99; run BEFORE `issue-invoice.ts` is implemented to validate the 1.5s issuance-path budget.

**Target Platform**: Web browsers (mobile Safari, Chrome Android, Chrome, Firefox, Safari, Edge — last 2 versions). Deployed on Vercel `sin1` + Neon `ap-southeast-1` + Vercel Blob (private) — unchanged except for the blob store introduction.

**Project Type**: Web application (Next.js full-stack, single repo, single deploy) — unchanged.

**Performance Goals**:

- **Spec SC-001**: Admin issues first invoice ≤ 2 min wall-clock from member page — UX target.
- **Spec SC-002**: 100% of generated PDFs satisfy Thai-RD checklist — verification target (static review + automated template assertions).
- **Spec SC-003**: 100% byte-identical re-render — `sha256` equality assertion in CI.
- **Spec SC-004**: 0 cross-tenant leaks — integration test enforced.
- **Spec SC-005**: Invoice list with 5,000 rows — first page p95 < 500 ms. Postgres index + `TanStack Table` cursor pagination.
- **Spec SC-007**: Member PDF download p95 ≤ 1 min end-to-end including email arrival.
- **Spec SC-011**: F4 event in F3 timeline within 5 s — timeline reads from `audit_log` directly, so latency is DB-query-bounded.
- **Spec SC-010**: Admin reconstructs billing history ≤ 30 s from member page.
- **Constitution Principle VI**: LCP < 2.5 s, INP < 200 ms, CLS < 0.1 on mid-range mobile over 4G (every new screen).
- **Constitution Principle VII**: Invoicing API p95 < 400 ms, p99 < 800 ms. **Issuance path p95 < 1.5 s** (includes synchronous PDF render + Blob upload + DB commit — deviation justified in Complexity Tracking).

**Constraints**:

- Tenant isolation enforced at BOTH application and database layers — cross-tenant probe returns 404 (FR-013) and emits `invoice_cross_tenant_probe` immediately.
- **Sequential tax-document numbering MUST guarantee no gaps** (Thai RD §87) — Postgres advisory lock per `(tenant_id, document_type, fiscal_year)` tuple, `SELECT … FOR UPDATE` on `tenant_document_sequences`, transactional PDF render inside the same unit of work (FR-003 / spec Q3 resolution).
- **10-year tax-document retention** (FR-029, FR-030) — Tax docs are immune to member archival/deletion; GDPR/PDPA erasure workflows (F9) treat them as a distinct retention category governed by "legal obligation" lawful basis.
- **Auto-email delivery decoupled from financial state** (FR-026) — outbox pattern guarantees financial events commit even when Resend is down.
- PII redaction in logs: extend the F1+F3 pino list with `tax_id`, `member_legal_name_snapshot` (contains PII), `member_address_snapshot`, `Authorization` headers, PDF binary content. User IDs hashed when cross-request correlated.
- PDPA + GDPR dual compliance — retention policy explicit; erasure requests honoured on live member profile only, tax docs retain their snapshot under legal obligation.
- SV+EN+TH at release for all UI; **PDF renders TH + EN only** (tax-document compliance per spec FR-018 — SV is UI-only).
- WCAG 2.1 AA on every screen; full keyboard nav; `prefers-reduced-motion` honoured.
- All timestamps ISO 8601 UTC; **Thai Buddhist Era (BE) is display-only and required on PDFs** alongside CE dates (spec US1 AS3).
- Thai VAT 7% is snapshotted per invoice at issue time (FR-011) — future rate changes do not retroactively alter historic invoices.
- Monetary amounts stored as **THB minor units (satang) as `BIGINT`** — never `NUMERIC`/`DECIMAL` to avoid floating-point ambiguity on `pro_rate_factor × fee` calculations. See data-model.md § 1.4.
- Append-only audit log extended (not restructured) — new event types reuse the F2+F3 `payload jsonb` column.

**Scale/Scope**:

- Today: 1 live tenant (SweCham), ~131 members × 1 invoice/year = ~131 invoices/year at baseline, plus ad-hoc corrections. Total F4 document volume year-1 ≤ 500 (invoices + receipts + credit notes + voids).
- 5-year target: ~15-20 tenants × ~1,000 members each × 1.2 documents/member/year = ~20,000 documents/year platform-wide (trivial for Postgres; comfortably within a single Neon instance).
- Admin concurrency: < 5 staff per tenant. Peak issuance load: SweCham annual renewal cycle may issue 100-150 invoices in a single day — advisory-lock contention acceptable (microsecond holds).
- Member self-service concurrency: ~10% of members active per month; download traffic dominated by reads from Blob via signed URLs.
- PDF storage: ~200 KB per PDF × 20,000 documents/year × 10 years = ~40 GB — well within Blob's practical limits.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*
*Source: [`.specify/memory/constitution.md`](../../.specify/memory/constitution.md) **v1.4.0***

### NON-NEGOTIABLE gates (any FAIL blocks the plan; no waivers)

- [x] **I. Data Privacy & Security — including v1.4.0 Tenant Isolation clauses**
  - **PII surfaces introduced**: snapshotted member legal name + address + tax ID on every invoice, receipt, and credit note. Snapshotted tenant legal identity (not PII but business-sensitive). PDF file binaries contain all of the above. All subject to PDPA + GDPR dual compliance **under the "legal obligation" lawful basis** (Thai Revenue Code §87/3 + GDPR Art. 6(1)(c)) for retention — a distinct lawful basis from F3's contractual-necessity basis, explicitly documented on the tenant Privacy Notice addendum.
  - **Lawful basis for retention**: legal obligation (FR-029, FR-030). F4 is the first feature where the tenant's legal-obligation category applies and a GDPR/PDPA erasure request does NOT delete the data. This interaction is documented in `spec.md` FR-031 and is explicitly reserved for F9 GDPR-export implementation.
  - **Purpose limitation**: snapshot data on tax documents is used ONLY for tax compliance and audit response. It is NOT used for marketing, analytics, or cross-tenant features.
  - **RBAC**: `admin` = full CRUD + issue/pay/void/credit-note; `manager` = read-only across all F4 surfaces including PDF downloads (spec US1 AS4); `member` = read-only on own company's documents only (FR-014). Enforced by extending the F1 `rbac-guard.ts` with `invoices:*`, `credit-notes:*`, `invoice-settings:*` resource families.
  - **Tenant Isolation — two-layer defence-in-depth (Constitution v1.4.0 Principle I clauses 1-5):**
    1. **Application layer (clause 1):** every invoicing use case in `src/modules/invoicing/application/**` takes a `TenantContext` as an explicit dependency parameter. Forgetting to pass it is a TypeScript compile error. `TenantContext` imported from `@/modules/tenants` — F4 does NOT redefine.
    2. **Database layer (clause 2):** all five F4 tables have `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + the standard `USING (tenant_id = current_setting('app.current_tenant', TRUE))` policy. `runInTenant(tenantCtx, fn)` reused unchanged. `DEBUG_RLS_STATE=1` dev-mode safety net inherited.
    3. **Test enforcement (clause 3):** `tests/integration/invoicing/tenant-isolation.test.ts` — Review-Gate blocker, fails the gate if missing or red.
    4. **Audit (clause 4):** Cross-tenant probes return 404 (never 403/401) and emit `invoice_cross_tenant_probe` + `credit_note_cross_tenant_probe` immediately at high severity. Alert threshold: 1 event / 5 min (alarm), 5 events / hour (incident).
    5. **Super-admin impersonation (clause 5):** not applicable — no super-admin console yet (F13). When F13 lands, impersonated invoice issuance MUST prompt for an explicit second-factor confirmation because the audit event records the impersonated admin, not the super-admin (same pattern as F3 plan § clause 5).
  - **Blob storage security**: Vercel Blob private ACL only; signed URLs issued per-request with 60-second TTL; URL signing key stored in Vercel env (already exists for F1); signed-URL tokens are NOT logged (added to redaction list). Blob key encodes `(tenant_id, document_id, template_version)` deterministically for SC-003 but reveals nothing sensitive if leaked (content-addressed hash is opaque).
  - **OWASP Top 10 coverage** (delta vs F1+F2+F3 for the touched surface):
    - **A01 Broken Access Control** — RBAC + RLS + signed-URL Blob access + member-to-company ownership check (FR-014).
    - **A02 Cryptographic Failures** — at-rest AES-256 (Neon + Vercel Blob) + TLS 1.2+ + signed URLs replace any bearer-token exposure. Inherited.
    - **A03 Injection** — Drizzle parameterised queries; zod on every API boundary; PDF template data is passed as React props, never as interpolated strings (eliminates PDF-injection class).
    - **A04 Insecure Design** — **transactional seq-number ↔ PDF ↔ persist ↔ audit** is the single most-designed surface in F4. The entire "four operations in one transaction" pattern is the mitigation for every subtle attack and reliability failure along this path.
    - **A05 Security Misconfiguration** — Blob ACL private-by-default; feature flag `FEATURE_F4_INVOICING` gates every route and use case for emergency kill-switch.
    - **A07 Identification & Authentication Failures** — manual-payment recording fields (method + reference) are free-text and do NOT become authentication tokens. Signed-URL TTL short (60s) to prevent link-forwarding attacks.
    - **A08 Software & Data Integrity** — append-only audit log extended; PDF `sha256` stored alongside the invoice row for tamper detection.
    - **A09 Logging Failures** — `invoice_cross_tenant_probe`, `invoice_issuance_failed`, `pdf_render_failed`, `auto_email_delivery_failed` are high-severity audit events.
    - **A10 SSRF** — Blob fetch uses Vercel's first-party client (no user-controllable URLs); no outbound HTTP fetches from user input.
  - **TLS 1.2+** + **at-rest AES-256** — inherited from F1+F2+F3 unchanged.

- [x] **II. Test-First Development**
  - **TDD ordering**: every user story (US1–US7) has at least one acceptance test authored red and committed before the matching use-case implementation lands. `tenant-isolation.test.ts`, `seq-number-atomicity.test.ts`, and `pdf-deterministic.test.ts` are authored red at the very start of the implementation phase.
  - **Coverage thresholds** (extending F1+F2+F3 `vitest.config.ts`):
    - Domain layer (`src/modules/invoicing/domain/**`): 100% line — pure pricing math, pro-rate formula (none/monthly/daily), VAT proportional recalc for credit notes, state-machine rules (draft → issued → paid / void / credited / partially_credited; derived overdue), primary-invariant rules (exactly one primary line per invoice, one active sequence-counter row per tuple), `DocumentNumber` value object (tenant prefix + fiscal year + 6-digit padded sequence).
    - Application layer (`src/modules/invoicing/application/**`): ≥ 80% line + 80% branch overall, **100% branch on security-critical use cases** listed in Technical Context.
  - **Contract tests** (`tests/contract/invoicing/`): one file per REST endpoint, asserting request/response shapes against shared zod schemas.
  - **Integration tests** (`tests/integration/invoicing/`): hit live Neon Singapore — RLS, transactional atomicity (8 chaos scenarios), advisory-lock contention, year-boundary concurrency, credit-note partial-accumulation, outbox + bounce webhook, deterministic PDF rendering, F3 timeline integration, retention vs member-archive interaction.
  - **Red test suite on `main` = stop-the-line** — same as F1+F2+F3.

- [x] **III. Clean Architecture**
  - **One new bounded context**: `src/modules/invoicing/` (full four-layer Domain → Application → Infrastructure + Presentation via `src/app/`). Public barrel (`index.ts`); ESLint `no-restricted-imports` extended to forbid deep imports into `invoicing/{domain,application,infrastructure}` from outside the module.
  - **Domain layer has zero framework imports** — no `next`, `drizzle-orm`, `resend`, `@react-pdf/renderer`, `react`. Holds `Invoice` aggregate root, `InvoiceLine` entity, `CreditNote` root, `TenantInvoiceSettings`, `InvoiceStatus`, `DocumentNumber` value object, `Money` value object (immutable, satang minor units, total-ordering), `VatRate` value object, `ProRatePolicy` (sum type: `None | Monthly | Daily`), `FiscalYear` value object (via `js-joda` wrappers), invariants (`enforce-one-primary-membership-line`, `enforce-credit-cannot-exceed-remainder`, `enforce-terminal-state-no-edit`, `enforce-sequence-monotone-increasing`). `TenantContext` imported from `@/modules/tenants`. Snapshotted member identity modelled as an opaque `MemberIdentitySnapshot` value object constructed by the Application layer (Domain does NOT depend on `@/modules/members` Domain types — avoids cross-module Domain coupling). `auditLog` schema imported from `@/modules/auth/infrastructure/db/schema` in Infrastructure only (same pattern as F3 — see Complexity Tracking).
  - **Application layer orchestrates Domain via ports** — `InvoiceRepo`, `CreditNoteRepo`, `TenantSettingsRepo`, `SequenceAllocatorPort` (wraps advisory-lock + row update), `PdfRenderPort`, `BlobStoragePort`, `AuditPort`, `ClockPort` (wraps `js-joda` clock for testability), `EmailOutboxPort`, `MemberIdentityPort` (wraps the member-module barrel read to build snapshots), `PlanLookupPort` (F2 barrel). All use cases return `Result<T, E>` (reusing `src/lib/result.ts`). No Drizzle, Next, Resend, React, or `@react-pdf/renderer` imports.
  - **Infrastructure layer** owns Drizzle schema, migrations, repo implementations, the advisory-lock + FOR-UPDATE allocator, the Resend outbox dispatcher, the `@react-pdf/renderer` React-tree adapter, the Vercel Blob adapter, and the `MemberIdentityPort` adapter that reads from the members barrel. Drizzle-inferred types do NOT leak into Application.
  - **Presentation layer** (`src/app/(staff)/admin/invoices/**`, `src/app/(member)/portal/invoices/**`, `src/app/api/invoices/**`, `src/app/api/credit-notes/**`, `src/app/(staff)/admin/members/[memberId]/_components/member-invoices-section.tsx` — the F3-surface addition, and the F3 timeline extension in `src/modules/members/infrastructure/timeline/**` that reads from the new audit event types) calls public barrels only.
  - **Cross-module imports**:
    - `invoicing` → `auth` (session, RBAC) via public barrel.
    - `invoicing` → `tenants` (`TenantContext`) via public barrel.
    - `invoicing` → `plans` (tier metadata for pricing + period calculation) via public barrel.
    - `invoicing` → `members` (member identity read for snapshot building) via public barrel — specifically `getMemberIdentityForInvoicing(tenantCtx, memberId)` added to `@/modules/members` barrel as part of F4 implementation.
    - `members` → `invoicing` (US7 F3 surface integration) via `@/modules/invoicing` public barrel — specifically `listInvoicesByMember(tenantCtx, memberId)` and the audit-event-type enumeration for timeline filtering. This creates a **bidirectional read-only dependency** between `invoicing` and `members` — explicitly noted in Complexity Tracking because bidirectional cross-module consumption is normally discouraged by Principle III.

- [x] **IV. Payment Security (PCI DSS)** — **Not applicable in F4.** F4 does NOT touch card data, payment tokens, or any PAN/CVV. Manual-payment recording fields (method, reference string, notes, date) are administrative free-text identifying an already-settled bank transfer / cheque / cash receipt — they are not financial instruments. F5 will process actual card payments via Stripe Elements / Payment Intents and will re-validate SAQ-A on that branch.

### Core principle gates (FAIL must be justified in Complexity Tracking)

- [x] **V. Internationalization (SV + EN + TH)** — UI uses `next-intl` messages keyed under `admin.invoices.*`, `admin.creditNotes.*`, `admin.invoiceSettings.*`, `portal.invoices.*` in `messages/{en,th,sv}.json`. Missing EN keys fail the build. TH+SV enforced on release branches via `pnpm check:i18n`. **PDF rendering is bilingual TH + EN** regardless of viewer locale (FR-018) — SV is NOT rendered on PDFs per tax-compliance scope. Thai amount-in-words via `thai-baht-text`; English amount-in-words via local helper. Month names in PDFs: both Gregorian (CE) and Thai Buddhist Era (BE, displayed in parentheses on `th` section of the PDF) per spec US1 AS3. Currency symbol "฿" (U+0E3F) used alongside "THB" ISO code.

- [x] **VI. Inclusive UX (Mobile First + WCAG 2.1 AA + Enterprise Standards)** — `docs/ux-standards.md` § 15 checklist is a merge blocker. Shimmer skeleton on invoice list + member invoices section (CLS 0 per ux-standards § 2.1). sonner toasts on every mutation. Confirmation dialogs on issue / void / credit-note with typed-phrase pattern for destructive actions. aria-live announces seq-number on successful issue. `prefers-reduced-motion` swaps any motion-y transitions for instant. Full keyboard nav on draft form, list, bulk select, credit-note dialog. Automated `@axe-core/playwright` WCAG 2.1 AA scan in `tests/e2e/invoice-a11y.spec.ts`. **Member self-service portal (`/portal/invoices`) inherits identical standards** — no degraded UX for the member persona.

- [x] **VII. Performance & Observability** — `pino` JSON logs with `logger.child({ tenant, invoice_id, doc_type })`. New redact keys: `tax_id`, `member_legal_name_snapshot`, `member_address_snapshot`, `signed_url_token`, PDF binary bodies. `@vercel/otel` traces span Application → Infrastructure for every invoicing use case with `tenant.id`, `invoice.id`, `doc.number`, `actor.user_id`, `template.version` attributes. Vercel Speed Insights + Lighthouse CI inherited. SLOs: invoicing API p95 < 400 ms, **issuance path p95 < 1.5 s** (synchronous PDF render — deviation in Complexity Tracking), invoice list (5k rows) p95 < 500 ms (SC-005), member portal download TTFB < 300 ms (signed URL). Metrics: `invoicing.issue.count`, `invoicing.issue.duration_ms`, `invoicing.pdf_render.duration_ms`, `invoicing.seq_allocator.contention_retries`, `invoicing.auto_email.bounces`, `invoicing.cross_tenant_probe.count`. Alerts: 1 cross-tenant probe / 5 min (alarm), p99 issuance > 3 s (alarm), auto-email bounce rate > 5% over 1h (alarm). Runbook addition to `docs/observability.md` § F4 Invoicing during implementation.

- [x] **VIII. Reliability (Error Handling + Data Integrity + Audit Trail)** — This is the heaviest principle for F4.
  - Every error path returns a typed `Result<T, E>`.
  - **Transactional boundaries** (each = one Postgres transaction + outbox rows + audit rows inside the tx):
    - **Issue invoice** (FR-003, FR-037): **canonical lock order — member row FIRST, then advisory + sequence-counter row**. Sequence: `SELECT … FOR UPDATE` on `members(id)` + verify `status = 'active'` → `pg_advisory_xact_lock` on the `(tenant, doc_type, fiscal_year)` tuple → `SELECT … FOR UPDATE` on `tenant_document_sequences` → increment → build snapshot → render PDF → upload to Blob → insert `invoices` + `invoice_lines` → insert audit `invoice_issued` → insert outbox row for auto-email → commit. Rationale for the ordering: the member row is the narrower, more contentious resource (one per member) and must be grabbed first so that archive operations (which only take the member lock, never the sequence lock) cannot interleave and trigger deadlock. Any failure rolls back all DB state; Blob upload cleanup is handled by a transactional-outbox sweeper (Blob write is the only non-transactional step; see research.md § 4). `issue-invoice.ts` carries a header comment documenting this ordering as a compile-time-invisible invariant.
    - **Record payment** (FR-006, FR-007): idempotency-key guard → `UPDATE invoices SET status='paid', payment_* = …` → allocate receipt seq number (if separate receipt-stream tenant) → render receipt PDF → upload → insert audit `invoice_paid` → insert outbox row → commit.
    - **Void invoice** (FR-008): state guard (refuse if paid / voided / credited) → `UPDATE invoices SET status='void', void_reason = …` → render VOID-stamped PDF variant (same seq number, overwrites Blob) → insert audit `invoice_voided` → commit. **No outbox row** — void is not auto-emailed (admin decides when to notify; resend available via FR-025).
    - **Issue credit note** (FR-020 … FR-023): state guard (paid invoice only) → partial-accumulation guard → advisory lock on credit-note sequence → seq allocate → build credit-note snapshot → proportional VAT recalc → render credit-note PDF → upload → insert `credit_notes` row → `UPDATE invoices SET status='credited' | 'partially_credited'` → insert audit `credit_note_issued` → insert outbox row → commit.
    - **Manual PDF resend** (FR-025): no state change to financial row → insert outbox row → insert audit `*_pdf_resent` → commit.
    - **Tenant settings update** (FR-011 snapshot guarantee): `UPDATE tenant_invoice_settings` → insert audit `tenant_invoice_settings_updated` → commit. Existing invoices use their snapshotted values, unaffected.
  - **Idempotency keys** on every mutation API endpoint (shared pattern with F1+F2+F3): `Idempotency-Key` header required on POST / PATCH / DELETE. Replay returns the original response (FR-007 for payments, and extended to all issuance paths to tolerate network-retry on the transactional path without consuming extra sequence numbers).
  - **Audit log extends the F1+F2+F3 `audit_log` table** via migration `0011_audit_log_f4_extension.sql` — **15 new event types** via top-level idempotency-safe `DO $$ … ALTER TYPE ADD VALUE … $$` blocks (F3 pattern): `invoice_draft_created`, `invoice_draft_deleted`, `invoice_issued`, `invoice_paid`, `invoice_voided`, `invoice_overdue_detected` (derived — emitted daily by a cron or on read? see research.md § 5), `credit_note_issued`, `tenant_invoice_settings_updated`, `invoice_pdf_resent`, `receipt_pdf_resent`, `credit_note_pdf_resent`, `invoice_cross_tenant_probe`, `credit_note_cross_tenant_probe`, `pdf_render_failed`, `auto_email_delivery_failed`. Retention ≥ 10 years for F4 audit events (extends F1+F2+F3's 5-year baseline to match FR-029 tax-doc retention).
  - **Concurrent edit handling**: last-write-wins for draft edits with a toast. Terminal states (issued/paid/void/credited) reject edits at the Domain layer with a clear error.
  - **No silent data loss on PDF gen failure** — the "transactional rollback releases the seq number" design satisfies Thai RD §87 no-gaps by construction, not by detection.

- [x] **IX. Code Quality Standards** — TypeScript strict (incl. `noUncheckedIndexedAccess`), ESLint clean, Prettier, Conventional Commits enforced by commit-msg hook. **Solo-maintainer substitute** (Constitution v1.3.1) applies as in F1+F2+F3: direct push to `main` after Review Gate sign-off is permitted; substitute stack = ≥6 `/speckit.review` automated passes + ≥2 `/speckit.staff-review` rounds + the extended test bar (now including F4 integration + seq-atomicity + deterministic-PDF tests) + maintainer co-signature on `security.md` (authored for F4 because F4 touches PII snapshots + tax-document compliance — see Phase 1 deliverables).

- [x] **X. Simplicity (YAGNI)** — Key YAGNI decisions explicitly made:
  - **No receipt table.** Receipts are a derived template rendering of the paid-invoice row. Separate rendering, same data.
  - **No separate PDF-rendering microservice.** Pure-Node `@react-pdf/renderer` inline inside the Next.js route handler.
  - **No queue / worker service for auto-email.** Outbox pattern + on-demand dispatcher (same as F3 email-change) — cron-less.
  - **No bulk-issue API.** One-off admin script covers day-1 operational need (spec Out of Scope); per-member issuance via US1 is the sanctioned path.
  - **No CSV export for accountants.** F9 owns reporting; F4 renders individual PDFs only.
  - **No refund-to-Stripe automation.** F5 + F8 own the money-movement flows; F4 only issues the tax document.
  - **No tenant-configurable VAT calculation method.** Thai RD-mandated method only (VAT = subtotal × rate, rounded to 2 dp per invoice, not per line — see research.md § 6).
  - **No partial-payment model.** Spec assumption; reiterated here.
  - **No new search service.** Invoice list + filter uses the same Postgres-index + `TanStack Table` cursor pagination pattern as F3.
  - **No custom PDF template DSL.** Templates are React components under `src/modules/invoicing/infrastructure/pdf/templates/*.tsx`.
  - **No document-versioned history (draft edits).** Drafts are mutable; issued/paid/voided/credited are immutable. No "edit history" view on draft changes — if needed later, F9 audit viewer covers it.
  - **No multi-currency support.** THB only (spec assumption).

**All 10 gates PASS.** Two deviations inherited from F1 (Singapore hosting region + solo-dev review substitute) carry over unchanged — see Complexity Tracking. One new F4 deviation (issuance-path p95 budget) documented with rationale.

## Project Structure

### Documentation (this feature)

```text
specs/007-invoices-receipts/
├── plan.md                  # This file
├── spec.md                  # Feature specification (Clarifications Q1–Q5 resolved)
├── research.md              # Phase 0 output
├── data-model.md            # Phase 1 output
├── quickstart.md            # Phase 1 output
├── contracts/
│   └── invoicing-api.md     # Phase 1 output — REST endpoint contracts
├── checklists/
│   └── requirements.md      # Spec quality checklist (from /speckit.specify)
├── security.md              # Tax-PII threat model + security checklist (authored before /speckit.tasks)
└── tasks.md                 # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── app/                                                       # Presentation layer
│   ├── (staff)/admin/
│   │   ├── invoices/
│   │   │   ├── layout.tsx                                     # Invoices section shell + breadcrumb
│   │   │   ├── page.tsx                                       # List (US1 landing) — TanStack Table
│   │   │   ├── new/page.tsx                                   # Draft create (US1 step 1)
│   │   │   ├── [invoiceId]/
│   │   │   │   ├── page.tsx                                   # Detail view (status-aware)
│   │   │   │   ├── edit/page.tsx                              # Draft edit
│   │   │   │   ├── issue/page.tsx                             # Issue confirmation step (US1 commit)
│   │   │   │   ├── pay/page.tsx                               # Record payment (US2)
│   │   │   │   ├── void/page.tsx                              # Void with reason (US5)
│   │   │   │   └── credit-note/new/page.tsx                   # Issue credit note (US6)
│   │   │   └── _components/
│   │   │       ├── invoice-table.tsx                          # TanStack Table wrapper (status, year, member filters)
│   │   │       ├── invoice-form.tsx                           # Shared draft/edit form (RHF + zod, pricing preview)
│   │   │       ├── issue-confirm-dialog.tsx                   # Typed-phrase confirmation for irreversible issue
│   │   │       ├── payment-form.tsx                           # method/date/reference/notes
│   │   │       ├── void-confirm-dialog.tsx                    # Typed-phrase confirmation + reason
│   │   │       ├── credit-note-form.tsx                       # Full/partial amount + reason
│   │   │       ├── status-chip.tsx                            # draft / issued / paid / void / credited / partially_credited / overdue
│   │   │       └── pdf-download-button.tsx                    # Generates + fetches signed URL
│   │   ├── invoice-settings/
│   │   │   ├── page.tsx                                       # Tenant invoice settings (US4 P3)
│   │   │   └── _components/settings-form.tsx                  # VAT, reg fee, legal identity, numbering, net-days, pro-rate, logo
│   │   └── members/[memberId]/_components/
│   │       └── member-invoices-section.tsx                    # US7 F3 surface addition — list + quick actions
│   ├── (member)/portal/
│   │   ├── invoices/
│   │   │   ├── page.tsx                                       # Member invoice list (US3)
│   │   │   └── [invoiceId]/page.tsx                           # Member detail + PDF download
│   │   └── _components/invoices-summary-card.tsx              # Latest-3 + "view all" on portal landing (US7 AS4)
│   ├── api/invoices/
│   │   ├── route.ts                                           # POST create draft, GET list
│   │   ├── [invoiceId]/
│   │   │   ├── route.ts                                       # GET detail, PATCH draft edit, DELETE draft
│   │   │   ├── preview/route.ts                               # POST watermarked draft preview (FR-001a — no seq, no Blob, no audit)
│   │   │   ├── issue/route.ts                                 # POST issue (transactional seq + PDF + audit + outbox)
│   │   │   ├── pay/route.ts                                   # POST record payment
│   │   │   ├── void/route.ts                                  # POST void
│   │   │   ├── pdf/route.ts                                   # GET signed-URL redirect (auto re-render if Blob missing)
│   │   │   └── resend/route.ts                                # POST manual resend (FR-025)
│   │   └── bulk/route.ts                                      # Reserved — not implemented in F4 (stub 501)
│   ├── api/credit-notes/
│   │   ├── route.ts                                           # POST issue, GET list
│   │   └── [creditNoteId]/
│   │       ├── route.ts                                       # GET detail
│   │       ├── pdf/route.ts                                   # GET signed-URL redirect
│   │       └── resend/route.ts                                # POST manual resend
│   ├── api/tenant-invoice-settings/
│   │   ├── route.ts                                           # GET + PATCH tenant settings (admin only)
│   │   └── logo/route.ts                                      # POST multipart logo upload (FR-034 — MIME whitelist + sharp re-encode)
│   ├── api/portal/invoices/
│   │   ├── route.ts                                           # GET member's own invoice list
│   │   └── [invoiceId]/pdf/route.ts                           # GET signed-URL redirect (ownership enforced)
│   └── api/cron/
│       └── auto-email-dispatch/route.ts                       # Outbox drain (invoked by Vercel Cron + on-demand)
│
├── modules/invoicing/                                         # New bounded context
│   ├── index.ts                                               # Public barrel
│   ├── domain/
│   │   ├── invoice.ts                                         # Aggregate root + status + state-machine
│   │   ├── invoice-line.ts                                    # Child entity
│   │   ├── credit-note.ts                                     # Aggregate root
│   │   ├── tenant-invoice-settings.ts                         # Aggregate root
│   │   ├── value-objects/
│   │   │   ├── money.ts                                       # Satang BIGINT, immutable, total-ordering
│   │   │   ├── vat-rate.ts                                    # Percentage with 4-dp precision
│   │   │   ├── document-number.ts                             # prefix + fiscal year + 6-digit sequence
│   │   │   ├── fiscal-year.ts                                 # js-joda LocalDate boundary
│   │   │   ├── pro-rate-policy.ts                             # None | Monthly | Daily sum type
│   │   │   ├── member-identity-snapshot.ts                    # Opaque snapshot — built by Application
│   │   │   └── tenant-identity-snapshot.ts                    # Tenant legal identity snapshot
│   │   └── policies/
│   │       ├── enforce-one-primary-membership-line.ts
│   │       ├── enforce-credit-cannot-exceed-remainder.ts
│   │       ├── enforce-terminal-state-no-edit.ts
│   │       ├── enforce-sequence-monotone-increasing.ts
│   │       ├── calculate-pro-rate-factor.ts                   # none/monthly/daily formulas
│   │       ├── calculate-vat.ts                               # Thai RD method — total-level rounding
│   │       └── calculate-credit-note-vat.ts                   # Proportional recalc
│   ├── application/
│   │   ├── ports/
│   │   │   ├── invoice-repo.ts
│   │   │   ├── credit-note-repo.ts
│   │   │   ├── tenant-settings-repo.ts
│   │   │   ├── sequence-allocator-port.ts                     # advisory-lock + FOR UPDATE
│   │   │   ├── pdf-render-port.ts                             # renders React tree → Uint8Array + sha256
│   │   │   ├── blob-storage-port.ts                           # upload / delete / sign URL
│   │   │   ├── audit-port.ts                                  # reuses F1 shape
│   │   │   ├── clock-port.ts                                  # js-joda clock
│   │   │   ├── email-outbox-port.ts                           # enqueue outbox row
│   │   │   ├── member-identity-port.ts                        # builds MemberIdentitySnapshot
│   │   │   └── plan-lookup-port.ts                            # F2 barrel consumer
│   │   ├── use-cases/
│   │   │   ├── create-invoice-draft.ts
│   │   │   ├── update-invoice-draft.ts
│   │   │   ├── delete-invoice-draft.ts
│   │   │   ├── preview-invoice-draft.ts                       # FR-001a — renders watermarked PDF in-memory, no seq/blob/audit
│   │   │   ├── upload-tenant-logo.ts                          # FR-034 — MIME/size/dim validation + sharp re-encode + blob persist
│   │   │   ├── issue-invoice.ts                               # THE critical transactional path
│   │   │   ├── record-payment.ts                              # FR-006 + FR-007 idempotency
│   │   │   ├── void-invoice.ts
│   │   │   ├── issue-credit-note.ts                           # Full or partial
│   │   │   ├── list-invoices.ts                               # Admin + cursor paginated
│   │   │   ├── list-invoices-by-member.ts                     # US7 — consumed by members module
│   │   │   ├── list-portal-invoices.ts                        # Member portal
│   │   │   ├── get-invoice-pdf-signed-url.ts                  # Renders if blob missing
│   │   │   ├── resend-pdf.ts                                  # Manual resend (FR-025)
│   │   │   ├── derive-overdue.ts                              # Pure helper for list+detail
│   │   │   ├── update-tenant-invoice-settings.ts
│   │   │   ├── get-tenant-invoice-settings.ts
│   │   │   └── dispatch-outbox.ts                             # Drains enqueued email rows → Resend
│   │   └── invoicing-deps.ts                                  # Composition root
│   └── infrastructure/
│       ├── db/
│       │   ├── schema-invoices.ts
│       │   ├── schema-invoice-lines.ts
│       │   ├── schema-credit-notes.ts
│       │   ├── schema-tenant-invoice-settings.ts
│       │   ├── schema-tenant-document-sequences.ts
│       │   └── migrations/                                    # Drizzle-generated .sql
│       ├── repos/
│       │   ├── drizzle-invoice-repo.ts
│       │   ├── drizzle-credit-note-repo.ts
│       │   └── drizzle-tenant-settings-repo.ts
│       ├── adapters/
│       │   ├── postgres-sequence-allocator.ts                 # advisory lock + FOR UPDATE + retry
│       │   ├── react-pdf-render-adapter.ts                    # @react-pdf/renderer wrapper
│       │   ├── vercel-blob-adapter.ts                         # upload/delete/sign
│       │   ├── resend-email-outbox-adapter.ts                 # enqueue + dispatch
│       │   ├── member-identity-adapter.ts                     # reads @/modules/members barrel
│       │   └── plan-lookup-adapter.ts                         # reads @/modules/plans barrel
│       └── pdf/
│           ├── templates/
│           │   ├── invoice-template.tsx                       # "ใบกำกับภาษี / Tax Invoice"
│           │   ├── receipt-template.tsx                       # "ใบเสร็จรับเงิน / Official Receipt"
│           │   ├── combined-invoice-receipt-template.tsx      # For tenants with combined filing
│           │   ├── credit-note-template.tsx                   # "ใบลดหนี้ / Credit Note"
│           │   └── void-stamped-invoice-template.tsx          # Same as invoice + VOID/ยกเลิก overlay
│           ├── components/                                    # Shared header/footer/line-item/footer-totals
│           ├── fonts/                                          # Sarabun TTFs registered here
│           ├── amount-to-thai.ts                              # wrapper around thai-baht-text
│           └── amount-to-english.ts                           # local helper
│
├── modules/members/                                           # Extended for F4 US7
│   ├── application/
│   │   └── use-cases/member-timeline.ts                       # EXTEND: include F4 audit event types
│   └── infrastructure/
│       └── timeline/resolve-invoice-event-copy.ts             # ADD: maps invoice_issued etc. → i18n label
│
├── components/
│   └── command-palette/invoices-group.tsx                     # Extends F2+F3 palette (smart #4)
│
├── lib/
│   ├── logger.ts                                              # ADD: tax_id, member_*_snapshot, signed_url_token to redact
│   ├── env.ts                                                 # ADD: BLOB_READ_WRITE_TOKEN, CRON_SECRET assertions
│   └── fiscal-year.ts                                         # Thin wrapper around js-joda for Bangkok-TZ boundary
│
└── i18n/messages/{en,th,sv}.json                              # +~180 keys under admin.invoices.* + portal.invoices.* + audit.invoice.*

drizzle/migrations/
├── 0010_invoicing_tables.sql                                  # Four new tables + sequences table + RLS + indexes
└── 0011_audit_log_f4_extension.sql                            # 15 new ALTER TYPE ADD VALUE (idempotent)

tests/
├── contract/invoicing/                                        # one file per endpoint
├── integration/invoicing/
│   ├── tenant-isolation.test.ts                               # Constitution Principle I clause 3 — Review-Gate blocker
│   ├── seq-number-atomicity.test.ts                           # 8 chaos sub-scenarios (FR-003)
│   ├── credit-note-partial-accumulation.test.ts               # FR-022
│   ├── auto-email-outbox.test.ts                              # FR-024 / FR-026
│   ├── pdf-deterministic.test.ts                              # FR-016 / SC-003
│   ├── f3-timeline-integration.test.ts                        # FR-033 / US7
│   ├── retention-member-archive.test.ts                       # FR-029 / FR-030
│   ├── feature-flag-kill-switch.test.ts                       # FEATURE_F4_INVOICING=false → 503
│   ├── rate-limit-issue.test.ts                               # 21st issue in 5 min → 429
│   └── seed-fixtures.ts                                       # Two-tenant fixture with seeded invoice settings
├── unit/invoicing/                                            # Domain + Application unit tests
│   ├── money.test.ts                                          # Satang math, rounding, total-ordering
│   ├── pro-rate-policy.test.ts                                # none/monthly/daily edge cases
│   ├── calculate-vat.test.ts                                  # Thai RD method
│   ├── calculate-credit-note-vat.test.ts                      # proportional recalc
│   ├── invoice-state-machine.test.ts                          # All transitions + terminal-state rejection
│   ├── document-number.test.ts                                # Format + parsing round-trip
│   └── fiscal-year.test.ts                                    # Bangkok-TZ boundary + DST non-effect
└── e2e/                                                       # Playwright specs listed in Testing §
```

**Structure Decision**: One new bounded context `src/modules/invoicing/` with three aggregates (Invoice + InvoiceLine, CreditNote, TenantInvoiceSettings) per Principle III. Reuse the F1+F2+F3 `@/modules/tenants`, `@/modules/auth`, `@/modules/plans`, `@/modules/members` barrels. Extend `@/modules/members` application + infrastructure with timeline-integration hooks for F4 audit events (US7 FR-033). Place the F3-surface invoice section as a pure Presentation addition under `src/app/(staff)/admin/members/[memberId]/_components/` that consumes `@/modules/invoicing` barrel. All other paths follow the F1+F2+F3 patterns. Vercel Blob is a new infrastructure primitive (introduced in F4, reusable by future features that need PDF/file storage).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Hosting region: Singapore (`sin1`) instead of Thailand | No major cloud has a TH region; ~25ms Bangkok latency acceptable; PDPA §28 + GDPR SCCs cover transfer | True in-country residency would require a Thai-local provider with weaker DX, weaker durability SLOs, and no CDN — net worse for tax-document safety. Inherited from F1. Unchanged in F4. |
| Solo-maintainer review substitute (≥2 reviewers requirement waived) | Solo developer; no second human reviewer available | Blocking merge until a second reviewer joins would freeze delivery indefinitely. Substitute = ≥6 automated `/speckit.review` passes + ≥2 `/speckit.staff-review` rounds + extended test bar + maintainer co-signature on `security.md`. Inherited from F1+F2+F3. |
| Issuance path p95 budget 1.5 s (exceeds the standard 400 ms API target stipulated by Principle VII) | The issuance path performs: advisory-lock acquisition + `FOR UPDATE` read + PDF render (React tree → Uint8Array; ~500-800ms p95 under realistic data) + Blob upload + DB commit + audit write + outbox insert — all transactionally. Transactional atomicity is a **Thai RD §87 compliance requirement** that cannot be broken into smaller pieces without losing the "no gaps" guarantee. | (a) Async PDF render after commit — rejected, breaks FR-003 and creates a window where a committed invoice has no retrievable PDF. (b) Pre-rendered template cache — rejected, data is per-invoice and cannot be pre-rendered. (c) Puppeteer with warm pool — rejected, cold-start pain is worse and compliance-attack-surface is larger. Accept the budget deviation; 1.5 s is still well within human-perceivable "the button worked" threshold and the non-issuance paths (list, pay, void, download) stay under 400 ms. |
| Bidirectional read-only dependency between `@/modules/invoicing` and `@/modules/members` | `invoicing` reads member identity for snapshot; `members` reads invoice list + audit event types for US7 surface + timeline. Both directions are **read-only across public barrels** (no shared mutable state). | Extract a third "billing-history" module that both consume — rejected because it would host only two thin read adapters and add an empty module for process, not value (Principle X). Keep the bidirectional read and document it explicitly. Invariant guarded at compile time: no use case in `members/application` mutates invoicing state; no use case in `invoicing/application` mutates member state. ESLint can't express "only read" cheaply, so enforced by code review + PR template checkbox. |
| `auditLog` deep import from `@/modules/auth/infrastructure/db/schema` in `drizzle-invoice-repo.ts` / `drizzle-credit-note-repo.ts` | Repos insert audit rows inside the same DB transaction as the data mutation for atomicity. The auth module's public barrel intentionally excludes Drizzle schema types. Same pattern as F3. | Export `auditLog` from auth barrel — rejected for the same reason as F3 (Drizzle leak through public module interface). The infra→infra cross-module import is narrower harm than barrel→ORM leakage. |
| `@react-pdf/renderer` (React tree) imported into `src/modules/invoicing/infrastructure/pdf/templates/*.tsx` — a *.tsx file inside a Domain-adjacent folder | Templates are declaratively authored as React components for readability and i18n ergonomics. They are strictly inside the Infrastructure layer and are only imported by the `react-pdf-render-adapter.ts`. Domain types are passed in as props, not imported back. | Hand-imperative PDF builder calls (pdfkit-style) inside Infrastructure — rejected for maintainability: the tax-invoice template has ~30 nested layout decisions; imperative code would be unreadable. Template-as-React keeps layout-as-code reviewable and i18n-friendly. |

## Migration Rollback Plan

Two migrations ship in F4:

- **`0010_invoicing_tables.sql`** — creates `invoices`, `invoice_lines`, `credit_notes`, `tenant_invoice_settings`, `tenant_document_sequences` tables; all RLS + FORCE + policies; indexes via `CREATE INDEX CONCURRENTLY`. **Rollback**: `DROP TABLE credit_notes, invoice_lines, invoices, tenant_invoice_settings, tenant_document_sequences CASCADE;` — safe only on a fresh deploy with no production invoice data. Production rollback requires Neon point-in-time restore.
- **`0011_audit_log_f4_extension.sql`** — adds **16 new values** to `audit_event_type` enum (15 from data-model § 4 + `invoice_voided_notice` from round-2 FR-036) via idempotency-safe `DO $$ … EXCEPTION WHEN duplicate_object THEN NULL; END $$` blocks. **Also ships** the partial unique index `audit_log_overdue_once_per_day` per data-model § 4 (post-critique R2-E3 + R3-E3) via `CREATE INDEX CONCURRENTLY IF NOT EXISTS` outside the migration transaction (F3 established precedent for `CONCURRENTLY`). **Rollback**: the index can be dropped safely (`DROP INDEX CONCURRENTLY audit_log_overdue_once_per_day`); **enum values cannot be dropped** (Postgres limitation). Forward-fix: if an event type is erroneous, ship `0012` to stop emitting it; audit readers must tolerate orphaned enum values.

**Feature flag**: `FEATURE_F4_INVOICING` gates every F4 route + use case. Default `true` on all environments; kill-switch value `false` causes F4 routes to return `503 read_only_mode` + hides the Invoices entry from navigation + command palette + member-page section. Verified via `tests/integration/invoicing/feature-flag-kill-switch.test.ts`.

**Blob store rollback**: `invoicing/{tenant_id}/` prefix is owned by F4 only. A rollback of F4 data would orphan PDFs under that prefix; a cleanup script is NOT a migration concern (Blob is non-transactional by design). Orphan cleanup is a manual ops task if ever needed.

## Auto-email Template Conventions (post-critique round-2 R2-P3)

All F4 auto-emails (issue / payment / void cancellation / credit note / manual resend) use a unified template + i18n structure so devs implementing the outbox dispatcher (`dispatch-outbox.ts`) have no open questions at code time.

**Subject-line i18n keys** (under `admin.invoices.autoEmail.subject.*`):
- `issued`: `"{tenant_legal_name} — Tax Invoice {document_number} / ใบกำกับภาษี {document_number}"`
- `paid`: `"{tenant_legal_name} — Official Receipt {document_number} / ใบเสร็จรับเงิน {document_number}"`
- `voided`: `"{tenant_legal_name} — Invoice {document_number} Cancelled / ยกเลิกใบกำกับภาษี {document_number}"`
- `creditNote`: `"{tenant_legal_name} — Credit Note {document_number} (ref. {original_document_number}) / ใบลดหนี้ {document_number}"`
- `resend` (FR-025): `"{subject_of_original_template} [Resent]"`

**Body templates** (`@react-email/components` — already in F1 stack): authored under `src/modules/invoicing/infrastructure/email/templates/{issued,paid,voided,credit-note}.tsx`. Each template:
- Renders a bilingual greeting (EN + TH side-by-side or stacked per member locale preference).
- Includes a one-sentence summary (amount, due date, document number).
- Attaches the bilingual PDF via Resend's `attachments` parameter (≤ 1MB; well below Resend's 40MB limit).
- Footer carries tenant legal name + tax ID + contact.

**Sender identity**:
- `From`: tenant-configured `billing_from_name <billing@{tenant_subdomain}.zyncdata.app>` with fallback to `"Chamber-OS Billing" <billing@chamber-os.com>` when tenant has no branded email configured.
- `Reply-To`: tenant admin email (from `tenant_invoice_settings.billing_reply_to_email` — a NEW field to be added).

**Template versioning**: email templates are versioned with the same policy as PDF templates (see § Template Versioning Policy). An email template update does NOT regenerate historical emails — future sends only.

## Template Versioning Policy (post-critique E8)

Every PDF template file (`invoice-template.tsx`, `receipt-template.tsx`, `combined-invoice-receipt-template.tsx`, `credit-note-template.tsx`, `void-stamped-invoice-template.tsx`) carries a `TEMPLATE_VERSION` export. The `CURRENT_TEMPLATE_VERSION` constant in `src/modules/invoicing/infrastructure/pdf/template-registry.ts` points at the latest version used for freshly issued documents. Historical documents forever render against their pinned `invoices.pdf_template_version` — never re-rendered against a newer template (determinism + legal immutability).

**When to release a new version** (guidance, not policy):
- **v2 trigger**: Thai RD rule change (new required field, layout mandate), a critical rendering bug that mis-prints a compliance-significant element, a major visual redesign with stakeholder sign-off.
- **NOT a v2 trigger**: whitespace / kerning / minor copy refinement (historical docs would drift from future docs for no compliance reason).

**Release process**:
1. Author `invoice-template-v2.tsx` alongside existing `invoice-template.tsx`.
2. Register in `template-registry.ts` and bump `CURRENT_TEMPLATE_VERSION = 2`.
3. Run `tests/integration/invoicing/pdf-template-version-smoke.test.ts` which re-renders a seeded historical invoice under its original `v1` and asserts byte-identical output (catches accidental coupling between versions).
4. Ship via normal PR + feature flag gate if the rollout requires staged cutover.
5. Audit event `invoice_template_version_released` with `{ version, released_by_user_id, note }` for governance.

**Template-version pinning rule (post-critique R3-E4 / R3-X1)** — MUST be honoured by every PDF-rendering code path:

- **New issuance** (invoice, receipt on payment, credit note) uses `CURRENT_TEMPLATE_VERSION`; the resulting value is snapshotted on the document's `pdf_template_version` column.
- **Manual resend** (FR-025), **auto-re-render on Blob recovery** (signed-URL handler finds blob missing), and **void-stamped re-render** (FR-008 + FR-036) — all re-use the document's already-pinned `pdf_template_version`. They MUST NOT switch to `CURRENT_TEMPLATE_VERSION`.
- Rendering adapter signature: `renderPdf({ data, templateVersion })` — the `templateVersion` parameter is **required**, not optional, so every caller makes an explicit choice.
- Assertion in `tests/integration/invoicing/pdf-deterministic.test.ts`: after issuing an invoice on v1 + bumping `CURRENT_TEMPLATE_VERSION` to v2 in the test environment, `sha256(resend-rerender) === sha256(original)` (proves the resend path pins to v1, not drifts to v2). Similar assertion for void re-render + Blob-recovery re-render.

**Runbook addition** (`docs/observability.md § F4 Invoicing`):
- Sequence-number 6-digit overflow runbook (per FR-035): when `invoice_issuance_failed` audit event carries `reason: 'document_number_format_overflow'`, the allocator needs a width upgrade. One-off migration that widens the format + bumps a new audit-event `invoice_numbering_format_upgraded`. Do NOT migrate historical numbers — only future issues use the wider format.

## Architecture Invariant Test (post-critique E1)

A new architecture test `tests/unit/architecture/invoicing-members-bidirectional-dep.test.ts` scans source under `src/modules/invoicing/application/**/*.ts` and `src/modules/members/application/**/*.ts` and asserts that:
1. No file in `members/application` imports from `@/modules/invoicing/application/ports/*` (port types must not cross the barrel).
2. No file in `invoicing/application` imports from `@/modules/members/application/ports/*`.
3. Cross-module consumption only occurs via the public barrel `@/modules/invoicing/index` / `@/modules/members/index`.

Extends the F3-established ESLint `no-restricted-imports` rule family. Fails CI on violation.

## Phase 0 Status

- [x] research.md authored — see [`research.md`](./research.md). 13 research items resolved (PDF engine, sequence allocator, receipt representation, Blob vs BYTEA, overdue derivation, VAT method, pro-rate math, outbox pattern, fiscal year, idempotency, member portal scope, logo handling, 15-threat summary). Zero remaining `NEEDS CLARIFICATION`.

## Phase 1 Status

- [x] data-model.md authored — see [`data-model.md`](./data-model.md). Five new tables (`invoices`, `invoice_lines`, `credit_notes`, `tenant_invoice_settings`, `tenant_document_sequences`), RLS + FORCE policies, immutability trigger, state machine, 15-event audit extension, satang BIGINT money convention, FR → model traceability.
- [x] contracts/ authored — see [`contracts/invoicing-api.md`](./contracts/invoicing-api.md). 15 REST endpoints + full zod DTOs + shared headers/errors + endpoint→FR traceability.
- [x] quickstart.md authored — see [`quickstart.md`](./quickstart.md). New-developer onboarding, critical-path reading order, local smoke test flow, common gotchas, DoD checklist.
- [x] CLAUDE.md updated via `update-agent-context.ps1`.

## Post-Design Constitution Re-Check

All 10 gates re-validated after Phase 1 design — **PASS**.

- **I. Data Privacy & Security (incl. Tenant Isolation v1.4.0)** — data model enforces RLS + FORCE on all 5 F4 tables; `tenant_id` columns present on every table incl. `invoice_lines` (kept for RLS even though join-derivable) and `tenant_document_sequences`; cross-tenant integration test blueprint confirmed in quickstart § 6.
- **II. Test-First Development** — tasks.md (Phase 2) will order red tests before their implementation; TDD blueprint for seq-atomicity, tenant-isolation, deterministic PDF, credit-note partial, outbox is explicit in contracts + data-model.
- **III. Clean Architecture** — module structure laid out in plan.md § Project Structure; Domain imports list in data-model.md respects layering; bidirectional read-only dep between invoicing ↔ members explicitly documented in Complexity Tracking.
- **IV. Payment Security** — N/A for F4 (confirmed in contracts — manual payment fields are free text metadata only).
- **V. i18n** — 180 new i18n keys planned; PDF bilingual TH+EN only confirmed by template list in project structure.
- **VI. Inclusive UX** — `docs/ux-standards.md § 15` checklist will gate merge; Presentation components enumerated in project structure.
- **VII. Perf & Observability** — SLO list extended with issuance path p95 1.5s deviation (documented); metrics + alerts enumerated.
- **VIII. Reliability** — transactional boundaries spelled out per-use-case; audit event extension migration blueprint confirmed; idempotency keys covered by contracts shared-headers section.
- **IX. Code Quality** — solo-maintainer substitute inherited; security.md blueprint acknowledged.
- **X. Simplicity** — 12 YAGNI decisions recorded; post-design no hidden complexity surfaced.

No new Complexity Tracking entries needed post-design.

**Round-2 post-critique update (2026-04-18)**: all 3 🎯 Must-Address items + 9 💡 Recommendations from `critiques/critique-2026-04-18T111947Z.md` applied:

- P5/X1 → FR-001a + US1 AS5 + `POST /api/invoices/[id]/preview` endpoint + `previewInvoiceDraft` use case.
- E4/X3 → FR-034 + `POST /api/tenant-invoice-settings/logo` dedicated endpoint + `sharp@^0.33` dependency + security zod rules + integration test `logo-upload-security.test.ts`.
- P2/X2 → US4 upgraded P3 → P2 + minimal settings form in MVP slice + `settings-form.test.ts`.
- P1 → Build-vs-buy paragraph added to spec § Context.
- P3 → Per-invoice `auto_email_on_issue` override (nullable column on `invoices`; falls through to `tenant.auto_email_enabled`) + FR-024 refinement.
- P4 → `receipt_numbering_mode` default = `'combined'` (Thai SMB norm).
- P6 → SC-008 softened to binary retro-check outcome (no baseline-capture task needed).
- E1 → Architecture invariant test `tests/unit/architecture/invoicing-members-bidirectional-dep.test.ts`.
- E2 → FR-035 (overflow guard) + runbook entry.
- E3 → 50-writer load-test scenario added to `seq-number-atomicity.test.ts` under `RUN_PERF=1`.
- E5 → Auto-email bounce PII handling documented in `research.md § 8a` (accepted + DPA-covered).
- E6 → Pre-implementation `pdf-render-benchmark.test.ts` added under `RUN_PERF=1`.
- E7 → `fast-check` property test for credit-note VAT math added.
- E8 → Template Versioning Policy § added to plan + `invoice_template_version_released` audit event + `pdf-template-version-smoke.test.ts`.
- E9 → `@react-pdf/renderer` pinned to exact `4.3.0` + fallback plan in `research.md § 1`.

Post-round-2 constitution re-check: **PASS 10/10**. Complexity Tracking unchanged. Ready for `/speckit.tasks`.

**Round-3 post-critique update (2026-04-18)**: all 8 💡 Recommendations + 1 🤔 Question (R2-E4) from `critiques/critique-2026-04-18T113815Z.md` applied:

- R2-P1 → FR-036 + US5 AS4 (void cancellation auto-email).
- R2-P2 → Default filter excludes drafts in `GET /api/invoices` + US1 AS6.
- R2-P3 → Auto-email Template Conventions § added above.
- R2-E1 → Concurrent-partial-credit race scenario added to `credit-note-partial-accumulation.test.ts`.
- R2-E2 → FR-037 (member FOR UPDATE + active-status guard) + new `issue-vs-archive-race.test.ts`.
- R2-E3 → `ON CONFLICT DO NOTHING` + partial unique index for `invoice_overdue_detected` in data-model § 4.
- R2-E4 → FR-038 (tax-ID snapshot at issue time; receipts + credit notes render issue-time identity — answered per recommendation "issue-time snapshot for legal continuity"). Documented in spec FR block.
- R2-E5 → Logo orphan policy in `research.md § 12` + `invoicing.logo_blob.count` per-tenant metric + 50-logo cap.
- R2-E6 → Logo upload `Idempotency-Key` behaviour documented in contracts § 3.3.

Post-round-3 spec totals: **43 Functional Requirements** (FR-001, FR-001a, FR-002 … FR-042 — includes FR-039…FR-042 added during checklist gap resolution), **11 Success Criteria**, **8 Clarifications resolved**, **7 User Stories**, **20 contract endpoints**. No new Complexity Tracking entries. Zero 🎯 Must-Address items remain. Ready for `/speckit.tasks`.

**Round-4 post-critique update (2026-04-18)**: all 6 💡 Recommendations from `critiques/critique-2026-04-18T115400Z.md` applied:

- R3-P1 → FR-036 clarified: VOID-stamped PDF attached to cancellation email.
- R3-P2 → US4 AS5 added: empty-state card + CTA when `tenant_invoice_settings` row missing.
- R3-E1 → Canonical lock ordering documented in plan § VIII (member row FIRST, advisory + sequence counter SECOND); header comment required in `issue-invoice.ts`.
- R3-E2 → `billing_reply_to_email`, `billing_from_name` columns added to `tenant_invoice_settings` + DTO + PATCH validation.
- R3-E3 → Partial unique index `audit_log_overdue_once_per_day` shipped in migration `0011` via `CREATE INDEX CONCURRENTLY IF NOT EXISTS`; rollback documented.
- R3-E4 / R3-X1 → Template-version pinning rule documented under Template Versioning §; resend + void + Blob-recovery all re-use document's pinned `pdf_template_version`; assertion added to `pdf-deterministic.test.ts`.
- R3-E5 → `tenant_logo_count` column added with CHECK (0..50) + `logo_history_cap_reached` error code in contracts § 3.3.

Critique loop converged — 3 rounds (3🎯+9💡 → 0🎯+8💡 → 0🎯+6💡, all applied). Further critique rounds expected to yield diminishing returns; next step is `/speckit.tasks`.
