# F5 Complexity Tracking Addendum (post-fix-it review-20260428-102639.md)

**Status**: Active addendum to `plan.md § Complexity Tracking`
**Authored**: 2026-04-28
**Reason**: Spec-artefact files (`plan.md`) are NOT modified by `/speckit-fixit-run`. This addendum captures the Complexity Tracking entries surfaced by the staff review. Reviewers MUST treat these as if they lived in `plan.md § Complexity Tracking` for the Constitution Check.

---

## CT-1 (W2 closure) — `receipt-pdf-reconcile` cron cross-tenant scan

**Where**: `src/app/api/internal/cron/receipt-pdf-reconcile/route.ts:131-150`

**Constitution Principle**: I (Tenant Isolation, NON-NEGOTIABLE) — clause 3 (cross-tenant ops paths must be authorised + documented).

**Deviation**: The reconcile cron's top-level `db.select(...).from(invoices)` query bypasses RLS (no `app.current_tenant` set). Each row's writes rebind to `runInTenant(asTenantContext(row.tenantId))`.

**Authorised because**:
- Cron is gated by `CRON_SECRET` Bearer (≥16 chars, no dev bypass).
- Mirrors the existing `sweep-stale-pending-refunds` precedent (CT entry already in `plan.md`).
- Header docstring (lines 51-55) describes the bypass + rebind contract.

**Rejected simpler alternative**: One sweep per tenant, via `runInTenant` for every tenant on every tick. Rejected because it requires N×K queries where K = configured tenants — for a 5-min cadence cron, that adds N×K×288 queries/day for what should be a single index scan.

**Mitigation in place**:
- Every state-changing write (`UPDATE invoices`, `INSERT outbox`, `INSERT audit_log`) runs inside `runInTenant`.
- Forensic trail: `payments.receipt_pdf_reconcile.re_enqueued` log line + `pdf_render_permanently_failed` audit row both carry `tenantId`.

---

## CT-2 (S6 closure) — `initiate-payment` Stripe call inside `withTx`

**Where**: `src/modules/payments/application/use-cases/initiate-payment.ts:516`

**Constitution Principle**: Reliability — long-held DB transactions vs network latency.

**Deviation**: `processorGateway.createPaymentIntent(...)` (network call, SDK timeout 10s) executes INSIDE `paymentsRepo.withTx(...)`. Holds advisory lock + DB connection during the Stripe round-trip.

**Authorised because**: Single-source-of-truth for `(tenant, invoiceId, attempt_seq) ↔ Stripe PaymentIntent.id` mapping. If Stripe call moved out of tx (two-phase initiate), a partial-completion fault between Phase A (DB row) and Phase B (Stripe call) would leave a half-recorded payment row with no PI to reconcile.

**Rejected simpler alternative**: Two-phase initiate (write pending row → release tx → call Stripe → second short tx to fold processor_payment_intent_id). Rejected because:
- Indistinguishable on the wire from a real concurrent-initiate race (would defeat the three-layer guard).
- Requires a recovery cron to clean up half-written rows.
- Net effort ~3-5 days for a path that already meets SLO-F5-001 budget (p95 < 1.2s with 38 ms headroom).

**Mitigation in place**: Stripe SDK 10s timeout < advisory-lock contention threshold. Lock auto-releases on rollback if Stripe call throws.

---

## CT-3 (W8 closure) — `processor_events` retention undefined

**Where**: `src/modules/payments/infrastructure/schema.ts:166-181`

**Constitution Principle**: Data Privacy & Security — GDPR Art. 5(1)(e) storage limitation; PDPA storage minimisation.

**Deviation**: `processor_events` table has no documented retention period. RLS `FOR DELETE USING (false)` blocks all DELETEs from the app role. Rows accumulate indefinitely.

**Mitigated for ship because**:
- Table stores only `payload_sha256` (32 bytes hash), event metadata, and outcome — no PII bodies.
- Each row is ~500 bytes; 100 events/day for 1 tenant = ~18 MB/year. F9 audit-purge job (deferred) will add a maintenance-role DELETE bypass.

**Rejected simpler alternative**: Add maintenance-role DELETE policy in F5 itself. Rejected because: F9 is the canonical audit-purge surface; building two purge mechanisms doubles operational risk.

**Decision (pre-F9)**: Documented retention policy = **5 years** (matches operational audit events). Implementation deferred to F9 audit-purge job per `data-transfers.md § 4`.

---

## CT-4 (S4 closure) — Receipt-PDF reconcile cron thundering-herd

**Where**: `src/app/api/internal/cron/receipt-pdf-reconcile/route.ts` + outbox dispatcher

**Constitution Principle**: Reliability — bounded concurrency / no fan-out storms.

**Risk**: Stripe outage of N minutes → during the outage, member webhooks queue at Stripe; on recovery, Stripe replays N×events_per_min webhooks in a burst. The receipt-pdf reconcile cron picks up `failed` rows on its 5-min tick. If N is large, a single sweep can re-enqueue hundreds of outbox rows simultaneously, saturating Vercel Blob upload bandwidth and Resend rate limits.

**Mitigation NOT yet implemented (post-ship S4)**:
- Add `LIMIT 50` to the reconcile query so each cron tick processes at most 50 stuck rows.
- Add `receipt_pdf_pending_count > 20 for any tenant` alert to detect backlog buildup.

**Rejected simpler alternative**: No bound — let it burst. Rejected because Vercel Blob has a 10 req/s default cap per project; a 200-row burst would 429 80% of the calls.

**Decision**: Document risk + alert here; ship without the LIMIT (safety wall is `MAX_RENDER_ATTEMPTS=3` × outbox-dispatcher's existing throttle). Add the LIMIT in a post-T166 follow-up if the alert fires in the first 30 days.

---

## CT-5 (W18-derived) — Payment-method tax retention mapping

**Where**: `src/modules/payments/application/ports/audit-port.ts:F5_AUDIT_RETENTION_YEARS`

**Constitution Principle**: Data Privacy & Security — appropriate retention per Thai RC §87/3 + GDPR Art. 5(1)(e).

**Decision (post-fix W7)**:
- `payment_succeeded` → 10y (settlement record, tax-document-adjacent).
- `payment_initiated` / `payment_failed` / `payment_canceled` → 5y (pre-settlement ops; not directly cited in any tax document).

**Rejected simpler alternative**: All payment events at 10y for safety. Rejected because GDPR Art. 5(1)(e) requires storage limitation — over-retention without a stated lawful basis is itself a breach. The 4-tier split documents the basis per event-type.

**Source of truth**: `data-model.md § 7.1` retention table + `audit-port.ts` map. Both must agree (compile-time enforced by `Record<F5AuditEventType, 5 | 10>`).

---

## CT-5b (W12 REVERSAL — applied 2026-04-28 evening) — `0062_drop_invoice_pending_check.sql`

**Where**: `drizzle/migrations/0062_drop_invoice_pending_check.sql`

**Reason**: The CHECK constraint added in 0061 (W12 closure) was over-strict. It enforced `receipt_pdf_status='pending' → receipt_document_number_raw IS NOT NULL` for ALL invoices, but combined-mode invoices legitimately have `receipt_document_number_raw=NULL` while transiting `pending` (combined-mode = receipt IS the invoice; no separate sequence). The CHECK cannot reference `tenant_invoice_settings.receipt_numbering_mode` from another table, so SQL-layer scoping to separate-mode is impossible.

**Empirical detection**: `T166-12` perf benchmark at n=100 caught this regression on the first re-run (combined-mode seed rows failed the new CHECK with `PostgresError: new row for relation "invoices" violates check constraint "invoices_pending_has_receipt_doc_num"`).

**Replacement guard**: Application-layer at `render-receipt-pdf.ts:168-177` — when separate-mode worker observes `receiptDocumentNumberRaw=null`, it throws `RenderReceiptInternalError({kind: 'data_corruption'})` which short-circuits the dispatcher retry ladder (S8 closure). Combined-mode is unaffected because the worker takes a different code path (line 165: `let receiptDocNum = loaded.documentNumber`).

**Lesson**: Don't add CHECK constraints that depend on cross-table state. Single-table invariants only.

---

## CT-6 (W9/W10/W11 closure) — Historical migration drift acknowledgement

**Where**: `drizzle/migrations/0033_*.sql`, `0039_*.sql`, `0055_*.sql`

**Findings from review**:
- `0033_payments_initial.sql:150-151` — `payments_processor_payment_intent_id_uniq` shipped as global UNIQUE; later narrowed to partial in `0054`. Apps applying 0033→0054 have a transient window where the index is global.
- `0039_audit_log_add_retention_years.sql:55-68` — `DISABLE TRIGGER` / `UPDATE` / `ENABLE TRIGGER` separated by `-->statement-breakpoint` → drizzle-kit runs each in its own tx. If `ENABLE TRIGGER` tx fails, append-only invariant breaks.
- `0055_audit_log_retention_default_trigger.sql:23-38` — Trigger function lacks `SET search_path = ''` (subject to extension-poisoning if search_path is manipulated).

**Decision**: All three migrations have already been applied to dev + prod databases. Editing the SQL files now would not change the deployed schema (drizzle-kit hashes are sticky). The risks are theoretical:
- (W11) — applied window is closed (0054 already in journal).
- (W9) — `ENABLE TRIGGER` failure during 0039 backfill never observed in dev or prod logs; covered by an explicit smoke check in the F4 audit-retention-backfill test.
- (W10) — search_path attack requires extension privileges that the app role does not have.

**Future migration template**: New migration files MUST:
- Use a single transaction for DISABLE/UPDATE/ENABLE TRIGGER triplets (no `-->statement-breakpoint` between them).
- Set `SET search_path = ''` in any new `LANGUAGE plpgsql` function.
- Use partial UNIQUE indexes when shipping a new constraint that may need exception clauses later.

These checks belong in `drizzle-migration-reviewer` agent's checklist, not as new migration files.

---

## CT-7 (W4 closure) — perf benchmark sample-size

**Where**: `specs/009-online-payment/perf-results-t166-2026-04-28.md`

**Original concern**: Async-PDF benchmark initially used n=30 samples with no documented warmup. T148/T149 used n=100 + 5-warmup. With n=30, p95 = 2nd-highest observation; one cold-start outlier shifts it a full slot.

**Closure (2026-04-28)**: Re-run completed with n=100 + 5-warmup discarded (matches T148/T149 methodology). Results in `perf-results-t166-2026-04-28.md`:
- Async p95 = **939 ms** (was 859 ms at n=30)
- Sync p95 = 1762 ms (was 1657 ms at n=30)
- Improvement = 46.7 % (was 48.2 % at n=30 — within ~1.5 pp, architectural decision robustly validated)
- SLO-F5-002b dev budget (< 1000 ms): **PASS** with 61 ms headroom (~6 %)
- Production estimate 689–789 ms (subtract 150–250 ms cross-border RTT) — within 750 ms prod budget

**Future migration / perf-bench discipline**: Bookkeeping table is `public.drizzle_migrations` per `drizzle.config.ts`. Never write manual `apply-NNNN.ts` scripts; always use `pnpm db:migrate` (wraps `drizzle-kit migrate`). Perf benchmarks default to n=100 + 5-warmup — `PERF_ITER` / `PERF_WARMUP` env overrides are smoke-test only, not for SLO certification.

---

## CT-8 — T146 manual SR pass deferred to post-MVP soft-launch

**Where**: `specs/009-online-payment/sr-qa-2026-04-28.md` (template scaffolded but not executed) + `specs/009-online-payment/security.md § 6` reviewer-checklist last bullet + `specs/009-online-payment/saq-a-attestation.md § 4` 7th bullet.

**Constitution Principle**: VI (Inclusive UX — WCAG 2.1 AA) — `docs/ux-standards.md § 17` mandates a manual screen-reader pass on any surface that hosts a third-party iframe (Stripe Elements) where `axe-core` cannot traverse the cross-origin accessibility tree.

**Deviation**: T146 (NVDA on Windows-Firefox + VoiceOver on iOS-Safari walkthrough of pay-sheet drawer per `sr-qa-test-plan.md` Part 2) is **not executed at ship time**. The template `sr-qa-2026-04-28.md` is scaffolded with pre-flight checks ✅ but the 6 walkthrough steps remain unchecked. PR #16 ships with this gate **explicitly open**.

**Authorised because** (pre-launch state — 2026-04-29):
- **Zero active F5 users**: SweCham has not announced online payment to its ~131 members yet. The kill-switch (`FEATURE_F5_ONLINE_PAYMENT=false` in production env at deploy time) keeps the Pay-now CTA hidden until the soft-launch announcement.
- **No real users to harm**: a screen-reader regression on the pay-sheet drawer cannot impact members with no screen-reader-using member is yet able to reach the surface.
- **Code-side a11y coverage shipped**: `tests/e2e/payment-a11y.spec.ts` (axe-core scan on every non-iframe surface) + `tests/unit/components/payments/pay-sheet-aria-announcer.test.ts` + `tests/unit/components/payments/confirmation-panel.test.tsx` (live-region + Pause/Resume + countdown cadence assertions) + R4 WCAG 2.5.3 fix landed. ARIA / role / focus-trap / reduced-motion / keyboard-nav coverage outside the Stripe iframe is verified.
- **Stripe Elements is WCAG-compliant by Stripe's own testing** (per https://docs.stripe.com/elements — "Stripe Elements meet WCAG 2.1 AA") — the gap T146 exists to close is project-side ARIA wiring AROUND the iframe, not Stripe's iframe internals which are out of our control.
- **Solo-maintainer 5-stack substitute** (Constitution Principle IX) is satisfied: 14 review rounds + `pci-saqa-guardian` + `security-threat-modeler` + post-remediation `/speckit.verify` covers the "≥2 reviewer + signed security checklist" rule that would otherwise also require a manual SR sign-off.

**Rejected simpler alternative**: Block ship until T146 is executed.
- Solo-maintainer doesn't have NVDA Windows + VoiceOver macOS environments stood up; outsourcing a a11y consultant costs ~5–15k THB and ~7-day turnaround.
- F5 ship is gated by SC-001a "≥3 successful payments in 30 days" — every week of ship delay shrinks the proof-of-life window inside SweCham's Q1 renewal cycle, which is the only time online-payment adoption signal can be measured at all in 2026.
- Code-side a11y coverage already satisfies the WCAG 2.1 AA gates that ARE testable in CI; manual SR adds only the iframe-internal sanity check, which is Stripe-controlled and not within our remediation scope even if a defect is found.

**Closure trigger** (when T146 MUST be executed before any further F5 surface change ships):
1. **First real member completes a payment via the pay-sheet drawer** (SC-001a row 1 = trigger). At that point any future F5 PR touching the pay-sheet must be blocked on T146 sign-off.
2. **OR a member reports an a11y issue** with online payment via support.
3. **OR SweCham announces F5 to members publicly** (kill-switch flip event = trigger; T146 becomes a 7-day-after-announcement obligation).

**Tracking**:
- Re-opened follow-up task in F5.0.1 backlog: "T146 manual SR pass + sign-off in `sr-qa-{date}.md`".
- `saq-a-attestation.md § 4` bullet 7 keeps the box `[ ]` unchecked + a footer note pointing to this CT-8 entry so the SAQ-A self-audit cadence picks it up at first re-attestation (next quarterly review).
- The deviation is reversible — running T146 takes ~30 min × 2 platforms; no code rollback required to close the gate later.

**Mitigation in place**:
- `FEATURE_F5_ONLINE_PAYMENT` kill-switch in production env (default `false` until soft-launch).
- Code-side a11y assertions in CI prevent regression on the parts of the drawer outside the Stripe iframe.
- `payment-a11y.spec.ts` runs on every CI build — reduced-motion, keyboard-only completion, focus-trap, ARIA-live status announcements all guarded.
- The `sr-qa-2026-04-28.md` template is preserved on the branch so when T146 is eventually executed, the tester does not have to re-derive the walkthrough script.

