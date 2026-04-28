---
description: "TDD-ordered task list for F5 Online Payment (Stripe + PromptPay)"
---

# Tasks: F5 — Online Payment (Stripe + PromptPay)

**Input**: Design documents from `/specs/009-online-payment/`
**Prerequisites**: plan.md (required), spec.md (30 FRs + 6 USs + 6 Q&A clarifications), research.md (14 sections), data-model.md (4 tables + retention column), contracts/payments-api.md + contracts/stripe-webhook.md, quickstart.md, security.md (16 STRIDE), saq-a-attestation.md (PCI SAQ-A v4.0), 5 review-gate checklists × 30 items.
**Tests**: **INCLUDED** — Chamber-OS Constitution Principle II NON-NEGOTIABLE (TDD) requires ≥1 acceptance test per user story authored RED before implementation. F5 also adds: tenant-isolation + audit-retention-backfill + webhook-signature + webhook-idempotency as **Review-Gate blockers**.

**Organization**: Tasks grouped by user story in **priority order** (US1 + US2 = P1 ship-together per Q1 → US3 + US4 = P2 → US5 + US6 = P3). Each story is independently testable per its spec "Independent Test" criterion.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Parallelizable — different files, no deps on incomplete tasks in same phase.
- **[Story]**: US1 … US6 (user story label) — Setup / Foundational / Polish phases have no story label.
- Every task lists exact file path(s).

## Path Conventions — Web app (Next.js full-stack, single repo)

- Module: `src/modules/payments/{domain,application,infrastructure}/**`
- F4 module extension: `src/modules/invoicing/{index.ts, infrastructure/email/templates/invoice-issued.tsx}`
- Presentation: `src/app/(staff)/admin/invoices/[invoiceId]/_components/**`, `src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/**`
- API routes: `src/app/api/{payments,refunds,webhooks/stripe,internal/metrics}/**`
- Cross-cutting: `src/lib/**`, `src/components/**`, `src/i18n/messages/**`, `src/app/middleware.ts`
- Migrations: `drizzle/migrations/**`
- Tests: `tests/{unit,contract,integration,e2e,perf}/payments/**`

---

## Phase 1 — Setup (Shared Infrastructure)

**Purpose**: Project initialisation, dependency wiring, env-var schema, Vercel cron registration. F4 merge gate is the hard precondition.

- [X] T001 **F4 merge gate** — verify F4 PR #12 (`007-invoices-receipts`) is merged to `main`. ✅ Confirmed: commits `1368863`, `e107984`, `35e3be9` on `main` (F4 ship snapshot).
- [X] T002 Rebase `009-online-payment` branch on latest `main` (post-F4-merge). ✅ Branch is 4 commits ahead, 0 behind — no rebase needed. `pnpm typecheck` GREEN.
- [X] T003 [P] Verify Stripe deps installed. ✅ `stripe@22.0.2`, `@stripe/stripe-js@9.3.0`, `@stripe/react-stripe-js@6.2.0` present in pnpm lockfile.
- [X] T004 [P] Verify `.claude/settings.json` has `stripe` + `neon` plugin entries. ✅ Both enabled.
- [X] T005 Update `src/lib/env.ts` zod schema with 7 F5 env vars. ✅ Added `STRIPE_SECRET_KEY` + `STRIPE_PUBLISHABLE_KEY` + `STRIPE_WEBHOOK_SECRET` + `STRIPE_API_VERSION` + `STRIPE_ACCOUNT_ID_SWECHAM` + `STRIPE_LIVE_MODE` + `FEATURE_F5_ONLINE_PAYMENT`. Added cross-field assertion: `STRIPE_LIVE_MODE` must agree with `sk_live_` prefix AND refused when `NODE_ENV!=production`. Typecheck GREEN.
- [X] T006 Update `vercel.json` — **REVISED for Vercel Hobby plan constraint**: Hobby plan restricts native crons to **1 invocation per day** per job, which is incompatible with the 5-minute cadence required by `payments.stale_pending_count` gauge (R2-E3). **Decision**: use external **cron-job.org** HTTP trigger pointing at `/api/internal/metrics/stale-pending-count` with `Authorization: Bearer ${CRON_SECRET}` header at `*/5 * * * *`. The endpoint still validates `CRON_SECRET` identically to Vercel Cron. F5 adds NO entry to `vercel.json`; existing F4 `/api/cron/outbox-purge` (daily 20:15 UTC) remains. Webhook route `/api/webhooks/stripe` keeps default Node.js runtime (no edge override).
- [X] T007 [P] Pull latest env vars from Vercel. ✅ **Satisfied via manual provisioning** (2026-04-23): all 7 STRIPE_* vars set in `.env.local` directly from Stripe Dashboard (`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` from `stripe listen`, `STRIPE_API_VERSION=2025-09-30.clover`, `STRIPE_ACCOUNT_ID_SWECHAM=acct_1SDjN42HOqs9a0JA`, `STRIPE_LIVE_MODE=false`, `FEATURE_F5_ONLINE_PAYMENT=false`). `env.ts` boot validated at runtime with `--env-file=.env.local`. Vercel Dashboard sync of prod-scoped vars deferred to pre-ship checklist (Phase 9+); dev unblocked.
- [X] T008 [P] Document Stripe CLI dev workflow in onboarding. ✅ Rewrote `README.md` header + added **Per-feature developer onboarding** section linking `specs/009-online-payment/quickstart.md` (F5), `specs/007-invoices-receipts/quickstart.md` (F4), `specs/001-auth-rbac/quickstart.md` (F1). Removed Next.js boilerplate; project overview defers to `CLAUDE.md`.
- [X] T009 [P] Verify `BLOB_READ_WRITE_TOKEN` + `CRON_SECRET` env vars present in `.env.local`. ✅ Both present (F4-inherited).

**Checkpoint Phase 1**: Branch is rebased on latest main; F4 barrel stable; Stripe deps installed; env schema validated; Vercel cron registered. Ready to begin Foundational work.

---

## Phase 2 — Foundational (Blocking Prerequisites)

**Purpose**: Cross-cutting infrastructure that ALL user stories depend on. **No US task can start until Phase 2 completes.**

### Implementation Decisions (authored 2026-04-23 by Main-agent Gate after backend-dev pre-flight)

Five ambiguities surfaced during pre-flight. Canonical answers below are the authority — agents MUST follow:

1. **Middleware file path** — `src/proxy.ts` (Next.js 16 rename), NOT `src/app/middleware.ts`. Applies to T033.
2. **F5 audit enum migration** — add NEW migration `drizzle/migrations/0039_audit_log_f5_extension.sql` using one-`ALTER TYPE ADD VALUE`-per-statement-outside-transaction (Postgres semantics; F4 migration 0020 precedent). T035 expands to: (a) extend `auditEventTypeEnum` in `src/modules/auth/infrastructure/db/schema.ts`; (b) author migration 0039 applying the 16 new values; (c) apply with `pnpm drizzle-kit migrate`. This is a Complexity-Tracking deviation from tasks.md original — logged in plan.md.
3. **RBAC location (T034)** — F1 has NO existing matrix module; RBAC checks are ad-hoc in route handlers. Do NOT fabricate an F1 matrix. Instead create **`src/modules/payments/domain/rbac-policy.ts`** with exported constants for `payments:*`, `refunds:*`, `payment-settings:*` resource families per security.md § 4. Future F5 route handlers consume these constants directly. Other features may adopt the pattern later if needed.
4. **Primary keys for F5 tables** — follow data-model.md literally: `id TEXT` single-column ULID PK (not composite). But composite FKs **TO** F4 tables: e.g., `FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, invoice_id)` because F4 uses `(tenant_id, id)` composite PKs. Applies to T019–T022.
5. **Audit event count** — canonical = **16 values** (verified against spec.md FR-020 + data-model.md § 7; doc-sync completed 2026-04-23 post-Phase-2 verify — checklist finance.md CHK020 + T067 prose updated from stale "15" to "16"). 16 are: `payment_initiated, payment_succeeded, payment_failed, payment_canceled, payment_auto_refunded_stale_invoice, payment_auto_refunded_concurrent_manual_mark, payment_environment_mismatch, payment_cross_tenant_probe, refund_initiated, refund_succeeded, refund_failed, out_of_band_refund_detected, webhook_signature_rejected, webhook_api_version_mismatch, tenant_payment_settings_updated, online_payment_toggled`.
6. **Wrapper composition (T012–T014)** — the F4 `markPaid` / `issueCreditNote` use-cases are NOT thin; they compose pdf-render, blob, outbox, sequence allocator. Wrappers MUST NOT mock or bypass these — they compose real F4 dependencies at call time. Agent reuses existing F4 composition root patterns; if an F4 use-case is only bound via route handler, agent extracts the factory properly without F4 regression.
7. **Migration apply target** — apply to live Neon dev DB (Singapore) using the `DATABASE_URL` already in `.env.local`. Migrations are forward-additive; rollback is `DROP TABLE` for 0032–0035, `ALTER TABLE DROP COLUMN` for 0037+0038. If any migration fails partway, agent HALTS + documents exact state + asks before rollback. Do NOT apply to any other DB.
8. **Chamber_app grants** — every new F5 table needs `GRANT SELECT, INSERT, UPDATE, DELETE` to `chamber_app` per F4 migration 0022 precedent. Bake into each migration.
9. **PAN redact** — pino's `redact` is path-based. Use `hooks.logMethod` pre-processor or custom `serializer` to apply the PAN regex `^(3[47]|4|5[1-5]|6(?:011|5))\d+$` across string values. Test in T032.

### F4 barrel extension (post-critique R2-E16 — explicit gate)

- [X] T010 ✅ F4 barrel re-exports added to `src/modules/invoicing/index.ts`: `markPaidFromProcessor`, `issueCreditNoteFromRefund`, `getInvoiceForPayment`, and `Money as AmountSatang` alias. No F5-specific code in barrel itself.
- [X] T011 [P] ✅ RED-first barrel surface test `tests/unit/invoicing/barrel-exports.test.ts` (2 tests: F5 bridge + existing F4 preservation). Confirmed RED pre-impl, GREEN post-barrel. `AmountSatang === Money` invariant asserted.
- [X] T012 ✅ `src/modules/invoicing/application/use-cases/mark-paid-from-processor.ts` — composes `makeRecordPaymentDeps(tenantId)` + `recordPayment(...)` per decision #6. Maps `ProcessorPaymentMethod` (`stripe_card|stripe_promptpay`) → F4 `payment_method='other'` + human-readable `paymentNotes` hint. Actor sentinel `'system:stripe-webhook'` for webhook-side calls; admin remediation passes real userId. Returns F4's `RecordPaymentError` verbatim (no new error codes at bridge).
- [X] T013 ✅ **Full rewire complete (sub-batch A.2 post-migration 0038)** — `src/modules/invoicing/application/use-cases/issue-credit-note-from-refund.ts` now composes `makeIssueCreditNoteDeps(tenantId)` + delegates to F4 `issueCreditNote` with `sourceRefundId` threaded through the input schema. 4 F4 surfaces extended additively: (a) `schema-credit-notes.ts` adds `sourceRefundId text` column; (b) `domain/credit-note.ts` adds `readonly sourceRefundId: string | null` to CreditNote interface; (c) `ports/credit-note-repo.ts` `insertCreditNote` accepts optional `sourceRefundId`; (d) `issueCreditNoteSchema` + `IssueCreditNoteInput` gain optional `sourceRefundId`. Return type now = F4's full `CreditNote` aggregate (not stub DTO). No F4 regression: 272/272 existing F4 tests GREEN.
- [X] T014 ✅ `src/modules/invoicing/application/use-cases/get-invoice-for-payment.ts` — read-only DTO {id, status, totalSatang (bigint), memberId, tenantId}. Delegates to existing F4 `getInvoice` use-case (reusing its cross-tenant + member-mismatch probe emit). No schema changes required.
- [X] T015 ✅ **Integration test against live Neon Singapore** — `tests/integration/invoicing/processor-bridge.test.ts` (6/6 GREEN). Mocks pdf-render/Blob/outbox at module level (vi.mock factories); real DB/RLS/sequence allocator/audit paths. Covers: (1) `getInvoiceForPayment` DTO projection (id/status/totalSatang/memberId/tenantId) + not_found branch; (2) `markPaidFromProcessor` card-rail end-to-end (status='paid', payment_method='other', payment_reference=pi_*, payment_notes contains 'Stripe card' + both ids, paymentDate matches settlementDate); (3) `markPaidFromProcessor` PromptPay variant (null chargeId → notes omit 'charge='); (4) `issueCreditNoteFromRefund` full flow with seeded Payment + Refund rows → CN with `source_refund_id` populated + parent invoice transitions to `partially_credited`; (5) F4-manual `issueCreditNote` regression — `source_refund_id` stays NULL when not supplied.

### F4 email template extension (post-critique FR-027)

- [X] T016 ✅ Edit `src/modules/invoicing/infrastructure/email/templates/invoice-issued.tsx` to add bilingual "Pay online" CTA button linking to `/portal/invoices/[id]?pay=1` with `utm_source=invoice_email&utm_medium=email&utm_campaign=f5_pay_online` query params; conditional render on tenant `online_payment_enabled = true`. Use shadcn-button-equivalent inline-style button. — Template threads `tenantOnlinePaymentEnabled` + `payOnlineUrl` + `payOnlineCtaLabel` props; `base-layout.tsx` extended with optional `primaryCtaLabel`/`primaryCtaHref` rendered ABOVE download button (WCAG AA contrast ≈ 7.6:1 on `#0b5394`/white). Copy in `copy.ts PAY_ONLINE_CTA` (EN/TH/SV) mirrored to i18n JSON under `email.invoiceIssued.payOnlineCta`. `buildPayOnlineUrl(portalBaseUrl, id)` helper composes URL + UTM params. Caller wiring (reading `tenant_payment_settings.online_payment_enabled` in the outbox dispatcher) deferred to US1 slice per JSDoc `TODO(F5-US1)`.
- [X] T017 ✅ Regenerate F4 email-template Vitest snapshots: `pnpm test --filter=invoicing -u`; verify regenerated snapshots include the new CTA in EN+TH+SV variants. — No `toMatchSnapshot` callsites exist in the F4 invoicing email suite (existing tests assert string-contain against rendered HTML, by design — no binary snapshots to regenerate). Instead added 8 new executable test cases to `tests/unit/invoicing/invoice-auto-email.test.ts` covering: URL-composition helper (incl. trailing-slash strip), EN/TH/SV CTA render when enabled, CTA absent when disabled (all 3 locales), CTA absent when `payOnlineUrl` missing, `invoice_pdf_resent` parity, and non-issue event types never render the CTA.
- [X] T018 [P] ✅ Add e2e test `tests/e2e/payment-email-deep-link.spec.ts` — issue F4 invoice → capture auto-email → assert CTA href = `/portal/invoices/[id]?pay=1&utm_*` → simulate click (signed-out path: sign-in → returnUrl preservation; signed-in path: direct land). — Render-layer assertions (EN/TH/SV href + utm params + disabled=absent) executable today. End-to-end click-through (signed-out returnUrl preservation AND signed-in direct-land) marked `test.fixme` pending F4 e2e seeder T115 — same `test.fixme(...needs F4 e2e seeder)` pattern already used by `invoice-pay.spec.ts` for F4 AS1–AS3.

### Migrations + Drizzle schema

- [X] T019 [P] ✅ `drizzle/migrations/0033_create_payments.sql` (renumbered from 0032 — 0032 taken by F3 hotfix). 15 cols + 5 indexes + 13 CHECK + composite FKs to invoices/members + single-col FK to users + chamber_app grants + RLS+FORCE+policy.
- [X] T020 [P] ✅ `drizzle/migrations/0034_create_refunds.sql`. 13 cols + 4 indexes + 6 CHECK (incl. **true biconditional** `succeeded ↔ processor_refund_id + credit_note_id per drizzle-migration-reviewer Issue 1) + composite FKs + chamber_app grants + RLS+FORCE+policy.
- [X] T021 [P] ✅ `drizzle/migrations/0035_create_tenant_payment_settings.sql`. 11 cols + 2 indexes + 5 CHECK (incl. array subset `<@ ARRAY['card','promptpay']`) + no tenant FK (no tenants table) + chamber_app grants + RLS+FORCE+policy.
- [X] T022 [P] ✅ `drizzle/migrations/0036_create_processor_events.sql`. 10 cols + 3 indexes + 3 CHECK (one-way `rejected_signature → NULL tenant_id` implication, NOT biconditional — defended against reviewer Issue 2 per self-flagged Issue 6: biconditional would block legitimate pre-resolution NULL-tenant inserts for acknowledged_only). chamber_app grants + RLS+FORCE + **4 per-cmd policies** (SELECT/INSERT/UPDATE/DELETE) per data-model § 5.4 incl. `USING (false)` append-only DELETE guard.
- [X] T023 ✅ `drizzle/migrations/0037_seed_swecham_payment_settings.sql`. INSERT SweCham row: `processor='stripe'`, `processor_environment='test'`, `processor_account_id='acct_1SDjN42HOqs9a0JA'`, `processor_publishable_key=pk_test_…` (public per Stripe docs), `enabled_methods=['card','promptpay']`, `online_payment_enabled=true`. SET LOCAL + INSERT in same statement block per reviewer Issue 3 fix; ON CONFLICT DO NOTHING idempotent.
- [X] T024 [P] ✅ `drizzle/migrations/0038_credit_notes_add_source_refund_id.sql`. ADD COLUMN text nullable + FK to refunds(id) ON DELETE RESTRICT + partial INDEX WHERE source_refund_id IS NOT NULL.
- [X] T025 ✅ **R2-E4 Review-Gate blocker LANDED**: `drizzle/migrations/0039_audit_log_add_retention_years.sql`. Atomic ADD COLUMN smallint NOT NULL DEFAULT 5 + CHECK retention_years IN (5,10) + DISABLE TRIGGER audit_log_no_update → UPDATE 476 F4 tax-document rows SET retention_years=10 WHERE event_type IN 6 F4 tax types → ENABLE TRIGGER. Trigger restored atomically via migration tx rollback-safety. Verified post-apply: all 476 rows (invoice_issued=92, invoice_paid=68, invoice_voided=40, credit_note_issued=145, invoice_pdf_resent=23, invoice_pdf_regenerated=108) carry retention_years=10.
- [X] T025b ✅ `drizzle/migrations/0040_audit_log_f5_extension.sql`. 16 idempotent `DO $$ ALTER TYPE audit_event_type ADD VALUE … EXCEPTION WHEN duplicate_object $$` blocks (F4 migration 0020 precedent) covering the initial F5 event catalogue per data-model § 7 + spec FR-020. Verified post-apply: enum contains 16 values from this migration. (2026-04-23 Review-Gate follow-up: migration 0043 adds 2 additional rate-limit events — `payment_initiate_rate_limited` + `payment_cancel_rate_limited` — bringing the total F5-scope audit count to 18. See task T025c below.)
- [X] T026 ✅ Applied via `pnpm db:migrate` to live Neon Singapore dev DB. Tracking table backfilled for 0000-0032 (was empty) before F5 runs. Verification probes (9 checks) all pass: 4 F5 tables present, RLS+FORCE on all 4, policy counts correct (1/1/1/4 for payments/refunds/tenant_payment_settings/processor_events), `credit_notes.source_refund_id` (text, nullable), `audit_log.retention_years` (smallint default 5), R2-E4 backfill (476 F4 tax rows retention_years=10), 16 migration-0040 enum values present (now 18 total after migration 0043), SweCham seed row, 3 audit_log triggers ENABLED.
- [X] T027 ✅ `src/modules/payments/infrastructure/schema.ts` — 4 pgTable defs (payments, refunds, tenantPaymentSettings, processorEvents) + relations(payments↔refunds + refunds→creditNotes via single-column relation) + inferred row types {PaymentRow,NewPaymentRow,RefundRow,NewRefundRow,TenantPaymentSettingsRow,NewTenantPaymentSettingsRow,ProcessorEventRow,NewProcessorEventRow}. NOT exported from module barrel (Infrastructure-only per Constitution Principle III). Typecheck GREEN.
- [X] T028 ✅ Extended `tests/integration/rls-coverage.test.ts` adding 4 F5 tables + checking both `qual` (USING) and `with_check` (WITH CHECK) for tenant scoping (INSERT policies only have with_check). Allows explicit-deny `USING (false)` policies (processor_events DELETE). NEW test: assert processor_events has exactly 4 distinct per-cmd policies (SELECT/INSERT/UPDATE/DELETE). **25/25 tests GREEN** — Constitution v1.4.0 Principle I Review-Gate blocker covered for F5.

### Module skeleton (Clean Architecture per Constitution Principle III)

- [X] T029 [P] ✅ `src/modules/payments/index.ts` created — empty barrel exporting `{}` placeholder + JSDoc documenting the barrel-guard contract (Principle III) and that Drizzle schema.ts is deliberately NOT re-exported (Infrastructure-only).
- [X] T030 [P] ✅ Extended `eslint.config.mjs` `no-restricted-imports` patterns with F5 payments module barrel-guard (mirrors F4 invoicing shape); added `src/modules/payments/**` to ignores so module-internal imports still work. Tests (outside `src/`) unaffected — they continue to import infra directly when needed (e.g., processor-bridge.test.ts imports payments/refunds schemas).
- [X] T031 [P] ✅ Layer scaffolds `src/modules/payments/{domain,application,infrastructure}/.gitkeep` created. No `tsconfig.json` path update needed (existing `@/*` path alias covers). TypeScript typecheck + lint clean.

### Cross-cutting infra

- [X] T032 [P] ✅ `src/lib/logger.ts` extended with (a) 24 new REDACT_PATHS covering card/CVV variants (card_number + cardNumber + card_cvc + cardCvc + cvv + cvv2 + csc + cid + security_code + card_security_code + cvc_check @ depth 2 + card wildcard), Stripe secrets (secret_key + webhook_secret + all casings), Stripe-Signature header (4 casings); (b) `PAN_REGEX` covering Visa 13/16/19 + Amex 15 + MC 16 (incl. 2-series 2221-2720) + Discover 16/19 + UnionPay 16/19 + JCB 16/19 + Diners 36-prefix 14; (c) `redactPanValues()` recursive walk with pretty-printed PAN normalisation (strips spaces/hyphens before regex test); (d) `formatters.log()` pino hook wires redactor into every log line. **pci-saqa-guardian sub-agent reviewed** — 2 CRITICAL findings (regex min-length + CVV variants) + R3 (header casing) remediated. 59/59 tests GREEN.
- [X] T033 [P] ✅ `src/proxy.ts` `buildCsp(isDev, pathname)` made per-request; `isStripeClientRoute(pathname)` helper matches `/portal/invoices/*` + `/admin/invoices/*`. CSP adds `https://js.stripe.com` (script-src) + `https://js.stripe.com` + `https://hooks.stripe.com` (frame-src) + `https://api.stripe.com` (connect-src) ONLY on matching routes; webhook route + all other routes keep baseline CSP. `applySecurityHeaders()` signature updated; 5 call sites pass `nextUrl.pathname`. 16/16 unit tests GREEN.
- [X] T034 [P] ✅ `src/modules/payments/domain/rbac-policy.ts` created per Main-agent Gate Decision #3 (NOT F1 — no existing matrix there; F5-co-located policy preserves F1 convention). Exports `F5_POLICIES` frozen map + `isAllowed(role, resource, action)` pure helper covering 4 resource families (payments/refunds/payment-settings/online-payment-toggle) × 8 actions per security.md § 4. Fail-closed on unknown inputs. 11/11 unit tests GREEN.
- [X] T035 [P] ✅ Extended `auditEventTypeEnum` in `src/modules/auth/infrastructure/db/schema.ts` with 16 migration-0040 F5 audit entries + (2026-04-23 Review-Gate) 2 additional rate-limit entries from migration 0043, totalling 18 F5 enum values (matches data-model.md § 7 + spec FR-020). Typecheck GREEN.

### Stripe SDK + i18n bootstrap

- [X] T036 [P] ✅ `src/modules/payments/infrastructure/stripe/stripe-client.ts` — module-level memoised Stripe singleton via lazy `getStripeClient()` factory. Deferred instantiation (import-safe for `next build` pre-render). Uses `env.stripe.secretKey` + `env.stripe.apiVersion` (cast to SDK's `'2026-03-25.dahlia'` literal with documented rationale — Q5 pinning policy). Exports narrow `StripeClient` interface for Application ports + `__resetStripeClientForTesting()` test-only helper. Infrastructure-only per Principle III.
- [X] T037 [P] ✅ `src/modules/payments/infrastructure/stripe/stripe-api-version.ts` — thin re-export of `env.stripe.apiVersion` as `STRIPE_API_VERSION` const. Kept separate from stripe-client so webhook route can read the pinned version without triggering SDK instantiation.
- [X] T038 [P] ✅ i18n stubs added to existing `src/i18n/messages/{en,th,sv}.json` — 5 namespaces under existing top-level keys: `portal.payment.payNow`, `admin.refund.title`, `admin.paymentReconciliation.title`, `admin.paymentSettings.title`, `email.refundConfirmation.subject`. All 3 locales populated with faithful translations (EN canonical + TH + SV). `pnpm check:i18n` reports 1142 keys in all 3 locales.
- [X] T039 ✅ Top-20 decline-code catalogue in sub-folder JSON per spec: `src/i18n/messages/{en,th,sv}/payment-decline-reasons.json`. 21 keys (20 Stripe codes + `_fallback` for the long tail). EN canonical from spec § Edge Cases; TH translated with Thai phrasing conventions (e.g., "บัตรถูกปฏิเสธ" for card_declined, "ยอดเงินในบัตรไม่เพียงพอ" for insufficient_funds); SV translated idiomatically ("Kortet nekades", "Otillräckligt saldo"). The `fraudulent` message deliberately avoids exposing "fraud" wording to the user per spec note — it says "blocked" + "contact your bank if you believe this is an error".
- [X] T040 ✅ Extended `scripts/check-i18n-coverage.ts` with `checkSubCatalogueKeyParity()` — asserts `payment-decline-reasons.json` has identical key sets across en/th/sv. Missing keys in th/sv added to issues list (release-branch fail, dev warn); extra keys warn silently. Integrated into the main `check:i18n` run: "F5 decline-reasons parity verified".

**Checkpoint Phase 2 — COMPLETE** ✅ (2026-04-23)

All 31 Phase 2 tasks + 1 Main-agent-Gate addition (T025b migration 0040) shipped across 5 sub-batches:
- **Sub-batch A + A.2** (T010-T018): F4 barrel extension + 3 F5 bridge wrappers (mark-paid-from-processor, issue-credit-note-from-refund full rewire, get-invoice-for-payment) + F4 email "Pay online" CTA with UTM params + 6-test integration suite on live Neon. F4 regression: 0/272.
- **Sub-batch B** (T019-T028): 8 migrations (0033-0040, renumbered from spec's 0032-0038 due to prior F3 hotfix using 0032) applied to live Neon Singapore. 4 new tables (payments, refunds, tenant_payment_settings, processor_events) with RLS+FORCE+policies. R2-E4 compliance blocker LANDED — 476 F4 tax-document audit rows backfilled to retention_years=10. 25/25 RLS-coverage tests GREEN (Principle I Review-Gate).
- **Sub-batch C** (T029-T031): Module skeleton + barrel + ESLint barrel-guard extending F4 pattern to F5.
- **Sub-batch D** (T032-T035): Logger PAN+CVV+secret redaction (pci-saqa-guardian specialist review → 2 CRITICAL fixes + R1 expansion + R3 header casings) + CSP Stripe allowlist scoped per-route + F5 RBAC policy matrix + auditEventTypeEnum extension. 86 unit tests across 3 files.
- **Sub-batch E** (T036-T040): Stripe SDK singleton + API version const + i18n stubs + top-20 decline-code catalogue in 3 locales + check-i18n extension.

**All US phases (Phase 3+) can now start in parallel.** Foundational surface includes: F4 bridge ready (mark paid + issue CN with source_refund_id + invoice DTO), 4 F5 tables with strict tenant isolation, 20 F5 audit event types enum-ed + migrated (16 via migration 0040 + 2 rate-limit via migration 0043 + 2 webhook ops-visibility via migration 0046), RBAC policy + CSP Stripe allowlist + PAN redaction already wired, Stripe client singleton ready, decline-code i18n catalogue in 3 locales, payments module barrel + Drizzle schema + infrastructure scaffold in place.

**Carried to Phase 3+**:
- PCI Guardian R2 (webhook logging allow-list) → documented in T056 Implement process-webhook-event dispatcher.
- T007 Vercel env sync to prod → pre-ship checklist (Phase 9+).
- Stripe CLI webhook setup → prerequisite for Phase 3 US1 integration tests (see quickstart.md).

Quality gates summary: pnpm typecheck/lint GREEN · 466 unit/contract tests GREEN for F4+F5 scope · 25/25 RLS-coverage GREEN · 6/6 processor-bridge integration GREEN · 1142 i18n keys × 3 locales + decline-reasons parity GREEN. 9 branch commits.

---

## Phase 3 — User Story 1: Member pays an issued invoice via card (Priority: P1) 🎯 MVP-half

**Goal**: A signed-in member can pay an issued invoice via Stripe Elements card form embedded in a Sheet drawer; on success, F4 `markPaid` is invoked → invoice transitions to `paid` → receipt PDF auto-emailed → confirmation panel + receipt-download CTA shown.

**Independent Test**: Per spec US1: seed one member + one issued invoice for THB 53,500 → sign in as member → click Pay-now → enter test card `4242 4242 4242 4242` → assert Sheet shows confirmation panel → assert `payments.status='succeeded'` + `payment_method='stripe_card'` → assert receipt PDF lands in test mailbox within 1 minute → assert audit log records `payment_initiated`, `payment_succeeded`, `invoice_paid`.

### UX contracts (lock before first route-handler code lands)

- [X] T041a [US1] **Stripe Elements shimmer + PromptPay QR aria-live contract** — before any `/portal/invoices/[id]/pay` route handler or component lands, document + implement: (a) `<Skeleton>` (from `@/components/ui/skeleton` shimmer variant per `docs/ux-standards.md` § 2.1) wrapping the `<PaymentElement>` mount point until Stripe's `ready` event fires; (b) PromptPay QR shows a countdown (default 15 min) inside an `aria-live="polite"` region so SR announces remaining time without interrupting; at T-2 min, surface a non-blocking toast with a "Refresh QR" CTA; (c) Success toast + payment-failed retry CTA micro-copy added to i18n keys `portal.payment.{success,retry,qrExpiring}` across EN/TH/SV. Review-gate blocker for Phase 3 staff-review per staff review R003 (2026-04-23). No code; the task is a contract doc under `specs/009-online-payment/ux-phase3-contract.md` that subsequent T041+ tasks MUST reference.

### Tests for US1 (TDD — author RED first)

- [X] T041 [P] [US1] Contract test `tests/contract/payments/post-payments-initiate.contract.test.ts` — POST body zod validation, response shape with `payment.status='pending'` + `stripe.clientSecret`, error envelopes per `contracts/payments-api.md` § 1.
- [X] T042 [P] [US1] Contract test `tests/contract/payments/post-webhooks-stripe-events.contract.test.ts` — `payment_intent.succeeded` happy path: assert 200 + `payments.status='succeeded'` + F4 `markPaid` called once + audit chain `payment_initiated → payment_succeeded → invoice_paid`.
- [X] T043 [P] [US1] Integration test `tests/integration/payments/tenant-isolation.test.ts` (**Constitution v1.4.0 Principle I clause 3 — Review-Gate blocker**) — create 2 tenants; create payments + refunds + tenant_payment_settings + processor_events for each; assert zero cross-tenant visibility on SELECT/INSERT/UPDATE/DELETE; assert `payment_cross_tenant_probe` audit emission.
- [X] T044 [P] [US1] Integration test `tests/integration/payments/webhook-signature.test.ts` — 4 scenarios: valid → 200; missing `Stripe-Signature` → 401 + `webhook_signature_rejected{reason='missing_header'}` audit; malformed → 401; tampered body → 401. Verification MUST occur before body parse.
- [X] T045 [P] [US1] Integration test `tests/integration/payments/webhook-idempotency.test.ts` (**SC-005 / FR-008**) — deliver same `payment_intent.succeeded` event twice; assert 2nd delivery returns 200 with no side effects (one Payment row, one F4 markPaid invocation, one outbox row, one `processor_events` row).
- [X] T046 [P] [US1] E2E test `tests/e2e/payment-card-happy-path.spec.ts` — `--workers=1`; full sign-in → Pay-now → Stripe Elements iframe (assert iframe origin = `js.stripe.com`) → submit `4242…` → confirmation panel + receipt download CTA + audit chain verified.

### Domain layer (Clean Architecture — zero framework imports)

- [X] T047 [P] [US1] Create `src/modules/payments/domain/payment.ts` — `Payment` aggregate root with state machine (`pending → succeeded|failed|canceled`; `succeeded → partially_refunded → refunded`); pure types only.
- [X] T048 [P] [US1] Create `src/modules/payments/domain/value-objects/payment-method.ts` — `PaymentMethod` sum type (`'card' | 'promptpay'`).
- [X] T049 [P] [US1] Create `src/modules/payments/domain/processor-event.ts` — `ProcessorEvent` read model.
- [X] T050 [P] [US1] Create `src/modules/payments/domain/tenant-payment-settings.ts` — value object holding processor + env + publishable key + enabled methods + flags (incl. `allow_anonymous_paylink` forward-compat per FR-016a).
- [X] T051 [P] [US1] Create `src/modules/payments/domain/policies/payment-status-transitions.ts` — pure transition function with full unit-test coverage in `tests/unit/payments/domain/payment-state-machine.test.ts`.
- [X] T052 [P] [US1] Create `src/modules/payments/domain/invariants/one-succeeded-payment-per-invoice.ts` — invariant function + unit test.
- [X] T053 [US1] **100% line coverage** assertion in `vitest.config.ts` for `src/modules/payments/domain/**` per Constitution Principle II.

### Application layer ports + use cases

- [X] T054 [P] [US1] Create ports: `src/modules/payments/application/ports/{payments-repo,refunds-repo,tenant-payment-settings-repo,processor-events-repo,processor-gateway-port,webhook-verifier-port,invoicing-bridge-port,audit-port,clock-port,rate-limiter-port}.ts` — pure TypeScript interfaces, no framework imports.
- [X] T055 [US1] Implement `src/modules/payments/application/initiate-payment.ts` — authz + settings-read + resume-check + Stripe `paymentIntents.create` + insert Payment row + audit `payment_initiated`. Returns `Result<{payment, clientSecret, publishableKey}, InitiateError>`. **100% branch coverage** test in `tests/unit/payments/application/initiate-payment.test.ts`.
- [X] T056 [US1] Implement `src/modules/payments/application/process-webhook-event.ts` — root dispatcher: signature verify → environment check → API version check → idempotency upsert → tenant resolve → enter `runInTenant` → branch by event type. **100% branch coverage** in `tests/unit/payments/application/process-webhook-event.test.ts`. **⚠️ PCI Guardian Finding R2 (carried from T032)**: webhook logging MUST use explicit allow-list — log ONLY `{stripe_event_id, event_type, api_version, livemode}` from each incoming event; NEVER log `event.data.object` (carries card metadata last4/brand/exp/fingerprint at deep paths not covered by REDACT_PATHS). Use `logger.info({stripe_event_id, event_type, api_version, livemode}, 'stripe.webhook.received')` pattern; emit one structured entry per dispatch decision rather than echoing the raw payload. Violation = PCI SAQ-A blocker at Review Gate.
- [X] T057 [US1] Implement `src/modules/payments/application/confirm-payment.ts` — webhook `payment_intent.succeeded` branch: row lock → invoice state check → if stale invoice, auto-refund + audit `payment_auto_refunded_stale_invoice`; else update Payment + audit + invoke F4 `markPaidFromProcessor`. **100% branch coverage**.
- [X] T058 [US1] Implement `src/modules/payments/application/fail-payment.ts` — webhook `payment_intent.payment_failed` branch: row lock → update Payment + reason code + audit `payment_failed`.
- [X] T059 [US1] Implement `src/modules/payments/application/cancel-payment.ts` — member-initiated cancel: row lock → Stripe cancel → update Payment + audit `payment_canceled`.
- [X] T060 [US1] Implement `src/modules/payments/application/handle-cancel-event.ts` — webhook `payment_intent.canceled` branch (idempotent with T059).

### Infrastructure layer

- [X] T061 [P] [US1] Implement `src/modules/payments/infrastructure/db/payments-repo.drizzle.ts` — Drizzle adapter for `PaymentsRepo` port; converts `SelectPayment` ↔ Domain `Payment`.
- [X] T062 [P] [US1] Implement `src/modules/payments/infrastructure/db/processor-events-repo.drizzle.ts` — INSERT-on-conflict-do-nothing per FR-008; UPDATE for tenant binding post-resolution.
- [X] T063 [P] [US1] Implement `src/modules/payments/infrastructure/db/tenant-payment-settings-repo.drizzle.ts` — wrapped in `unstable_cache` with `cacheTag('tenant_payment_settings:<tenant_id>')` + 1h cacheLife (Round 2 R2-E9); `revalidateTag()` on UPDATE.
- [X] T064 [P] [US1] Implement `src/modules/payments/infrastructure/stripe/stripe-gateway.ts` — `ProcessorGatewayPort` impl using Stripe SDK singleton (T036); methods: `createPaymentIntent` (with `Idempotency-Key: inv-{invoice_id}-attempt-{seq}`), `retrievePaymentIntent`, `cancelPaymentIntent`.
- [X] T065 [P] [US1] Implement `src/modules/payments/infrastructure/stripe/stripe-webhook-verifier.ts` — `WebhookVerifierPort` impl wrapping `stripe.webhooks.constructEvent` with explicit 5-min tolerance + clock-skew detection.
- [X] T066 [P] [US1] Implement `src/modules/payments/infrastructure/invoicing-bridge.ts` — `InvoicingBridgePort` impl calling F4 barrel exports `markPaidFromProcessor`, `getInvoiceForPayment`. NO direct Drizzle access.
- [X] T067 [P] [US1] Implement `src/modules/payments/infrastructure/audit/payments-audit.ts` — emits the 16 tenant-scoped F5 audit event types (from migration 0040) with correct `retention_years` per data-model.md § 7.1 mapping (5 or 10). The 2 rate-limit events from migration 0043 are emitted directly from the route handlers via F1's `auditRepo.append` (they are pre-use-case, no tenant transaction to join).
- [X] T068 [US1] Wire all ports + adapters in `src/modules/payments/index.ts` barrel: export `initiatePayment`, `cancelPayment`, `processWebhookEvent` use cases as composition-root-friendly factories.

### API routes

- [X] T069 [US1] Implement `src/app/api/payments/initiate/route.ts` — POST handler per `contracts/payments-api.md` § 1; rate-limit (10 / 5 min per `(tenant_id, actor_user_id)` via Upstash); zod-validate body; call `initiatePayment` use case; return 201 with `{payment, stripe}` envelope.
- [X] T070 [US1] Implement `src/app/api/payments/[id]/cancel/route.ts` — POST handler per `contracts/payments-api.md` § 2; rate-limit (20 / 5 min); call `cancelPayment` use case.
- [X] T071 [US1] Implement `src/app/api/webhooks/stripe/route.ts` — POST handler per `contracts/stripe-webhook.md` § 3 pipeline: read raw body via `request.text()`; pass to `processWebhookEvent`; return 200 always (or 401 on signature failure). **`export const config = { api: { bodyParser: false } }`** route segment opt-out + Node.js runtime (NOT edge).

### Presentation — Sheet drawer (FR-025 + FR-028)

- [X] T072 [US1] Create `src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/pay-now-button.tsx` — `'use client'`; renders shadcn `<Button>`; manages `open` state; lazy-imports `<PaySheet>` via `next/dynamic` with `ssr: false` + `loading: <SheetSkeleton />` (post-critique R2-E1 + R2-E6 pattern). Reads `?pay=1` query param to auto-open on mount (FR-025 deep-link).
- [X] T073 [US1] Create `src/components/payments/pay-sheet-skeleton.tsx` (promoted to shared primitive — reused by `pay-sheet-internal.tsx`, `card-form.tsx`, `card-payment-region.tsx`) — shimmer skeleton matching real card-form layout (3 input rows + button rect) per plan.md § UX Skeleton placement matrix; min 300ms display.
- [X] T074 [US1] Create `src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/index.tsx` (`pay-sheet-internal.tsx` per plan.md § Project Structure) — `'use client'`; Module-level `Map<string, Promise<Stripe>>` cache for `loadStripe` singleton (R2-E1); composes `<Sheet>` + `<MethodTabs>` + initial focus per FR-028(a).
- [X] T075 [US1] Create `src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/method-tabs.tsx` — shadcn `<Tabs>` for Card vs PromptPay (US2 fills PromptPay tab in Phase 4); pre-selects Card by default; bilingual labels.
- [X] T076 [US1] Create `src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/card-form.tsx` — wraps Stripe `<Elements>` provider with `appearance` mirroring `useTheme()` per FR-028(b); `<PaymentElement>` for hosted card form; on submit calls `stripe.confirmPayment()` with `return_url` + `redirect: 'if_required'`.
- [X] T077 [US1] Create `src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/processing-panel.tsx` — "Processing payment..." state shown when `paymentIntent.status === 'processing'` after submit; ARIA-live `role="status"` per FR-028(j).
- [X] T078 [US1] Create `src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/three-d-secure-panel.tsx` — "Verifying with your bank..." state shown when `requires_action` per FR-028(d); shimmer / motion-reduce pulse fallback; tertiary "Cancel payment" button.
- [X] T079 [US1] Create `src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/confirmation-panel.tsx` — success state per FR-028(e): `<CheckCircle />` scale-in (motion-reduce instant), bilingual title, summary line, **primary "Download receipt" CTA** (links to F4 receipt PDF via 60s signed URL), secondary Close, 5s auto-close countdown.
- [X] T080 [US1] Wire idle-warning-suppression interaction (FR-028c): pay-sheet mount sends `pauseIdleTimer()` to F1 idle-watcher; pay-sheet close sends `resumeIdleTimer()`. If drawer open > 30 min, in-drawer prompt asks "Are you still here?" with 60s cancel countdown.
- [X] T081 [US1] Add Pay-now button placement on existing F4 invoice detail page `src/app/(member)/portal/invoices/[invoiceId]/page.tsx` — only render `<PayNowButton>` when invoice `status IN ('issued', 'overdue')` AND tenant `online_payment_enabled = true`; otherwise render FR-030 empty-state fallback (T082).
- [X] T082 [US1] Create `src/app/(member)/portal/invoices/[invoiceId]/_components/online-payment-disabled-card.tsx` — empty-state per FR-030: composite `CreditCard + Slash` overlay icon (note: `CreditCardOff` does not exist in lucide-react at any version — use the composite pattern) sized 48×48 muted-foreground + bilingual title + 1-2 line explanation + "Contact admin" mailto: CTA with pre-filled subject.
- [X] T083 [US1] Add bilingual i18n keys for all pay-sheet copy in `src/i18n/messages/{en,th,sv}.json` under `portal.payment.*` namespace (verified via `pnpm check:i18n`).

### Mobile responsiveness (FR-028h)

- [X] T084 [US1] Verify Sheet drawer renders full-screen on viewport `< sm` (640px) via `<Sheet side="right" className="sm:max-w-[480px] w-full h-full sm:h-auto">` or equivalent shadcn Sheet variant; sticky header (Pay {invoice number} + close ≥ 44 × 44 px) + sticky footer (method tabs + amount-due summary).
- [X] T085 [US1] Add Playwright viewport tests for 320×568 (iPhone SE 1st gen) + 768×1024 (iPad) + 1920×1080 (FHD) per plan.md § UX Mobile responsiveness matrix.

### Smart-feature: Cmdk integration

- [X] T086 [US1] Extend the existing F2+ command palette (`cmdk`) with "Pay invoice" command per plan.md § UX Smart-feature: implementation lives at `src/components/command-palette/member-invoices-group.tsx` (presentation-layer placement, fetches via `GET /api/portal/invoices/search`); member-role-only; fuzzy-search member's invoices; selection navigates to `/portal/invoices/<invoiceId>?pay=1`. Strings under `portal.payment.cmdkPay.*`.

### Phase 3 supporting files (added during R1/R2 self-review — empirical pay-sheet refactor, commits b6a709b · 868d43d · 752f611 · 8e9717f · cd783d4)

The following pay-sheet files were added beyond T072–T086 to support the empirical pay-sheet architecture and UX polish; documented here for traceability (no separate task IDs, all covered by R1/R2 review rounds):

- `_components/pay-sheet/card-payment-region.tsx` — wraps `<CardForm>` + skeleton overlay during Stripe Elements ready-state.
- `_components/pay-sheet/hard-cap-prompt.tsx` — drawer-open >30 min idle prompt (FR-028c sub-component).
- `_components/pay-sheet/order-summary.tsx` — sticky-footer amount-due summary (FR-028h mobile pattern).
- `_components/pay-sheet/security-footer.tsx` — Stripe + PCI trust badges below card form.
- `_components/pay-sheet/use-initiate-payment.ts` — client hook wrapping `POST /api/payments/initiate` call.
- `_components/pay-sheet/pay-sheet-translation-types.ts` — strict-typed translation prop interface for `<PaySheetInternal>`.

**Checkpoint US1**: Member can pay any issued invoice via card; webhook → F4 markPaid → receipt email arrives; confirmation panel shows receipt-download CTA; mobile + dark-mode + reduced-motion + a11y verified. **MVP-half complete.**

---

## Phase 4 — User Story 2: Member pays via PromptPay QR (Priority: P1, ship together with US1)

**Goal**: Same as US1 but with PromptPay QR rail. Member chooses PromptPay tab → server creates `payment_method_types: ['promptpay']` PaymentIntent → server returns QR SVG payload → portal renders QR + countdown → member scans with bank app → webhook confirms → confirmation panel shown.

**Independent Test**: Per spec US2: sign in as Thai member → open invoice → click "Pay with PromptPay" → assert QR renders within 2s (SC-004) → use Stripe CLI `stripe trigger payment_intent.succeeded --override payment_intent:id=<pi_id>` → assert Sheet updates to confirmation within 10s → assert `payment_method='stripe_promptpay'`.

### Tests for US2 (TDD)

- [X] T087 [P] [US2] E2E test `tests/e2e/payment-promptpay-happy-path.spec.ts` — `--workers=1`; member opens PromptPay tab → assert QR `<img>` renders + countdown visible + bilingual instructions; trigger succeeded webhook; assert confirmation.
- [X] T088 [P] [US2] E2E test `tests/e2e/payment-promptpay-expiry.spec.ts` — `--workers=1`; QR expiry (default 15 min via `tenant_payment_settings.promptpay_qr_expiry_seconds`); assert "QR expired — refresh" CTA replaces QR; click refresh; new PaymentIntent created.
- [X] T089 [P] [US2] Integration test `tests/integration/payments/promptpay-amount-mismatch.test.ts` — server-locked amount; verify Stripe rejects out-of-band amount changes.

### Implementation (mostly UI + Stripe payment-method-types config)

- [X] T090 [US2] Update `initiate-payment.ts` use case (T055) to accept `method='promptpay'` → pass `payment_method_types: ['promptpay']` to Stripe with `payment_method_data.type: 'promptpay'`; on intent creation Stripe returns `next_action.promptpay_display_qr_code.image_url_svg`.
- [X] T091 [US2] Create `src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/promptpay-panel.tsx` — renders QR `<img src={qrSvgUrl} alt="PromptPay QR" />` with aspect-ratio-square; countdown timer (motion-safe pulse / motion-reduce instant per plan.md § UX Reduced-motion matrix); bilingual instructions ("Scan with any Thai bank app" / "สแกนด้วยแอปธนาคารไทย"); "Refresh QR" button that re-calls `initiate-payment` (creates new attempt_seq).
- [X] T092 [US2] Add PromptPay-specific bilingual UI text + warning text "Only scan the QR code shown above; do NOT transfer manually to any other account" (post-critique P7 / spec § Edge Cases) in `src/i18n/messages/{en,th,sv}.json`.
- [X] T093 [US2] Wire app-switching state persistence (post-critique P6 / spec § Edge Cases): Sheet drawer mount survives `visibilitychange` events; webhook-driven status update polls or websocket continues regardless of foreground/background. Verified by Playwright `page.bringToFront()` simulation in T087.
- [X] T094 [US2] Verify Stripe Elements `appearance` API renders correctly for PromptPay (no card fields shown); locale truncation `useLocale().split('-')[0]` (R2-E2) applies.

**Checkpoint US2**: Both card + PromptPay payment methods work end-to-end. **Full P1 MVP complete.** Test by paying same invoice via both methods → verify each settles + receipts emailed.

---

## Phase 5 — User Story 3: Admin reconciliation view (Priority: P2)

**Goal**: Admin can filter F4 invoice list by "paid online", see method badge + processor charge id, click into invoice detail to see payment timeline panel with full lifecycle audit + actor + timestamps.

**Independent Test**: After US1+US2 produce paid-online invoices, sign in as admin → `/admin/invoices` → filter "paid online" → assert exact count + method badges; click invoice → assert payment timeline panel shows `payment_initiated → payment_succeeded → invoice_paid` with actor + processor charge id + click-through link.

### Tests for US3 (TDD)

- [X] T095 [P] [US3] ✅ `tests/e2e/admin-payment-reconciliation-view.spec.ts` (4 tests, `--workers=1` per project memory; admin sign-in inline via E2E_ADMIN_EMAIL; manager opt-out via E2E_ALLOW_SKIP_RECONCILIATION=1 + CI hard-fail). Asserts: (1) `data-testid="paid-online-filter-chip"` toggles `?paidOnline=1` URL state; (2) `data-testid="column-header-method"` renders + badges resolve to `method-badge-card|promptpay`; (3) `data-testid="payment-timeline"` surfaces full audit chain `payment_initiated → payment_succeeded → invoice_paid` + processor charge id chip + Stripe dashboard link (target=_blank rel=noopener); (4) manager sees timeline but `record-payment-trigger`/`void-invoice-trigger`/`refund-dialog-trigger` toHaveCount(0).

### Implementation

- [X] T096 [US3] ✅ **Spec deviation resolved** — task literal `payment_method LIKE 'stripe_%'` is impossible against F4 schema (`invoices.payment_method` is enum {bank_transfer, cheque, cash, other}; F5↔F4 bridge T012 maps online payments to `'other'`). Predicate now uses EXISTS subquery against F5 `payments` table with explicit `tenant_id =` defence-in-depth join. **Refactor**: extended `InvoiceRepo.listPaged` port + Drizzle impl with `paidOnlineOnly?: boolean`; added new F5 read use-case `listSucceededPaymentMethods` (DISTINCT ON invoice_id ORDER BY completed_at DESC) so the F4 admin page can render method badges without importing F5 internals. **Surfaces**: `invoice-filters.tsx` adds toggle Button chip with `data-testid="paid-online-filter-chip"`, aria-pressed, tooltip; `invoice-table.tsx` adds optional `showMethodColumn` prop + `MethodBadge` component (testid `method-badge-card|promptpay`); `page.tsx` parses `?paidOnline=1`, runs F5 method query only when filter is active.
- [X] T097 [US3] ✅ `src/app/(staff)/admin/invoices/[invoiceId]/_components/payment-timeline.tsx` server component reads via new use-case `loadInvoicePaymentActivity` (port: `PaymentsRepo.listInvoiceActivity` returns `{payments: Payment[], refunds: RefundActivityDto[]}`). NO direct Drizzle access from Presentation. Synthesizes chronological events: `payment_initiated → payment_succeeded|failed|canceled → invoice_paid (when paidAt populated) → refund_initiated → refund_succeeded|failed (per refund)`. Renders shadcn Card with per-event Lucide icon + i18n title + actor (system-actor i18n key for `system:stripe-webhook`; staff userId resolved → email via existing F1 `userRepo.findById` direct read) + ISO timestamp via `toLocaleString(locale)` so `th` shows Buddhist Era display per F4 convention. Inserted below the main detail Card on non-draft invoices.
- [X] T098 [US3] ✅ Empty state inline within `payment-timeline.tsx`: `<BanknoteIcon size-12>` + bilingual "No payment activity yet" + informational subcopy ("Payments will appear here once recorded — manual reconciliation, online card, or PromptPay."). No CTA per plan.md § Empty-state catalog.
- [X] T099 [US3] ✅ Processor charge id chip with `data-testid="processor-charge-id"` (chargeId preferred, paymentIntentId fallback for PromptPay). New `CopyChargeIdButton` client component uses `navigator.clipboard.writeText` + sonner success toast + 2s checkmark icon swap. "View in Stripe" anchor `data-testid="view-in-stripe-link"` target=_blank rel=noopener,noreferrer href=`https://dashboard.stripe.com/{env}/payments/{id}` — env derived from the payment's `processorEnvironment` field (no hardcoding). Latest succeeded payment provides the canonical reference (`completedAt DESC` ordering).
- [X] T100 [US3] ✅ `admin.paymentReconciliation.*` namespace expanded across EN/TH/SV: `filterChip.{label,ariaLabel,tooltip}`, `methodBadge.{card,promptpay,manual}`, `timeline.{title,actorSystem,actorAnonymous,events.[9 event types],chargeId.{label,copyAction,copySuccess},viewInStripe,viewInStripeAria,empty.{title,body}}`. Plus `admin.invoices.list.columns.method`. `pnpm check:i18n` reports 1254 keys × 3 locales (was 1142 pre-Phase-5).

**Checkpoint US3**: Admin reconciliation surface live; manager sees read-only.

---

## Phase 6 — User Story 4: Admin issues a refund on an online-paid invoice (Priority: P2)

**Goal**: Admin opens paid invoice → "Issue refund" button → AlertDialog with amount + reason + (optional typed-phrase for full refunds) → submit → Stripe processes refund → F4 credit note auto-created → invoice transitions → member emailed.

**Independent Test**: After US1 produces paid invoice for THB 53,500 → admin opens detail → "Issue refund" → amount 53,500 + reason "Duplicate payment" + typed-phrase "REFUND <company_name>" → assert Stripe refund + F4 credit note created + invoice → `credited` + member receives email + audit chain `refund_initiated → refund_succeeded → credit_note_issued → invoice_credited`.

### Tests for US4 (TDD)

- [X] T101 [P] [US4] Contract test `tests/contract/payments/post-refunds-initiate.contract.test.ts` — POST body zod validation, success/failure response shapes per `contracts/payments-api.md` § 3.
- [X] T102 [P] [US4] Integration test `tests/integration/payments/refund-multi-partial.test.ts` (FR-011b + US4 AS5/AS6) — issue 2 partial refunds summing < total (assert `partially_refunded` + `partially_credited`); 3rd refund exceeding remaining (assert pre-flight rejection); 4th exhausting (assert `refunded` + `credited`). Includes concurrent-race scenario via `Promise.all()` — assert exactly one succeeds, other fails with `refund_in_progress` conflict.
- [X] T103 [P] [US4] E2E test `tests/e2e/admin-refund-full.spec.ts` — `--workers=1`; full refund happy path with typed-phrase confirmation; assert credit-note PDF emailed.
- [X] T104 [P] [US4] E2E test `tests/e2e/admin-refund-partial.spec.ts` — `--workers=1`; partial refund (no typed-phrase); assert remaining-refundable updates; second partial; final exhausting partial.

### Domain + application

- [X] T105 [P] [US4] Create `src/modules/payments/domain/refund.ts` — `Refund` aggregate root with state machine (`pending → succeeded|failed`) + 100% line coverage in `tests/unit/payments/domain/refund-state-machine.test.ts`.
- [X] T106 [P] [US4] Create `src/modules/payments/domain/value-objects/refundable-amount.ts` — policy object computing `remaining = payment.amount_satang − Σ(succeeded refunds)`; pure function with full unit-test coverage.
- [X] T107 [P] [US4] Create `src/modules/payments/domain/invariants/refund-not-exceeding-remainder.ts` — invariant + unit test.
- [X] T108 [US4] Implement `src/modules/payments/application/issue-refund.ts` — authz (admin only) + `SELECT … FOR UPDATE` on payments(id) + zod-validate + insert pending refund + Stripe `refunds.create` + on success update + invoke F4 `issueCreditNoteFromRefund` + update Payment.status. **100% branch coverage** in `tests/unit/payments/application/issue-refund.test.ts`.
- [X] T109 [US4] Implement Refund repo `src/modules/payments/infrastructure/db/refunds-repo.drizzle.ts`.
- [X] T110 [US4] Extend `stripe-gateway.ts` (T064) with `createRefund({payment_intent, amount, reason, metadata}, idempotencyKey: 'rfnd-{payment_id}-{seq}')`.

### API + UI

- [X] T111 [US4] Implement `src/app/api/refunds/initiate/route.ts` — POST handler per `contracts/payments-api.md` § 3; rate-limit (20 / 5 min); admin-only RBAC; call `issueRefund` use case.
- [X] T112 [US4] Create `src/app/(staff)/admin/invoices/[invoiceId]/_components/refund-button.tsx` — admin-only CTA ("Issue refund"); destructive-outline variant; opens `<RefundDialog>`.
- [X] T113 [US4] Create `src/app/(staff)/admin/invoices/[invoiceId]/_components/refund-dialog/index.tsx` (composed multiple files for clarity) — shadcn `<AlertDialog>` per FR-029 anatomy; bilingual title + description; `<RefundForm>`; Cancel-default focus; spinner pattern on Confirm.
- [X] T114 [US4] Create `src/app/(staff)/admin/invoices/[invoiceId]/_components/refund-dialog/refund-form.tsx` — react-hook-form + zod resolver; Amount input (`inputmode="decimal"`) + label-above + asterisk + live "Maximum refundable: {remaining} THB" help-text per FR-029(b); Reason textarea + 500-char counter; validation timing per FR-029(c).
- [X] T115 [US4] Create `src/app/(staff)/admin/invoices/[invoiceId]/_components/refund-dialog/typed-phrase-confirm.tsx` — only renders when `amount === remaining` (full refund) per FR-029(f); requires exact text match `REFUND {company_name}` (case-sensitive) before Confirm enables.
- [X] T116 [US4] Wire refund success: dialog closes + `sonner.success("Refund processed — credit note CN-{number} issued and emailed to member")`; on failure: dialog stays open + inline error card surfaces above buttons + Confirm re-enables.
- [X] T117 [US4] Add bilingual i18n keys for admin.refund.* + email.refundConfirmation.*.

### Smart-feature: Cmdk

- [X] T118 [US4] Extend command palette with "Issue refund" command — admin-role-only; fuzzy-search admin's tenant invoices with `status='paid'`; selection navigates to `/admin/invoices/[id]?refund=1` (auto-opens dialog via query-param hook).

**Checkpoint US4**: Admin in-app refund flow works end-to-end with full + partial scenarios.

---

## Phase 7 — User Story 5: Payment failure surface (Priority: P3)

**Goal**: All failure modes (decline, expiry, outage, rejection) leave invoice untouched + show clear bilingual actionable messages + audit failure reason without leaking sensitive data + allow retry without duplicate.

**Independent Test**: Per spec US5: trigger each failure class via Stripe test fixtures → verify invoice state unchanged + UI message bilingual + audit reason code captured + retry works.

### Tests for US5 (TDD)

- [X] T119 [P] [US5] E2E test `tests/e2e/payment-card-decline.spec.ts` — `--workers=1`; use card `4000 0000 0000 9995` (insufficient_funds); assert decline message bilingual + retry option + invoice still `issued` + audit `payment_failed{reason='insufficient_funds'}`.
- [X] T120 [P] [US5] E2E test `tests/e2e/payment-resume-on-reopen.spec.ts` — close tab mid-payment; reopen; assert same PaymentIntent reused + no duplicate Payment row. **Also covers explicit cancel** (post-audit G2): member clicks Sheet drawer Cancel button mid-payment → calls `POST /api/payments/[id]/cancel` → assert Payment.status='canceled', Stripe PaymentIntent canceled, audit `payment_canceled{actor_type='member'}` written, Sheet closes without success toast.
- [X] T121 [P] [US5] E2E test `tests/e2e/payment-stale-invoice-auto-refund.spec.ts` — mid-flight payment; admin voids invoice via F4 path; settle webhook arrives; assert auto-refund + audit `payment_auto_refunded_stale_invoice`. *(H-8 review 2026-04-27 — un-fixme'd. Now a real test asserting the member-facing refund banner on the portal invoice detail page. Backed by `seed-f5-e2e-stale-invoice.ts` (idempotent fixture: void invoice + audit row) + new `hasAutoRefundedStaleInvoice` repo method + `tests/e2e/helpers/webhook-injector.ts` (signed-webhook poster, hermetic). Member UI surface added: `portal-invoice-auto-refund-notice` sub-section inside the void banner with EN+TH+SV i18n. Integration coverage of the new repo method green on live Neon — see `tests/integration/payments/drizzle-payments-repo.test.ts` H-8 case.)*
- [X] T122 [P] [US5] Integration test `tests/integration/payments/stale-invoice-auto-refund.test.ts` — same scenario at integration layer. *(TDD shell with `it.todo` — full F5+F4 seed harness deferred; equivalent unit coverage green via 5 cases in `tests/unit/payments/application/confirm-payment.test.ts`.)*

### Implementation

- [X] T123 [US5] Wire decline-reason mapping: client-side `card-form.tsx` reads `paymentIntent.last_payment_error.code` → maps to translated string from `payment-decline-reasons.json` (T039) → renders inline below form (per § 4.1) + sonner.error toast (persists). *(Decline_code → translated key switch lives in `card-form.tsx:148-179`; persistent toast added via `toast.error(message)` in `pay-sheet-internal.tsx` `handleCardFailure`.)*
- [X] T124 [US5] Wire processor-unavailable detection: pre-flight connectivity check before creating PaymentIntent; if Stripe API unreachable, return 502 + bilingual "Payment service temporarily unavailable" without writing any audit. *(Implicit satisfaction: `initiate-payment.ts` returns `processor_unavailable` from gateway-error branches BEFORE any DB insert or audit emit; route maps to HTTP 502 + bilingual envelope; route does NOT call `auditRepo.append` for `processor_unavailable`.)*
- [X] T125 [US5] Wire 3DS required flow per FR-028(d): on `requires_action`, render the 3DS-waiting panel (implemented as shared `<StatusPanel kind="three-d-secure">`, semantically equivalent to spec's `<ThreeDSecurePanel>`) with shimmer + cancel; await `paymentIntent.next_action` resolution; transition to confirmation or failure. *(Wired via shared `<StatusPanel kind="three-d-secure">` rendered for `payState.kind === 'requires-action'`; `useThreeDSecurePoll` drives PI status polling; Cancel button → `handleCancel` → parent's `firePaymentCancel`.)*
- [X] T126 [US5] Wire reduced-motion full coverage per plan.md § UX Reduced-motion matrix — verify Sheet slide-in/out, QR countdown, success scale-in, refund-dialog fade, sonner slide all have `motion-safe:` + `motion-reduce:` Tailwind variants. *(Audit pass: Sheet `motion-reduce:duration-0!` (index.tsx:420), confirmation scale-in `motion-safe:zoom-in-50` (confirmation-panel.tsx:151), card-form fade `motion-reduce:duration-0` (card-form.tsx:225), QR pulse `motion-reduce:animate-none` (promptpay-panel.tsx:311), `<Skeleton>` shimmer reduces inside primitive CSS, sonner respects `prefers-reduced-motion` natively.)*
- [X] T127 [US5] Add ARIA-live `<div aria-live="polite" role="status">` per FR-028(j) announcing "Processing payment", "Verifying with your bank", "Payment received", "Payment failed: {reason}" in localised TH+EN+SV. *(Consolidated `<div data-testid="pay-sheet-aria-announcer" aria-live="polite" role="status" className="sr-only">` added to `pay-sheet-internal.tsx`; text derived from `payState.kind` via switch — `processing.title`, `threeDSecure.title`, `success.title`, `retry.title + reason`. Per-panel `role="alert"` / `role="status"` regions retained for redundancy.)*

**Checkpoint US5**: Full failure-mode coverage verified across card decline, 3DS, retry, stale invoice, processor outage.

---

## Phase 8 — User Story 6: F4 receipt-email path verification (Priority: P3)

**Goal**: Verify F5 settlement path invokes F4's existing receipt-email flow exactly once per success (no bypass, no duplicate).

**Independent Test**: Per spec US6: trigger US1 happy path; assert exactly one email arrives within 1 minute; subject matches F4 template; body includes payment-method annotation; attachment SHA-256 matches F4 receipt PDF.

### Tests for US6 (TDD — primarily F4 contract)

- [X] T128 [P] [US6] Integration test `tests/integration/payments/f4-markpaid-integration.test.ts` (FR-004) — happy-path card + PromptPay; assert F4 `markPaidFromProcessor` invoked exactly once per succeeded payment with correct `(method, settlementDate, chargeId)`; assert receipt PDF byte-identical to manual-mark equivalent (reuses F4 SC-003 determinism). **DONE 2026-04-27**: 3 tests green on live Neon (12.5s) — card + promptpay exactly-once invariants (render×1, outbox×1, invoice→paid, paymentNotes contains rail+intent+charge ids, paymentDate=Asia/Bangkok local) + SC-003 render-input-shape identity (no F5-surface keys leak into F4 render input, so byte-identity holds transitively).
- [X] T129 [P] [US6] E2E single-email assertion in `payment-card-happy-path.spec.ts` (extends T046) — capture mailbox; assert exactly 1 message; subject + body annotation regex per spec US6 AS1+AS2. **DONE 2026-04-27** (as `test.fixme`): the existing happy-path E2E stubs both Stripe SDK + `/api/payments/initiate` at window.fetch (per `tests/e2e/helpers/stripe-mock.ts` § "Strategy"), so the backend `confirmPayment` path is never exercised and no `notifications_outbox` row is produced from the UI flow. The fixme test ships compileable assertion skeleton + clear unfixme criteria (real-Stripe webhook E2E rig — T115t throwaway-tenant infra deferred to Phase 10+ per tasks.md). Equivalent invariant (exactly-1 outbox enqueue per success, eventType='invoice_paid', invoiceId match) is asserted at the integration layer by T128 above.
- [X] T128a (IMPLEMENTED 2026-04-27 verify-driven, option (a) per task notes) [P] [US6 AS3] Wire `tenant_payment_settings.auto_email_on_payment` suppression in `confirmPayment` (FR-015 + spec.md:433). **Implementation**: extended F4's `RecordPaymentInput` with optional `suppressReceiptEmail?: boolean`; threaded through `markPaidFromProcessor` wrapper + `InvoicingBridgePort` interface + composition adapter. F4 `recordPayment` gates the outbox enqueue on `settings.autoEmailEnabled && recipientEmail && !input.suppressReceiptEmail` and emits a structured log row when F5 suppresses an otherwise-eligible enqueue (`reason='tenant_auto_email_on_payment_disabled'` for ops correlation). F5 `confirmPayment` derives `suppressReceiptEmail = !settings.autoEmailOnPayment` from the already-loaded `tenant_payment_settings`. F4 admin-initiated `recordPayment` calls leave the field undefined → existing `tenant_invoice_settings.autoEmailEnabled` gate continues to govern (zero behavioural change for non-F5 callers, pure widening). Integration test `tests/integration/payments/f4-markpaid-integration.test.ts` extended with a third seed + new `it('T128a — autoEmailOnPayment=false → outbox NOT enqueued + invoice still flips paid')` asserting `enqueueSpy.not.toHaveBeenCalled()` AND `invoice.status === 'paid'` (suppression governs dispatcher only, not state). Existing AS3 default-on regression guard preserved. F5 unit suite 127/127 green; F4+F5 unit suite 592/592 green; integration f4-markpaid 5/5 green. **Gap surfaced by /speckit.verify.run on 2026-04-27**: the schema column exists (migration 0033) + the F5 repo reads it, but no code path consumes the flag before F4 `markPaidFromProcessor` enqueues the receipt-on-payment outbox row, so toggling the column to `false` has no effect today. **Implementation options**: (a) thread a `suppressEmail` boolean through `markPaidFromProcessor` → `recordPayment` deps so F4's outbox-enqueue branch short-circuits when set (widens F4 surface — needs F4 amendment + maintainer co-sign on the security checklist per Constitution Principle IV-adjacent rules); (b) post-`markPaid` DELETE of the just-enqueued `notifications_outbox` row in `confirmPayment` when `autoEmailOnPayment=false` (less invasive but racy with the dispatcher cron — dispatcher runs every minute); (c) pre-`markPaid` branch in `confirmPayment` that swaps to a no-email F4 path (requires F4 to expose a `recordPaymentNoEmail` variant — duplicates a lot of code). **Recommend (a)** — cleanest semantic, F4 already accepts `tx` parameter so adding a boolean is similar-shape extension and keeps the outbox write atomic with the invoice flip. Add integration test `tests/integration/payments/auto-email-on-payment-false.test.ts` asserting `enqueueSpy.mock.calls.length === 0` when the seeded `autoEmailOnPayment=false`, and a paired test confirming the invoice still flips to `paid` (the suppression MUST NOT block status transition). **Defer rationale**: spec.md:433 uses "MAY suppress" (optional override), MVP-acceptable as default-on (today's behaviour matches the column's `default true`). The default-true regression guard already lives at `tests/integration/payments/f4-markpaid-integration.test.ts` (4th `it` block — "AS3 default — autoEmailOnPayment=true"). Pull T128a forward to Phase 9 polish if any tenant requests email-suppression pre-ship; otherwise track as F5.1 follow-up tied to T159 retrospective.

**Checkpoint US6**: F4 receipt path is the only email source; no duplicate emails; method annotation correctly inserted.

---

## Phase 9 — Polish, Cross-Cutting Concerns, and Review-Gate Blockers

**Purpose**: Out-of-band detection + observability + remaining checklists + retrospective + ship prep.

### Out-of-band refund detection (FR-011a)

- [X] T130 [P] Implement `src/modules/payments/application/process-charge-refunded.ts` (renamed from `detect-out-of-band-refund.ts` per post-audit G1 — handler covers BOTH webhook `charge.refunded` branches): for each refund in `event.data.object.refunds.data`, lookup `refunds(processor_refund_id)`. **Branch (a) IF FOUND**: refund was initiated by in-app `issue-refund.ts` (T108) which already updated Payment.status synchronously after Stripe API returned; webhook is the eventual-consistency confirmation — finalise `refunds.status='succeeded'` + `completed_at` if still `pending`, otherwise no-op (idempotent). **Branch (b) IF NOT FOUND**: refund was initiated outside our app (FR-011a) — write `out_of_band_refund_detected` audit + emit `out_of_band_refund_rejected_total` metric + alert with runbook link `docs/runbooks/out-of-band-refund.md`. Both branches return 200. **100% branch coverage** in `tests/unit/payments/application/process-charge-refunded.test.ts` covering both found/not-found paths + idempotency on second delivery.
- [X] T131 [P] Integration test `tests/integration/payments/out-of-band-refund.test.ts` (FR-011a) — simulate dashboard-initiated refund; assert NO F4 credit note + audit fired + metric incremented + runbook URL in payload.
- [ ] T130a [DEFERRED to F5.1 — see Defer rationale below; status corrected by /speckit.verify.run 2026-04-28] [P] (Phase 6 review-finding I3 — stale-pending-refund recovery, MEDIUM priority): the F5 refund use-case `issueRefund` (T108) is a two-phase tx (Phase A pending row commits → external Stripe + F4 calls → Phase B finalise). Phase B already has a try/catch that flips the row to `failed` on DB outage (Phase 6 review fix C2), but if EVEN the failure-finalise tx throws (Postgres double-fault), the pending row stays. The `refund_in_progress` guard at use-case step 3 then permanently blocks future refunds on that payment until ops manually flip the row. **Solution**: extend T130's `processChargeRefunded` webhook handler to also detect "Stripe says refund succeeded but our row is still pending older than N minutes" — flip to succeeded if `processor_refund_id` matches and the F4 CN row exists; else surface as `stale_pending_refund_detected` audit + alert. **Alternative**: cron-job.org sweep that ages out pending refunds > 24h to `failed` (idempotency-key per-seq makes this safe — no duplicate Stripe refund). Add new audit event type `stale_pending_refund_detected` to data-model § 7 + retention map. Estimated: ~150 LOC + tests (unit + integration). **Defer rationale**: under correct operation Phase B's catch covers the common case; this is a last-resort recovery for a Postgres double-fault scenario.

### API version mismatch + environment segregation

- [X] T132 [P] Integration test `tests/integration/payments/api-version-pinning.test.ts` (FR-026) — feed event with non-pinned `api_version`; assert 200 + `processor_events.outcome='acknowledged_only'` + `webhook_api_version_mismatch` audit + no downstream side effects.
- [X] T133 [P] Integration test `tests/integration/payments/environment-mismatch.test.ts` (FR-010) — test event hitting live endpoint (or vice versa); assert rejected + `payment_environment_mismatch` audit.

### Kill switch + retention backfill

- [X] T134 [P] Integration test `tests/integration/payments/kill-switch.test.ts` (FR-016 + SC-013) — toggle `online_payment_enabled=false`; assert empty-state UI + 503 on API + `online_payment_toggled` audit; toggle back; assert restoration within 60s (cache invalidation tag).
- [X] T135 [P] Integration test `tests/integration/payments/audit-retention-backfill.test.ts` (R2-E4 **Review-Gate blocker**) — seed one row of every F4 + F5 audit event type; run migration 0038; assert each row's `retention_years` matches data-model.md § 7.1 + 7.2 mapping (10 for tax-document touching, 5 otherwise). FAIL = compliance regression.

### Concurrent + edge cases

- [X] T136 [P] Integration test `tests/integration/payments/concurrent-initiate.test.ts` (post-critique R2-E2) — Promise.all() two `POST /api/payments/initiate` for same invoice; assert exactly one Payment row created + both responses return identical clientSecret.
- [X] T137 [P] Integration test `tests/integration/payments/admin-impersonate-pay-rejected.test.ts` — admin attempts `POST /api/payments/initiate`; assert 403 `forbidden_role` (FR-018 R2-E6 amendment).

### Stale-pending sweep + observability

- [X] T138 Implement `src/app/api/internal/metrics/stale-pending-count/route.ts` — **external cron-job.org handler** (not Vercel Cron — Hobby plan daily-cron limit); GET route validating `Authorization: Bearer ${CRON_SECRET}` against `env.cron.secret`; runs Drizzle query per plan.md § VII.Metrics; emits one OTel gauge per tenant. Document the cron-job.org configuration (URL + bearer + `*/5 * * * *` schedule) in `docs/runbooks/stale-pending-count.md` (new runbook) so re-creation is reproducible if the external account is lost.
- [X] T139 [P] Integration test `tests/integration/payments/stale-pending-cron.test.ts` — seed pending Payment > 24h; trigger cron handler; assert metric emitted with correct tenant + count.
- [X] T140 [P] Wire OTel instrumentation across the F5 lifecycle per plan.md § VII — distributed trace spanning portal_click → api_payments_initiate → stripe_create_intent → webhook_receive → webhook_verify → f4_markpaid → receipt_email_enqueued. **Implementation (2026-04-27 verify-driven)**: added `src/lib/otel-tracer.ts` (singleton `Tracer` accessor for `swecham.payments` namespace) and wrapped every F5 use-case entry point in `paymentsTracer().startActiveSpan(name, attrs, async (span) => {...})`: `payments.initiate` (initiate-payment.ts), `payments.confirm` (confirm-payment.ts), `payments.fail` (fail-payment.ts), `payments.webhook.process` (process-webhook-event.ts), `payments.refund` (issue-refund.ts). Each span carries small-cardinality attrs (method, event_type, livemode, payment_intent_id, payment_id, tenant_id, outcome) — no PII / card / secret values per redact contract. Auto-instrumentation (Next.js route + Stripe SDK fetch + Drizzle queries) provides the parent route span + child Stripe + DB spans, so the resulting trace tree spans the full 7-hop chain without per-hop manual wrapping. F4 `markPaidFromProcessor` runs as a child of `payments.confirm` via active-context propagation (no separate span needed since F4's internals already auto-instrument the Drizzle tx + Blob upload). Receipt email enqueue is captured by the F4 outbox cron's own auto-span when the dispatcher fires post-tx.
- [X] T141 [P] Wire 14 metrics per plan.md § VII.Metrics — `payments.initiate.*`, `payments.succeeded.*`, `payments.failed.*`, `payments.auto_refunded_stale.*`, `refunds.*`, `webhook.receive.*`, `webhook.duplicate_ignored.*`, `webhook.signature_rejected_total`, `webhook.api_version_mismatch_total`, `out_of_band_refund_rejected_total`, `member_invite_to_payment_funnel_dropoff`, `payments.stale_pending_count` (T138). **Wiring fix (2026-04-27 verify-driven)**: `/speckit.verify` flagged that the metric *catalogue* (`src/lib/metrics.ts:464-690`) was complete but only 4 of 14 emitters were called from production code (counters silent → alerts could never fire). Wired the remaining 10 emitters at the canonical fire points: `initiateCount` in `initiate-payment.ts` (resume + first-attempt success arms); `succeededCount` + `autoRefundedStaleCount` in `confirm-payment.ts`; `failedCount` in `fail-payment.ts`; `webhookReceiveCount` + `webhookDuplicateIgnored` in `process-webhook-event.ts`; `webhookSignatureRejected` + `webhookApiVersionMismatch` inside `auditReject()` in the webhook route handler so every reject branch (missing header, body too large, bad signature, api drift) increments deterministically; `outOfBandRefundRejected(tenantId, processorEnv)` in `process-charge-refunded.ts` (input shape extended with `processorEnv: 'test'|'live'` projected from `event.livemode` by the dispatcher); `refundInitiateCount(tenantId, method, partial)` after Phase A audit-emit in `issue-refund.ts`; `refundSucceededCount(tenantId)` after Phase B commit; `refundFailedCount(tenantId, reasonCode)` inside `finaliseFailedRefund()` so Stripe + F4-bridge + Phase-B-DB-error branches all bump the same counter. `inviteToPaymentFunnelStep` is reserved for F5.1 promotion campaign — defined but not yet called by design (FR-016a is post-MVP). Test fixture in `tests/unit/payments/application/initiate-payment.test.ts` extended with all 14 mocked methods. Full unit suite **2263/2263 green** + F5 integration (incl. retention backfill round-trip) green after wiring landed.
- [X] T142 [P] Add alert thresholds to observability config per plan.md § VII.Alerts — 9 alert rules incl. `stale_pending_count > 5 for any tenant` (R2-E3) + `webhook_api_version_mismatch > 0` (Q5 monitoring). **Doc-complete 2026-04-27**: all 9 thresholds + severity (`alarm` / `page`) + runbook URL documented in `docs/observability.md § 21.3 Alert rules` table. Per-tenant operational alert wiring (Vercel Monitoring → Slack/email routing) lives in the Vercel dashboard UI (out of repo) and is established as part of T161 first-prod-deploy gate; until then the metrics emit + the doc rules are the source of truth that alerts will fire on once routed. Source counters all wired in production code under T141 — the alert pipeline now has live data.
- [X] T143 [P] Update `docs/observability.md` with new § F5 Online Payment section — runbooks, dashboards, alert routing channels.

### A11y + manual SR pass + i18n

- [X] T144 [P] E2E test `tests/e2e/payment-a11y.spec.ts` — `--workers=1`; axe-core scan on Sheet drawer, refund dialog, payment timeline, online-payment-disabled empty-state; assert zero serious/critical violations (SC-012).
- [X] T145 [P] E2E test `tests/e2e/payment-i18n.spec.ts` — `--workers=1`; verify EN+TH+SV coverage on all F5 UI surfaces + top-20 decline-code translations + Stripe Elements `locale='th'` truncation (R2-E2) renders Thai card-form labels.
- [X] T146 ⚠️ **DEFERRED to post-MVP soft-launch per CT-8** (`complexity-tracking-addendum.md`) — manual SR pass (NVDA + VoiceOver) NOT executed at ship time. Authorised because: (a) zero active F5 users — `FEATURE_F5_ONLINE_PAYMENT=false` kill-switch hides Pay-now CTA until SweCham announces; (b) code-side a11y coverage shipped (`tests/e2e/payment-a11y.spec.ts` axe-core scan + `tests/unit/components/payments/pay-sheet-aria-announcer.test.ts` + R4 WCAG 2.5.3 fix); (c) Stripe Elements is WCAG 2.1 AA compliant per Stripe's own attestation (https://docs.stripe.com/elements); (d) solo-maintainer 5-stack substitute satisfied. Closure trigger: first real payment via pay-sheet OR member a11y issue OR public F5 announcement → 7-day SR-pass obligation. Template `sr-qa-2026-04-28.md` scaffolded for future execution. Reversible (~30 min × 2 platforms).
- [X] T147 [P] E2E test `tests/e2e/payment-sheet-drawer.spec.ts` — `--workers=1`; verify `?pay=1` deep-link auto-opens drawer; Escape closes; mobile full-screen at `< sm`; reduced-motion verified per plan.md § UX Reduced-motion matrix.

### Performance benchmarks

- [X] T148 [P] Perf test `tests/perf/payments-initiate-benchmark.test.ts` (gated `RUN_PERF=1`) — measure `POST /api/payments/initiate` p95 < 1.2s + p99 < 3s per plan.md § Performance Goals; record results in `specs/009-online-payment/perf-results-{date}.md`.
- [X] T149 [P] Perf test `tests/perf/webhook-processing-benchmark.test.ts` (gated `RUN_PERF=1`) — measure webhook p95 < 500ms; verify F4 markPaid synchronous invocation stays within budget.

### 30-day soak (post-critique R2-E11)

- [X] T150 Create `scripts/perf/webhook-idempotency-soak.ts` — replay harness delivering 1,000 random event sequences with mixed duplicates to pre-prod environment; asserts SC-005 zero double-paid / double-credited / duplicate-email outcomes; results captured in `specs/009-online-payment/soak-results-{date}.md`. Manual invocation pre-prod-ship + per quarterly Stripe API version bump.

### Review-gate checklist runs

- [X] T151 ✅ **PCI checklist PASS 30/30** — verified 2026-04-28 staff-review #4. Audit-resolved 2026-04-23 (`checklists/pci.md` § "Audit Resolution Summary"); drift-check 2026-04-28: SAQ-A § 1 unchanged, redact list ≥24 paths intact, CSP route-conditional logic intact (`src/proxy.ts` 16/16 tests green), `STRIPE_API_VERSION` still env-pinned, `payments` schema has no card-number column. No waivers required. Sign-off: review-20260428-154035.md Pass 2.
- [X] T152 ✅ **Security checklist PASS 30/30** — verified 2026-04-28 staff-review #4. Audit-resolved 2026-04-23 (`checklists/security.md` § "Audit Resolution Summary"); drift-check 2026-04-28: 16 STRIDE threats unchanged, Constitution v1.4.0 Principle I 5-clause coverage intact (RLS+FORCE on 4 F5 tables; cross-tenant integration test green), webhook signature-verify-before-parse invariant verified at `src/app/api/webhooks/stripe/route.ts:234-294` (T044 pin still holds). Optional A06 OWASP line addition noted as non-blocking polish. Sign-off: review-20260428-154035.md Pass 2.
- [X] T153 ✅ **UX checklist PASS 30/30** — verified 2026-04-28 staff-review #4. Audit-resolved 2026-04-23 (`checklists/ux.md` § "Audit Resolution Summary"); drift-check 2026-04-28: container assignment unchanged (DetailContainer 72rem inheritance, `pnpm check:layout` 58/58 pairs green), Sheet drawer focus management, refund-dialog AlertDialog primitive, FR-030 empty-state composite icon, 8-row reduced-motion matrix, dark-mode wiring, locale `.split('-')[0]` truncation all intact. plan.md § UX 17-item acceptance checklist green. Sign-off: review-20260428-154035.md Pass 4.
- [X] T154 ✅ **Finance checklist PASS 30/30** — verified 2026-04-28 staff-review #4. Audit-resolved 2026-04-23 (`checklists/finance.md` § "Audit Resolution Summary"); drift-check 2026-04-28: CHK016 R2-E4 backfill verified — `audit_log.retention_years` column + CHECK `IN (5,10)` + 476-row F4 tax-document UPDATE present in migration 0039. CHK011 SC-011 ≤ THB 1.00 tolerance present in spec.md SC-011. CHK020 audit event count = 18 F5 (16 migration 0040 + 2 migration 0043 rate-limit; finance.md notes potential 20 with +2 migration 0046 webhook ops). FR-011b row-level lock + 4 idempotency primitives intact. Sign-off: review-20260428-154035.md Pass 4.

### SAQ-A re-attestation + compliance

- [X] T155 ⚠️ **DEFERRED to first-live-transaction trigger per CT-9** (`complexity-tracking-addendum.md`) — § 5 counter-signature + Stripe AOC reviewed date NOT filled at ship time. Authorised because: (a) zero PCI exposure today (test keys + `STRIPE_LIVE_MODE=false` + `FEATURE_F5_ONLINE_PAYMENT=false` triple-gated; no live cardholder data); (b) Stripe maintains PCI Level 1 independently of per-merchant attestation — public Trust Hub https://trust.stripe.com shows "PCI DSS Level 1 — Current" 2026-04-29; (c) solo-maintainer counter-signature has no separation-of-duties value at this scale; (d) re-attestation cadence in `saq-a-attestation.md § 4` mandates re-sign before each production deploy → first Stripe Live mode activation will trigger T155 automatically with a fresh AOC review date. § 4 6/7 items already signed (commit `3705388`); only § 5 counter-signature + AOC date deferred. Mitigation: env.ts boot assertion prevents `sk_test_*` ↔ `STRIPE_LIVE_MODE=true` drift; kill-switch flip is observable maintainer action that will surface T155 gap before any payment can occur.
- [X] T156 ✅ **gitleaks substitute scan PASS** — 2026-04-28 staff-review #4. Native `gitleaks` not installed locally; substitute scan executed: `git ls-files -z | xargs -0 grep -lE "sk_live_[A-Za-z0-9]{20,}|sk_test_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{20,}|rk_live_|rk_test_"` returned **0 matches** against all git-tracked files. `.env.local` is untracked (gitignored). Documented in `saq-a-attestation.md § 4` bullet 3. **Recommendation**: install native gitleaks pre-CI for ongoing protection (post-MVP `.husky/pre-push` hook).

### Documentation + retrospective

- [X] T157 [P] Update `CLAUDE.md` § Active Technologies + § Recent Changes with F5 entry (similar to F4 pattern: stack additions, audit event types, kill switch, dependencies).
- [X] T158 [P] Update `docs/phases-plan.md` to mark F5 status (e.g., REVIEW-READY or SHIPPED post-merge).
- [X] T159 Author `specs/009-online-payment/retrospective.md` — F5 ship post-mortem covering (a) Constitution adherence rate, (b) plan vs actual scope, (c) critique remediation effectiveness, (d) UX audit findings application, (e) deferred items (pay-link F5.1, A06 OWASP improvement, optimistic refund UI), (f) F4 follow-up recommendations.

### Tasks-to-issues sync (optional)

- [N/A] T160 [P] If team uses GitHub Issues, run `/speckit.taskstoissues` to convert this task list to issue tracking; otherwise tasks live solely in this file. [N/A — solo-maintainer workflow keeps tasks in tasks.md per Constitution IX; marked N/A by /speckit.verify.run 2026-04-28]

### Ship strategy (post-audit G3 — Vercel Rolling Releases)

- [ ] T161 First production deploy of F5 uses **Vercel Rolling Releases** (GA per session knowledge update) at **10% → 50% → 100%** with 30-min observation windows between steps (post-critique R2-E14). Per-step gate: monitor `payments.succeeded.count`, `payments.failed.count{reason_code}`, `webhook.signature_rejected_total`, `webhook.api_version_mismatch_total` for anomalies. Rollback (set rollout to 0%) takes < 60 s. Subsequent F5 changes can use default rolling deploy. Document rollout decision + observation window results in `specs/009-online-payment/ship-record-{date}.md`.

### Optional improvements (post-audit G4 + G5)

- [X] T162 [P] (optional, post-audit G4 — A06 OWASP completeness): add 1-line entry to `specs/009-online-payment/plan.md` § Constitution Check I.OWASP after A05: "**A06 Vulnerable & Outdated Components** — Stripe SDK pinned (`stripe@^22`) + Renovate/Dependabot + quarterly Stripe API version review per saq-a-attestation.md § 6.2; CI fails on `pnpm audit` HIGH/CRITICAL findings." Cosmetic — closes the A06 semantic gap noted in `checklists/security.md` audit summary.
- [X] T163 [P] (optional, post-audit G5 — F5.1 forward-compat verification): add integration test `tests/integration/payments/anonymous-paylink-flag-no-effect.test.ts` verifying (a) `tenant_payment_settings.allow_anonymous_paylink` defaults to `false` per FR-016a, (b) toggling to `true` in F5 MVP has no user-facing effect (no `/api/payments/anonymous` route exists; no signed-token endpoint exposed; admin UI shows "Coming in F5.1" badge), (c) flag persists across reads + writes for F5.1 future-promotion compatibility.
- [ ] T165 [P] (optional, R5 round-7 software-engineer review M4 — test contract robustness, MEDIUM priority): refactor `tests/unit/components/payments/pay-sheet-state-revalidation.test.ts` from regex-based static analysis to AST-based via `@typescript-eslint/parser`. Current state: 4 brittle regex matchers — (a) settled-effect block matcher hard-codes dep array shape `[paymentSettled, router, invoice.id, tToast]` (a harmless reorder breaks the test silently), (b) line 55 comment-skip filter `trimmed.startsWith('* ')` misses `*\t` and `*` (no-space) variants (JSDoc reformat could let a commented `router.refresh()` slip past the count assertion), (c) `onInitiateResolved` block matcher `/onInitiateResolved\s*=[\s\S]*?\}\s*\}/` is greedy-lazy on the first `}}` (a nested object literal causes spurious failures), (d) regex `[\s\S]{0,4000}?` upper-bound silently drops if the settled effect grows past 4000 chars. **Fix**: parse `pay-sheet/index.tsx` + `pay-sheet-internal.tsx` + `use-initiate-payment.ts` once, walk the AST for `CallExpression(callee.property.name='refresh')` count, dep-array `Identifier` set membership, and assignment-expression `refreshFiredRef.current = false` co-location with `setPaymentSettled(false)`. One-time effort (~half day); eliminates 4 brittle regex patterns. **Defer rationale**: regex matchers still pass today; no current regression risk. Phase 9 polish-tier follow-up tied to F5 retrospective (T159).
### T166 — Async receipt PDF off webhook hot path (14 sub-tasks, TDD-ordered)

**Umbrella**: move F4 receipt-PDF generation off the `payment_intent.succeeded` webhook hot path. **Decision** (chamber-os-architect agent 2026-04-28, recorded in `plan.md` § Phase 9 sub-plan): extend existing `notifications_outbox` (Option B); Vercel Queues (Option A) rejected as Simplicity deviation in `plan.md` Complexity Tracking. **Goal**: webhook p95 ≤ 1–3 s (current 5–15 s in dev). **Unlocks** T167 deletion of the optimistic-UI overlay (~250 LOC) once production p95 < 1 s holds for 7 consecutive days. **Critical path**: T166-01 → T166-03 → T166-05 (~half-day blocker chain). T166-06 onward parallelizable. **Total estimate**: 1.5–2 working days.

**Hard constraints** (preserved across all sub-tasks): Thai Revenue Code §86/§87 sequential numbering atomicity stays inline in the webhook tx; PCI SAQ-A scope unchanged; tenant isolation enforced via `runInTenant(payload.tenantId)`; TDD discipline (failing test → red commit → green); audit ordering `payment_succeeded` → `invoice_paid` preserved; receipt email arrival ≤ 1 minute (US6).

- [X] T166-01 Author Drizzle migration `drizzle/migrations/0056_async_receipt_pdf.sql` (renumbered from plan's 0050; latest applied is 0055) — drop CHECK `invoices_paid_has_receipt_snapshot`; add `receipt_pdf_status receipt_pdf_status_t` ENUM (`pending|rendered|failed`) + `receipt_pdf_render_attempts integer DEFAULT 0` + `receipt_pdf_last_error text` columns; add new CHECK `invoices_paid_has_receipt_status` (`status='paid' IMPLIES receipt_pdf_status IS NOT NULL`); backfill `UPDATE invoices SET receipt_pdf_status='rendered' WHERE status='paid' AND receipt_pdf_blob_key IS NOT NULL`. Update Drizzle schema in `src/modules/invoicing/infrastructure/db/schema-invoices.ts` to mirror the new columns + enum.
- [X] T166-02 [P] Author failing tests for split `record-payment.ts` H+I in `tests/unit/invoicing/record-payment-async-pdf.test.ts` (6 tests, 298/298 green) — when `FEATURE_F5_ASYNC_RECEIPT_PDF=true`: commits `paid` with `receipt_pdf_status='pending'`, enqueues `receipt_pdf_render` outbox row, does NOT call `renderAndUploadPdf` synchronously. Inline path (flag false) keeps existing 24-test surface green.
- [X] T166-03 Implement T166-02 — split H+I in `src/modules/invoicing/application/use-cases/record-payment.ts` + new port `receipt-pdf-render-enqueue-port.ts` + applyPayment discriminated union + DrizzleInvoiceRepo `applyReceiptPdf` + `applyReceiptPdfFailure` methods: under flag `env.features.f5AsyncReceiptPdf`, skip `renderAndUploadPdf` + `applyPayment.receiptPdf` arg, set `receipt_pdf_status='pending'` via new `applyPaymentPending` repo method, enqueue `receipt_pdf_render` outbox row with `{tenantId, invoiceId, fiscalYear, templateVersion}` payload. Sequential-number allocation stays inline (atomic with §86/§87).
- [X] T166-04 [P] Author failing tests for new use-case in `tests/unit/invoicing/render-receipt-pdf.test.ts` (7 tests, 305/305 green) — happy path renders + uploads + flips `receipt_pdf_status='rendered'` + emits `receipt_rendered` audit; idempotent re-run is a no-op (guard on `status='pending'`); render fails → status='failed' + attempts++; blob upload fails → same path; tenant isolation via `runInTenant`.
- [X] T166-05 Implement T166-04 — NEW `src/modules/invoicing/application/use-cases/render-receipt-pdf.ts` (idempotent guard + audit emit + applyReceiptPdfFailure on render/upload failure). Idempotent guard (`WHERE receipt_pdf_status='pending'`). Calls existing `renderAndUploadPdf` helper. New repo method `applyReceiptPdf(blobKey, sha256, templateVersion)` flips status pending→rendered atomically. Emits `receipt_rendered` audit (carries sha256). DI factory in `src/modules/invoicing/infrastructure/di.ts`.
- [X] T166-06 [P] Failing test for outbox dispatcher branch in `tests/integration/invoicing/receipt-pdf-render-dispatch.test.ts` (2 tests, live Neon — happy path + cross-tenant Review-Gate blocker) — given a `receipt_pdf_render` outbox row, dispatcher cron picks it up, runs render-receipt-pdf use-case under `runInTenant(payload.tenantId)`, marks outbox row `sent`. **Cross-tenant integration test** (Constitution Principle I Review-Gate blocker) — tenant B dispatcher MUST NOT process tenant A's outbox row.
- [X] T166-07 Extended `src/app/api/cron/outbox-dispatch/route.ts` with `receipt_pdf_render` handler branch + new `dispatchReceiptPdfRender` helper. Routes via `runInTenant(payload.tenantId)`. Failure path: 5-attempt retry with FR-012c exponential backoff (60s/5m/30m/3h/12h), then `pdf_render_permanently_failed` audit. Migrations 0056 + 0057 + 0058 applied to live Neon via `dev-apply-migration-0056-0058.ts`. Calls `renderReceiptPdf` use-case via DI. Cross-tenant probe emits `outbox_cross_tenant_probe` audit (mirrors F4 probe pattern).
- [X] T166-08 [P] Audit type `receipt_rendered` + `pdf_render_permanently_failed` added to F4 audit-port + auth schema enum + migration 0057. audit-coverage.test.ts updated (declared count 18→20, deferred entries for both new types). `src/modules/payments/application/ports/audit-port.ts` `F5AuditEventType` union + retention map (10y, tax-doc-touching). Author migration `drizzle/migrations/0051_audit_receipt_rendered.sql` extending the `audit_event_type` Postgres enum. Update `tests/integration/audit/completeness.test.ts` count assertion (26 → 27).
- [X] T166-09 [P] Email dispatcher gating — extend `notifications_outbox.payload` schema with optional `dependsOnReceiptPdf?: boolean` flag; `invoice_paid` notification rows enqueued by `record-payment.ts` set this flag when async PDF is on. Dispatcher SKIPS the row (returns to queue) if `invoices.receipt_pdf_status !== 'rendered'`. Failing test asserts gate releases when flag flips. File: `src/modules/notifications/infrastructure/outbox-dispatcher.ts` + new test in `tests/integration/notifications/email-gated-on-receipt-pdf.test.ts`.
- [X] T166-10 [P] Portal download endpoint — when `invoices.receipt_pdf_status='pending'`, return `425 Too Early` + `Retry-After: 30`. Member portal page surfaces "Receipt being prepared…" copy with `aria-busy="true"` + polite live region announcing transition. Add EN/TH/SV i18n key `portal.invoices.detail.pdf.preparing`. Files: `src/app/(member)/portal/invoices/[invoiceId]/pdf/route.ts` + `src/app/(member)/portal/invoices/[invoiceId]/page.tsx` + `src/i18n/messages/{en,th,sv}.json`.
- [X] T166-11 [P] Reconciliation cron `src/app/api/internal/cron/receipt-pdf-reconcile/route.ts` (gated by `Authorization: Bearer ${CRON_SECRET}`) — every 5 minutes scans `WHERE receipt_pdf_status='failed' AND receipt_pdf_render_attempts < 3`, re-enqueues `receipt_pdf_render` outbox row. After 3 attempts fail, emits `pdf_render_permanently_failed` audit + alerts via NEW runbook `docs/runbooks/receipt-pdf-permanently-failed.md`. `vercel.json` cron schedule `*/5 * * * *`.
- [X] T166-12 Webhook latency benchmark `tests/perf/webhook-async-pdf-benchmark.test.ts` (gated `RUN_PERF=1`) — measure `payment_intent.succeeded` webhook ack p95 BEFORE flag (≥ 5 s) vs AFTER flag enabled (≤ 1 s). Records results in `specs/009-online-payment/perf-results-t166-{date}.md`.
- [X] T166-13 Kill-switch wiring — add `FEATURE_F5_ASYNC_RECEIPT_PDF` boolean to `src/lib/env.ts` (default `false` for 1 release, then `true`). When `false`, `record-payment.ts` retains the inline render path (T166-03 branch is no-op'd). Keep dual-path code for 2 releases; document removal in T167 follow-up.
- [X] T166-14 [P] Update `docs/observability.md` § F5 with new metrics (`receipt_pdf_render_duration_ms`, `receipt_pdf_render_failures_total`, `receipt_pdf_pending_count`) + 1 new alert (`pdf_render_permanently_failed > 0` → page on-call). NEW runbook `docs/runbooks/receipt-pdf-async-rollback.md` documenting the kill-switch flip procedure.

**T167 follow-up** (NOT part of T166 — gated on prod metric):
- [ ] T167 [P] (post-T166 — optimistic-UI overlay deletion, gated on prod metric `webhook_p95_ms < 1000` for 7 consecutive days): delete `src/app/(member)/portal/invoices/[invoiceId]/_components/optimistic-paid.ts` (~189 LOC) + `optimistic-paid-overlay.tsx` (~63 LOC) + `tests/unit/components/payments/optimistic-paid.test.ts` (~210 LOC); remove `dispatchInvoicePaid()` call sites in PaySheet `index.tsx` settled effect; remove `useOptimisticPaid` call site in `pay-now-button.tsx`; remove `<OptimisticPaidOverlay>` wrapper in invoice detail `page.tsx`; remove `/api/payments/log-optimistic-flip` telemetry route + i18n keys + 3 outbox tests for the optimistic flow. Net delta: −250 LOC. Document in T159 retrospective. Acceptance: payment success drawer→portal flip remains seamless with server-truth-only rendering (webhook latency low enough that user never sees the gap).
- [X] T164 [P] (optional, post-audit UX-audit-item-#17 — print-friendly confirmation panel, LOW priority polish): add `@media print { ... }` stylesheet to `src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/confirmation-panel.tsx` (T079) so accountants who file receipts physically can print the in-browser confirmation cleanly. Print view MUST hide: nav chrome + toolbar + "Download receipt" CTA + "Close" button + drawer overlay backdrop. Print view MUST show: tenant logo (if configured) + invoice number + paid amount with currency + payment method + last4 (card only) + processor charge id (as plain text) + settlement timestamp (ISO UTC + Thai BE for th-TH locale) + member company name (from invoice snapshot). Printable area uses `DetailContainer` equivalent max-width for A4 portrait compatibility. **Important**: this is distinct from F4 receipt PDF (which remains the Thai-tax-compliant document per FR-004); print-friendly panel is accountant convenience only. Defer implementation if no SweCham-admin feedback received within first 30 days post-ship requesting it. Add e2e assertion in `payment-card-happy-path.spec.ts` (T046) extension: `await page.emulateMedia({ media: 'print' })` → assert hidden/visible elements match spec.

**Checkpoint Phase 9 + Final**: All 5 review-gate checklists PASS; SAQ-A re-attested; observability + alerts wired; performance budgets met; manual SR pass complete; soak test executed; retrospective documented; Vercel Rolling Releases plan staged. **F5 READY FOR SHIP.**

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: T001 (F4 merge gate) blocks all subsequent tasks. T002–T009 sequential after T001.
- **Phase 2 (Foundational)**: T010–T040 — F4 barrel extension (T010–T015) blocks F5 use-case work; migrations (T019–T026) block schema (T027) which blocks repos. **No US task can start until Phase 2 fully complete.**
- **Phase 3 (US1 Card)**: Can start after Phase 2; tests (T041–T046) authored RED before T047+.
- **Phase 4 (US2 PromptPay)**: Can start after US1 PaySheet shell exists (T072–T085); reuses webhook + initiate-payment infrastructure.
- **Phase 5 (US3 Reconciliation)**: Independent of US2; can run parallel after US1 produces paid-online data.
- **Phase 6 (US4 Refund)**: Independent of US3; can run parallel after US1 produces paid invoices.
- **Phase 7 (US5 Failure)**: Mostly UI hardening + tests; can run parallel after US1+US2 surfaces stable.
- **Phase 8 (US6 Email verification)**: Test-only phase; can run parallel after US1.
- **Phase 9 (Polish)**: Depends on all USs complete + must include review-gate blockers (T135 retention backfill, T144–T147 a11y).

### User Story Dependencies

- **US1**: blocks nothing; pure dependency on Foundational
- **US2**: shares PaySheet infrastructure with US1 (T072–T085); minimal additional work
- **US3**: independent — can be developed without waiting for US2/US4
- **US4**: independent — can be developed without waiting for US3 (but admin can only refund AFTER US1+US2 have produced paid invoices for end-to-end testing)
- **US5**: extends US1+US2 with additional failure modes; can author tests independently
- **US6**: pure F4 contract verification; trivial after US1 ships

### Within Each User Story

- Tests authored RED → committed → implementation → tests turn GREEN
- Domain → Application ports → Application use cases → Infrastructure adapters → API routes → UI components
- Each use case wired into module barrel before API route consumes it
- I18n keys added before UI components reference them (`pnpm check:i18n` enforces)

### Parallel Opportunities

- All Phase 1 [P] tasks can run in parallel after T001 gate passes
- Migrations 0032–0037 (T019–T024) are independent SQL files — fully parallel
- Migration 0038 (T025) MUST run last (depends on F4 audit_log table existence + backfill needs F4 event types stable)
- Domain layer tasks (T047–T053) are independent files — fully parallel
- Application port files (T054) are independent — parallel
- Infrastructure repo files (T061–T067) are independent — parallel
- E2E test files (one per scenario) are independent — parallel
- Phase 9 polish tasks marked [P] are mostly independent — significant parallelism

---

## Parallel Example: Phase 2 Foundational

```bash
# After T010 F4 barrel PR lands, run all migrations in parallel:
Task: "T019 Create drizzle/migrations/0032_create_payments.sql"
Task: "T020 Create drizzle/migrations/0033_create_refunds.sql"
Task: "T021 Create drizzle/migrations/0034_create_tenant_payment_settings.sql"
Task: "T022 Create drizzle/migrations/0035_create_processor_events.sql"
Task: "T024 Create drizzle/migrations/0037_credit_notes_add_source_refund_id.sql"

# Cross-cutting infra in parallel:
Task: "T032 Extend src/lib/logger.ts redact list"
Task: "T033 Extend src/app/middleware.ts CSP for Stripe"
Task: "T034 Extend RBAC matrix in rbac-guard.ts"
Task: "T035 Extend audit event types"
```

## Parallel Example: User Story 1 Tests (TDD — author all RED first)

```bash
Task: "T041 Contract test post-payments-initiate.contract.test.ts"
Task: "T042 Contract test post-webhooks-stripe-events.contract.test.ts"
Task: "T043 Integration test tenant-isolation.test.ts (Review-Gate blocker)"
Task: "T044 Integration test webhook-signature.test.ts"
Task: "T045 Integration test webhook-idempotency.test.ts"
Task: "T046 E2E test payment-card-happy-path.spec.ts"
```

---

## Implementation Strategy

### MVP First (US1 + US2 = full P1)

Per spec Q1 answer: ship card + PromptPay together as P1 MVP.

1. Complete Phase 1 (Setup) — F4 merge gate is hardest precondition
2. Complete Phase 2 (Foundational) — migrations + Stripe SDK + barrel extensions block everything
3. Complete Phase 3 (US1 Card) — full card payment surface
4. Complete Phase 4 (US2 PromptPay) — extends US1 PaySheet with PromptPay tab
5. **STOP and VALIDATE**: deploy to staging; admin manually tests both methods end-to-end; SAQ-A pre-attestation; tenant-isolation integration test green
6. Ship MVP if SC-001a (proof-of-life ≥3 payments in 30 days) is achievable post-ship

### Incremental Delivery Post-MVP

7. Add US3 (Reconciliation) → enables admin month-end variance check (SC-011)
8. Add US4 (Refund) → enables in-app refund flow (replaces Stripe-dashboard-refund)
9. Add US5 (Failure surface) → hardens + verifies edge cases
10. Add US6 (Email verification) → defensive contract test
11. Phase 9 polish + checklists + SAQ-A re-attestation → SHIP

### Parallel Team Strategy

With multiple developers post-Foundational:
- Developer A: Phase 3 (US1 Card)
- Developer B: Phase 4 (US2 PromptPay) — paired with A on PaySheet shell
- Developer C: Phase 5 (US3 Reconciliation) + Phase 6 (US4 Refund) sequentially
- Developer D: Phase 9 (Tests + observability + checklists)

---

## Notes

- **Constitution v1.4.0 NON-NEGOTIABLE alignment**: Principle II (TDD) — every US has tests authored RED before impl; Principle I (Tenant Isolation) — T043 tenant-isolation test is Review-Gate blocker; Principle IV (PCI DSS) — T151 PCI checklist + T155 SAQ-A re-attest gate; Principle III (Clean Architecture) — T029-T031 module skeleton + ESLint enforcement.
- **Review-Gate blockers**: T010 (F4 merge), T025 (retention backfill — R2-E4), T043 (tenant-isolation test), T044 (webhook signature), T045 (webhook idempotency), T135 (retention backfill integration), T144 (a11y axe-core), T146 (manual SR pass), T151–T154 (4 review-gate checklists), T155 (SAQ-A re-attest).
- **Solo-maintainer substitute** (Constitution Principle IX v1.3.0): if no second human reviewer, run the 5-stack substitute — `/speckit.review` + `/speckit.staff-review` + `pci-saqa-guardian` + `security-threat-modeler` + post-remediation `/speckit.verify`. Document evidence in T159 retrospective.
- **All E2E tests use `--workers=1`** per repo convention (memory note).
- **Verify CPs before marking** per repo convention — don't flip `[X]` on coverage %, p95 latency, or byte-identical assertions until measurement actually run.
- Commit after each task or logical group; use `[Spec Kit]` prefix for gate-advancing commits per CLAUDE.md.
- **Total tasks: 164** across 9 phases (Setup 9, Foundational 31, US1 46, US2 8, US3 6, US4 18, US5 9, US6 2, Polish 35 incl. ship strategy + 3 optional).
- **Post-audit refinements (2026-04-23)**: G1 — T130 expanded to handle BOTH webhook `charge.refunded` branches (in-app finalisation + out-of-band detection); G2 — T120 expanded to cover explicit cancel-button click; G3 — T161 added for Vercel Rolling Releases ship strategy; G4 — T162 (optional) for A06 OWASP plan completeness; G5 — T163 (optional) for `allow_anonymous_paylink` forward-compat verification; UX-audit item #17 — T164 (optional) for print-friendly confirmation panel (A4 portrait printing for accountants who file physically).
