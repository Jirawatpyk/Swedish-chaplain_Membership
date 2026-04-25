# Financial & Audit Requirements Quality Checklist: F5 — Online Payment

**Purpose**: Validate that F5 spec/plan requirements relating to financial integrity (refunds, credit-note linkage, reconciliation), audit-trail completeness, retention policies (5/10 year), and F4 integration boundary (Constitution Principle VIII + Thai RD §86/§87/3) are complete, clear, consistent, and measurable. Tests the WRITING of financial + audit requirements, not the implementation.
**Created**: 2026-04-23
**Feature**: [spec.md](../spec.md) + [plan.md](../plan.md) + [data-model.md](../data-model.md)
**Audience**: Reviewer (PR) — Review Gate blocker per Constitution Principle VIII + § Compliance: Thai Tax Compliance
**Depth**: Standard (~30 items)

## Refund Rules (FR-011 + FR-011a + FR-011b)

- [x] CHK001 Is the in-app-only refund constraint (Q2 answer) stated unambiguously with explicit normative MUST language? [Clarity, Spec §FR-011 + § Clarifications Q2]
- [x] CHK002 Are the refund-amount validation rules (`0 < amount ≤ remaining`) specified with the formula `remaining = payment.amount_satang − Σ(prior succeeded refunds)`? [Clarity, Spec §FR-011 + §FR-011b]
- [x] CHK003 Is the multi-partial-refund-per-payment behavior defined with the cumulative-sum cap rule? [Completeness, Spec §FR-011 + Q6 answer]
- [x] CHK004 Are the Payment status transitions (`succeeded → partially_refunded → refunded`) defined as a state-machine with explicit triggers? [Clarity, Spec §FR-011b + data-model.md § 2.5]
- [x] CHK005 Is the row-level lock requirement (`SELECT … FOR UPDATE` on `payments(id)`) specified for serialising concurrent refund attempts? [Completeness, Spec §FR-011b + plan.md § Reliability]
- [x] CHK006 Is the out-of-band refund detection rule (FR-011a) specified with both detection criteria (no matching in-app `refunds` row) and response (audit + alert + NO F4 side-effect)? [Completeness, Spec §FR-011a]

## Credit-Note Linkage (F4 Integration)

- [x] CHK007 Is the F4 hand-off contract via `issueCreditNoteFromRefund(tenantCtx, invoiceId, {refundId, amountSatang, reason})` defined with all parameters specified? [Completeness, plan.md § Summary + research.md § 6]
- [x] CHK008 Is the one-credit-note-per-refund rule explicit (single line, amount = refund amount, description = refund reason)? [Clarity, Spec §FR-011]
- [x] CHK009 Is the F4 invoice status transition pathway (`paid → partially_credited → credited` per F4 FR-021 rules) cross-referenced and consistent? [Consistency, Spec §FR-011b + F4 references]
- [x] CHK010 Is the new column `credit_notes.source_refund_id` defined with FK + nullable + partial-index requirements? [Completeness, data-model.md § 6]

## Reconciliation Requirements

- [x] CHK011 Is the reconciliation-variance success criterion SC-011 quantified with a tolerance threshold (≤ THB 1.00 per month per post-critique P8)? [Measurability, Spec §SC-011]
- [x] CHK012 Are the cadence + responsible role for monthly reconciliation review defined (admin reviews monthly per spec § Assumptions)? [Completeness, Spec § Assumptions / Operational]
- [x] CHK013 Is the postmortem trigger (non-zero variance for any month OR `out_of_band_refund_rejected_total` > 0 for 2 consecutive months) specified with explicit escalation path? [Clarity, Spec §SC-011 + plan.md § VII.Metrics]
- [x] CHK014 Is the `payments.stale_pending_count{tenant}` metric defined with computation method (Vercel Cron 5-min cadence + Drizzle query) per post-critique R2-E3? [Completeness, plan.md § VII.Metrics]

## Audit Retention Policy (Constitution Principle VIII)

- [x] CHK015 Is the audit retention column `audit_log.retention_years SMALLINT NOT NULL DEFAULT 5` specified with CHECK constraint and per-event-type mapping? [Completeness, data-model.md § 7.1 + § 7.2]
- [x] CHK016 Is the F4 backfill `UPDATE` (R2-E4 compliance fix) specified with the explicit list of tax-document event types receiving 10-year retention? [Completeness, data-model.md § 7.2]
- [x] CHK017 Is the legal-obligation lawful basis (Thai RD §87/3 + GDPR Art. 6(1)(c)) cited explicitly for the 10-year retention category? [Traceability, data-model.md § 7.2 + plan.md § I.Lawful basis]
- [x] CHK018 Is the F9 (future GDPR purge job) ownership of retention enforcement explicit ("F5 sets the flag; F9 enforces") to prevent ambiguity about who deletes? [Clarity, data-model.md § 7.1]
- [x] CHK019 Is the retention-enforcement integration test (R2-E4 backfill test) specified as a Review-Gate blocker? [Completeness, plan.md § Testing]

## Audit Event Coverage (20 F5 + 17 F4)

- [x] CHK020 Are all 20 F5-introduced audit event types enumerated with complete payload schemas (required keys + optional keys + severity)? [Completeness, Spec §FR-020 + data-model.md § 7] (16 from migration 0040 + 2 rate-limit events from migration 0043 per Threat F-09 + 2 webhook ops-visibility events from migration 0046 per audit 2026-04-25 findings #10/#13)
- [x] CHK021 Is the immutability requirement on audit entries stated unambiguously ("MUST NOT be mutable or deletable")? [Clarity, Spec §FR-020]
- [x] CHK022 Is the actor-correlation requirement (every audit entry includes acting user + tenant + correlation_id + timestamp UTC) specified consistently across all 20 event types? [Consistency, Spec §FR-020 + data-model.md § 7]
- [x] CHK023 Are the 6 F4 tax-document event types subject to the backfill (`invoice_issued`, `invoice_paid`, `invoice_voided`, `credit_note_issued`, `invoice_pdf_resent`, `invoice_pdf_regenerated`) verified against F4's actual event-type list (`specs/007-invoices-receipts/data-model.md`)? [Traceability, data-model.md § 7.2]

## Refund Email Delivery

- [x] CHK024 Is the refund-confirmation email path delegated unambiguously to F4's existing credit-note auto-email outbox (no new email infrastructure)? [Clarity, plan.md § Reliability + Spec §FR-012]
- [x] CHK025 Is the email template content requirement (refund confirmation + credit-note PDF attachment) specified for all three locales? [Completeness, Spec §FR-012 + § Edge Cases / Email]

## Idempotency (Money-Moving Endpoints)

- [x] CHK026 Are the 4 idempotency primitives enumerated (processor_events.id PK, processor_payment_intent_id UNIQUE, processor_refund_id UNIQUE, optional Idempotency-Key header)? [Completeness, plan.md § Reliability + Spec §FR-008]
- [x] CHK027 Is the Stripe SDK `Idempotency-Key` format specified explicitly for both `paymentIntents.create` (`inv-{invoice_id}-attempt-{seq}`) and `refunds.create` (`rfnd-{payment_id}-{seq}`)? [Clarity, plan.md § Reliability]
- [x] CHK028 Is the SC-005 100% idempotency requirement under 30-day soak test linked to a defined harness location and trigger cadence? [Measurability, plan.md § Testing — post-critique R2-E11]

## Currency & Amounts

- [x] CHK029 Is the THB-only currency constraint stated as a hard CHECK constraint at the database level (`currency = 'THB'`) and as a normative MUST in spec? [Consistency, data-model.md § 2.3 + Spec § Assumptions]
- [x] CHK030 Is the `amount_satang BIGINT` storage convention (1 THB = 100 satang; never NUMERIC/FLOAT) documented and consistent with F4's Money VO? [Consistency, data-model.md § 1 + plan.md § Constraints]

## Notes

- This checklist tests REQUIREMENT QUALITY for financial integrity + audit obligations, not implementation outcomes.
- Severity: any FAIL on retention items (CHK015–CHK019) is a R2-E4 compliance regression risk + Thai RD §87/3 violation = Review-Gate blocker.
- FAIL on idempotency items (CHK026–CHK028) maps to Constitution Principle VIII (Reliability) and blocks Review Gate.
- Cross-references: spec.md FR-008/FR-011/FR-011a/FR-011b/FR-012/FR-020/FR-022 + plan.md § Reliability + data-model.md § 2/3/6/7 + Constitution Principle VIII + Thai RD §86/§87/3 + GDPR Art. 6(1)(c).

## Audit Resolution Summary (2026-04-23)

**Auditor**: Claude Opus 4.7 (1M context) — automated source-of-truth verification

**Result**: **30 / 30 PASS** ✅ — Financial integrity + audit retention requirements complete after 1 inline resolution

**Methodology**: Each item verified against spec.md (FR-008, FR-011, FR-011a, FR-011b, FR-012, FR-020, FR-022, SC-005, SC-011) + plan.md § Reliability + data-model.md § 2/3/6/7 (incl. § 7.1 + 7.2 retention mapping) + Constitution Principle VIII + Thai RD §86/§87/3 citations.

**Notable observations**:
- Refund rules (CHK001–CHK006) fully spec'd: in-app-only (Q2), free-form THB amount (Q6), multi-partial cumulative cap, row-level lock for concurrent serialisation (FR-011b), out-of-band detection + audit (FR-011a).
- F4 integration boundary (CHK007–CHK010) clean: `issueCreditNoteFromRefund` signature + one-CN-per-refund + F4 invoice status pathway + new `credit_notes.source_refund_id` column with FK + partial-index.
- Audit retention (CHK015–CHK019) addresses R2-E4 compliance regression: per-row column with CHECK + per-event-type mapping + F4 backfill `UPDATE` for 6 tax-document event types + F9 ownership of purge enforcement + integration test as Review-Gate blocker.
- 4 idempotency primitives (CHK026–CHK028) enumerated: PK + UNIQUE × 2 + Idempotency-Key header; Stripe SDK key formats explicit; SC-005 30-day soak test linked to harness location.
- THB-only + amount_satang BIGINT (CHK029–CHK030) consistent across DB CHECK + spec assumptions + F4 Money VO.

### Resolution applied (1 item required spec fix)

- **CHK011** — original assertion "Is SC-011 quantified with a tolerance threshold (≤ THB 1.00 per month per post-critique P8)?" was originally going to FAIL because SC-011 still read "zero THB" (P8 was deferred-to-tasks in Round 2 critique). **Resolved inline 2026-04-23** by editing spec.md SC-011 to include explicit ≤ THB 1.00 tolerance with FX-rounding rationale + postmortem trigger documentation. Now PASS.

**No remaining gaps**. Ready for Review Gate per Constitution Principle VIII + Thai tax compliance.
