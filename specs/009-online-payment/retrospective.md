# F5 Online Payment — Retrospective

**Branch**: `009-online-payment`
**Authored**: 2026-04-27 (Phase 9 close, REVIEW-READY)
**Author**: Solo-maintainer (Constitution Principle IX substitute applies)
**Predecessors shipped**: F1 Auth (PR #1), F2 Plans (`002-membership-plans`),
F3 Members (`005-members-contacts`), F4 Invoices (`007-invoices-receipts`, PR #12),
006 Layout primitives (PR #9)

## 1. Constitution adherence

**v1.4.0** principles. F5 is the first Chamber-OS feature carrying 🔒 PCI sensitivity
under Principle IV (NON-NEGOTIABLE).

| Principle | Status | Evidence |
|---|---|---|
| I. Tenant Isolation (NON-NEGOTIABLE) | ✅ | `tests/integration/payments/tenant-isolation.test.ts` (T043 Review-Gate blocker). 14/14 cross-tenant probe scenarios green. RLS + FORCE on all 4 F5 tables (`payments`, `refunds`, `tenant_payment_settings`, `processor_events`). Webhook handler runs verifier under bypass context and binds `runInTenant()` immediately after tenant resolution. |
| II. Test-First (NON-NEGOTIABLE) | ✅ | Every US has ≥1 acceptance test authored RED before implementation. ~1300 unit+contract green; 15+ F5 integration tests on live Neon Singapore; 10+ E2E specs (`--workers=1`). Domain 100% line; security-critical use cases 100% branch coverage. |
| III. Clean Architecture (NON-NEGOTIABLE) | ✅ | `src/modules/payments/` follows F1+F2+F3+F4 layering. ESLint `no-restricted-imports` rule blocks Domain → framework imports. Public barrel exposes only sanctioned use-cases. F5 → F4 contract is narrow: `markPaidFromProcessor`, `issueCreditNoteFromRefund`, `getInvoiceForPaymentById`. |
| IV. PCI DSS SAQ-A (NON-NEGOTIABLE) | ✅ | No raw card data ever touches app server. Stripe Elements only (hosted iframe). PromptPay QR generated server-side via Stripe PaymentIntent `next_action.promptpay_display_qr_code` (not a client-rendered QR — amount can't be tampered). `saq-a-attestation.md` § 4 pre-ship checklist + § 5 maintainer attestation block. CSP extended for `js.stripe.com` + `m.stripe.network` only (T033). |
| V. i18n | ✅ | EN+TH+SV at release. Stripe Elements `locale='th'` for Thai card-form labels. Top-20 decline-code translations per spec. |
| VI. Inclusive UX | ✅ | WCAG 2.1 AA on all surfaces. Sheet drawer keyboard nav (Escape closes, focus trap, restore). Mobile full-screen at `< sm`. Reduced-motion matrix per plan.md § UX. |
| VII. Perf & Observability | ✅ | 14 OTel metrics + 9 alerts + full distributed trace lifecycle. SLOs: initiate p95 < 1.2 s, webhook p95 < 500 ms, settlement→portal p95 < 10 s. Logger redact list extended (T032). |
| VIII. Reliability | ✅ | Every error path returns `Result<T, E>`. Atomic transactions with F4 `markPaidFromProcessor` reuse. Webhook idempotency via `processor_events` upsert (FR-008). 17 audit event types with explicit `retention_years` (5 or 10). |
| IX. Code Quality | ✅ | Solo-maintainer 5-stack substitute applied at every Review gate: `/speckit.review` + `/speckit.staff-review` + `pci-saqa-guardian` + `security-threat-modeler` + post-remediation `/speckit.verify`. |
| X. Simplicity | ✅ | One new bounded context. Two new npm deps (`stripe` server SDK + `@stripe/stripe-js` client). Reused F4 atomic markPaid + F4 receipt PDF + F4 outbox email — F5 did NOT re-implement state machine, tax numbering, or PDF engine. |

**Adherence rate**: 10/10 principles green at REVIEW-READY gate. Zero
unjustified deviations. Three documented deviations live in `plan.md` §
Complexity Tracking (Stripe RTT in initiate p95 budget; webhook handler
pinned to Node runtime not Edge; processor_events bypass-context for
pre-tenant-resolution signature verify).

## 2. Plan vs actual scope

**Specified**: 6 user stories (US1+US2 P1 ship-together MVP; US3+US4+US5+US6
incremental), 26 functional requirements + 4 amendments (FR-011a, FR-011b,
FR-016a, FR-025, FR-026), 13 success criteria, 15 named audit events, 4 new DB
tables + 1 bounded context + 2 new npm deps.

**Delivered**:

- **6/6 user stories shipped**, US1 (card) + US2 (PromptPay) as P1 MVP.
- **17 audit event types** (named 15 + 2 emergent: `payment_method_switched` from
  audit-trail review round; `payment_initiate_rate_limited` + `payment_cancel_rate_limited`
  from Threat F-09 / migration 0043).
- **18 migrations** (0033–0050) — exceeded the planned 4-table baseline due to
  iterative review-round additions (rate-limit audits, system-actor seeds,
  webhook unknown-state events, `processor_retrieve_failed`, `invoice_not_found`,
  `payment_method_switched`, card-metadata CHECK relaxations).
- **Two forward-compat seams** delivered as planned: `allow_anonymous_paylink`
  flag (F5.1 pay-link) + `out_of_band_refund_detected` audit (post-MVP escape hatch).
- **Out-of-scope deferrals (consistent with spec Assumptions)**: Google Pay /
  Apple Pay (Payment Request Button); dispute / chargeback response UI; Stripe
  Connect per-tenant OAuth (deferred to F11); split-transaction / partial-payment;
  signed-token unauthenticated pay-link (deferred to F5.1 — flag is forward-compat only).

**Scope creep accepted (with rationale)**:

- T130a (stale-pending-refund recovery) added in Phase 6 review-finding I3 as a
  Postgres double-fault recovery layer; ~150 LOC, integration-tested. Not in
  original spec but warranted given financial-data integrity sensitivity.
- T161 (Vercel Rolling Releases 10/50/100 ship strategy) added post-audit G3 —
  no original ship strategy was specified; rolling-release is post-2025 best
  practice for high-risk first deploys.
- T164 (print-friendly confirmation panel) — DEFERRED LOW-priority polish; will
  ship only if SweCham admin requests it within 30 days post-launch.
- T165 (AST refactor of regex-based pay-sheet revalidation test) — DEFERRED;
  current regex still passes; tracked for future hardening.

## 3. Critique remediation effectiveness

Two `/speckit.critique.run` rounds across the planning gate plus continuous
multi-agent review during implementation.

| Critique item | Resolution | Evidence |
|---|---|---|
| R2-E2 concurrent initiate | Postgres advisory-lock per `(tenant_id, invoice_id)` + idempotency-key `inv-{invoiceId}-{attemptSeq}` | `tests/integration/payments/concurrent-initiate.test.ts` (T136); Promise.all assertion exactly-one row + identical clientSecret |
| R2-E3 stale-pending zombies | `payments.stale_pending_count` gauge + cron-job.org 5-min sweep + alert > 5 / tenant | T138 cron route + T139 integration test + alert wired |
| R2-E4 audit retention compliance regression | Migration 0039 backfill — 6 F4 tax-document event types upgraded from default 5y to 10y | T135 Review-Gate blocker integration test (`audit-retention-backfill.test.ts`) — FAIL = compliance regression |
| R2-E6 admin pay-on-behalf-of-member | RBAC matrix update — `admin` cannot POST `/api/payments/initiate` (403 forbidden_role) | T137 integration test |
| R2-E11 30-day idempotency soak | `scripts/perf/webhook-idempotency-soak.ts` — 1000 random sequences with mixed duplicates | T150; manual invocation pre-prod-ship + per quarterly Stripe API version bump |
| R2-E14 phased rollout | Vercel Rolling Releases 10% → 50% → 100% with 30-min observation windows | T161; per-step gate on success/fail/sig/api-version metrics |
| Q5 / FR-026 Stripe API version drift | API version pinned via `STRIPE_API_VERSION` env var; webhook events with non-pinned version → `acknowledged_only` + audit | T132 integration test |
| FR-010 environment mismatch (test vs live) | Detect `livemode` mismatch on webhook ingest → reject + audit `payment_environment_mismatch` | T133 integration test |
| FR-011a out-of-band refund detection | `charge.refunded` webhook branch — not-found-in-refunds-table → audit-only, no F4 CN | T130 + T131 |
| FR-016 kill-switch | `online_payment_enabled` flag toggleable per tenant; empty-state UI + 503 on API + cache invalidation tag | T134 integration test |
| Architect D-03 split-tx tail | `markProcessed` folded into per-branch `withTx` — atomic commit | inline in `process-webhook-event.ts` § 1 commentary |
| Senior-tester F9 raw-body verify-before-parse | Spy on raw-body reader + JSON parser independently; assert order on signature paths | T044 (existing); pattern reused in T132/T133 |

**Effectiveness rating**: HIGH. All R2-E#1–E#14 critique items closed pre-implementation
or during Phase 9 polish. Zero outstanding critique items at REVIEW-READY.

## 4. UX audit findings application

The pre-implementation UX audit produced 17 acceptance items; 16 landed in code,
1 deferred LOW-priority polish (T164 print-friendly panel).

Notable wins:

- **Sheet drawer with `?pay=1` deep-link** (FR-025 / Q4) — preserves portal context,
  reuses `DetailContainer` width, supports email-deep-link auto-open, Escape closes,
  mobile full-screen at `< sm` breakpoint, reduced-motion variant per plan.md UX matrix.
- **Stripe Elements `locale='th'`** with R2-E2 truncation handling — Thai card-form
  labels render correctly even at narrow widths.
- **Confirmation panel** — payment method + last4 (card) / processor charge id +
  paid amount + settlement timestamp, no PDF re-render (F4 receipt PDF is the
  canonical Thai-tax-compliant document per FR-004).
- **Empty-state when `online_payment_enabled=false`** — explicit "Online payment
  unavailable" surface with admin-contact CTA, not a silent failure.
- **A11y axe scan** (T144) — zero serious/critical violations across Sheet drawer,
  refund dialog, payment timeline, online-payment-disabled empty-state (SC-012).

## 5. Deferred items / known follow-ups

| Item | Why deferred | Tracker |
|---|---|---|
| **Pay-link F5.1** (signed-token unauthenticated clerk-pay) | Out of MVP scope per Q3. Forward-compat seam landed (`allow_anonymous_paylink` flag). | T163 verifies flag has zero user-facing effect in F5 MVP. F5.1 promotion requires audit + threat-model re-run. |
| **A06 OWASP "Vulnerable & Outdated Components"** plan-doc entry | Cosmetic — Stripe SDK already pinned + Renovate/Dependabot covers. | T162 (1-line plan.md addition). |
| **Print-friendly confirmation panel** (`@media print`) | UX-audit item #17, LOW priority. Will land if admin feedback requests within 30 days. | T164. |
| **AST refactor of pay-sheet revalidation test** | 4 brittle regex matchers still pass; no current regression risk. | T165 (R5 round-7 software-engineer review M4). |
| **Optimistic refund UI** (refund button → optimistic processing badge) | Conservative MVP — wait for Stripe webhook before flipping UI. Ergonomic improvement; can land in F5.1 polish. | TBD. |
| **Manual SR pass with NVDA + VoiceOver on pay-sheet** | Human-gated; requires actual screen-reader hardware/OS. | T146; documented in `sr-qa-{date}.md` per security.md § 6. |
| **30-day soak harness execution** (`webhook-idempotency-soak.ts` 1000-event run on pre-prod) | Manual invocation pre-prod-ship + per quarterly API version bump. | T150; `soak-results-{date}.md` evidence file. |

## 6. F4 follow-up recommendations

F5's `markPaidFromProcessor` integration surfaced a few F4 contract observations:

- **F4 invoice state-machine guard** — when webhook `payment_intent.succeeded`
  fires for an invoice that is no longer `issued`/`overdue` (admin manually
  marked paid concurrently, OR invoice was voided), F5 auto-refunds via Stripe.
  This required F4 to expose `getInvoiceForPaymentById` returning enough state
  for F5 to make the auto-refund decision atomically. Pattern works but is a
  cross-module data leak. **Recommendation**: F9 should consider an explicit
  `InvoicePaymentEligibility` value object on F4's barrel rather than the
  current full-record exposure.
- **F4 audit retention column ownership** — F5 added `audit_log.retention_years`
  + backfilled F4 event types (migration 0039). Going forward, F4 (and every
  feature) MUST set `retention_years` explicitly on every audit emission. F4's
  audit emitter does not currently set this column — it relies on the DEFAULT 5
  + the post-hoc backfill. **Recommendation**: F9 should rewrite F4's audit
  emitter to set `retention_years` per event-type-mapping table, eliminating
  the DEFAULT 5 fallback.
- **F4 `issueCreditNoteFromRefund` atomicity** — works correctly but couples F5
  refund tx to F4 CN sequential-numbering advisory lock. Under high concurrent
  refund load, the F4 CN allocator becomes the bottleneck. Not currently an
  issue (F5 refund volume is low) but **recommendation**: profile under load
  before F11 SaaS billing scales the system.
- **F4 receipt PDF re-render on payment** — F4's `markPaidFromProcessor`
  re-renders the receipt PDF every time, even on the initial succeeded webhook.
  F5's auto-email outbox already handles delivery. **Recommendation**: F9 should
  audit whether the re-render is necessary on first-success — current behavior
  is correct (covers fail-then-succeed retry case) but adds Blob upload cost.

## 7. Solo-maintainer substitute evidence

Per Constitution Principle IX, since no second human reviewer was available, the
5-stack substitute was applied at every Review gate:

1. `/speckit.review` — 7 rounds across Phase 3–8, including round-7 software-engineer M4
2. `/speckit.staff-review` — 2 rounds (Phase 7 T120 stabilization + Phase 8 T128/T129)
3. `pci-saqa-guardian` agent — F5 plan + every F5 implementation PR
4. `security-threat-modeler` agent — F5 spec + threat-model document (16 threats T-01…T-16-payments)
5. `/speckit.verify` post-remediation — Phase 8 close

Aggregate: ~12+ multi-agent review rounds across F5 implementation. Zero
constitutional violations escaped to REVIEW-READY.

## 8. What worked well

- **F4 reuse strategy** — F5 leveraging F4's atomic markPaid + receipt PDF +
  outbox email saved an estimated 4–6 weeks of reimplementation. The narrow F4
  barrel extension contract (3 wrappers) was clean.
- **TDD discipline** — every US had RED tests committed before implementation;
  ~1300 unit + 15+ integration tests as the canonical evidence layer.
- **Multi-agent review** — `pci-saqa-guardian` caught the SAQ-A-impact-of-CSP
  question early; `security-threat-modeler` produced a 16-threat catalogue
  pre-implementation, which drove the migration 0043 rate-limit audits.
- **Spec Kit gates** — `/speckit.clarify` produced 6 high-quality clarifications
  (Q1–Q6) that prevented mid-implementation scope churn.
- **F4 retention-column piggyback** — landing the `retention_years` column +
  F4 backfill in F5's migration set (R2-E4) closed a latent compliance bug
  in F4 that would have otherwise required its own future migration.

## 9. What was hard / what to do differently

- **Migration sprawl**: 18 migrations (0033–0050) is a lot. Many were small
  fixes (CHECK relaxations, audit event-type additions, system-actor seeds).
  **Lesson**: bundle related event-type ADD VALUEs in a single migration during
  spec phase rather than per-task.
- **Webhook + tenant binding bypass**: the `processor_events` table can't apply
  RLS-FORCE during pre-tenant-resolution signature verify. Documented as a
  Complexity Tracking deviation. **Lesson**: design tenant-bypass surfaces
  upfront (with explicit `*_unscoped` repository methods) rather than treating
  them as exceptions during implementation.
- **PromptPay billing_details.email**: Stripe server-confirm PromptPay rejected
  initiation without `payment_method_data.billing_details.email`. Required
  threading `actorEmail` through `InitiatePaymentInput`. **Lesson**: validate
  Stripe API gotchas in research.md before plan.md (Q5 caught API version drift
  but missed this).
- **Solo-maintainer load**: 12+ multi-agent review rounds + 9 phases + ~30 task
  groups was a long marathon. **Lesson**: break ship-blocker phases (1–3) from
  hardening phases (4–9) into separate PRs to land faster intermediate
  milestones.

## 10. Pre-ship sign-off

| Gate | Status | Evidence |
|---|---|---|
| All 5 review-gate checklists PASS | ✅ 136/136 | `checklists/{finance,pci,requirements,security,ux}.md` 100% |
| SAQ-A re-attestation | ⏸️ pending T155 | Maintainer signature on `saq-a-attestation.md` § 5 |
| Manual SR pass (NVDA + VoiceOver) | ⏸️ pending T146 | `sr-qa-{date}.md` |
| 30-day soak (1000-event idempotency) | ⏸️ pending T150 staging run | `soak-results-{date}.md` |
| Vercel Rolling Releases plan | ✅ documented (T161) | 10% → 50% → 100% with 30-min windows |
| Retrospective | ✅ this document | T159 |
| `gitleaks` scan F5 branch | ⏸️ pending T156 | pre-ship checklist |

**F5 status**: REVIEW-READY pending the 4 human-gated items above (T146, T150,
T155, T156). Expected ship: 2026-04-28 → 2026-05-02 window.

---

**Author note**: This retrospective is authored before T146/T150/T155/T156 close
because (a) the retrospective is a living document — pre-ship sign-off section
will be re-confirmed at ship time, (b) the engineering analysis (sections 1–9)
is complete now and depends only on Phase 1–9 work that is already landed.
