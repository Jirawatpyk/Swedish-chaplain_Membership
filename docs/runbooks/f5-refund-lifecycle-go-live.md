# F5 Refund-Lifecycle (PR #185) — Go-Live Residual Register

**Purpose**: the single source of truth for what remains before/at go-live of the F5 async
refund-lifecycle branch (PR #185). Every deferred / residual / ship-day / merge-gate item
discovered for this branch is listed here with its category, whether it blocks a safe
go-live, and either the fix or the reason it is safe to defer. Use this as the launch
checklist and as the "known limitations" reviewers + on-call should be aware of.

**Compiled**: 2026-07-12 (adversarial discovery sweep: code markers + runbook residuals +
ledger/go-live-readiness → reliability-guardian consolidation). 25 items.

**Status legend**: 🔴 go-live blocker · 🟡 confirm-at-ship (not a hard blocker) · ⚪ non-blocking / known-limitation

---

## 1. Merge gate — human (cannot be code-closed)

| # | Item | Status | Action |
|---|------|--------|--------|
| MG-1 | **≥2 reviewers + 1 security/finance-checklist sign-off** (payments + audit schema → Constitution v1.4.2 Principle IV / `specs/009-online-payment/security.md §5`) | 🔴 | The primary live gate. Two human reviewers; one signs the security checklist. |
| MG-2 | **CI `test:coverage` green (Gate 8)** | 🔴 | Local run OOM'd a Tinypool worker (440 files passed, **0 test failures** — infra, not a threshold miss). Re-run on CI infra to formally close; no code change expected. |
| MG-3 | Bundled PR #185 vs 3 stacked PRs | ⚪ | Human process call. Maintainer elected to keep as one PR — no safety impact either way. |

## 2. Ship-day operator actions (deploy-time; code cannot close these)

| # | Item | Status | Action |
|---|------|--------|--------|
| OP-1 | **Migration 0242 duplicate pre-flight** on `(tenant_id, source_refund_id)` — `docs/runbooks/f5-0242-preflight-credit-note-dupes.md` | 🔴 | Run the dup-check on **both** the dev Neon branch and prod **before** deploy. A pre-existing duplicate fails the non-concurrent `CREATE UNIQUE INDEX` and breaks auto-migrate-on-deploy. Prod risk LOW (wiped 06-24 / 07-10); dev branch HIGHER (pre-fix integration rows). |
| OP-2 | **Enable Stripe `charge.refund.updated` delivery** — **after** the `processRefundUpdated` handler is deployed | 🔴 | Ordering-sensitive: enabling too early swallows events on the `acknowledged_only` 200-ack branch; never enabling hangs every async refund forever. Watch `payments_refund_pending_awaiting_processor_total` (sustained > 0 = subscription broken). |
| OP-3 | **`pnpm seed:system-actors:prod`** (webhook actors f5001/f5002) if prod was wiped | 🔴 | Prod was re-wiped 07-10, so this almost certainly applies. Run **before** resuming Stripe traffic, else every refund webhook FK-throws and payments stick pending. See `reference_prod_wipe_breaks_system_actors`. |
| OP-4 | cron-job.org `sweep-stale-pending-refunds` per-request timeout **≥60s** | 🟡 | Budget = 35s internal + ≤8s Stripe retrieve + finalise headroom. A shorter timeout aborts mid-finalise, but the sweep is idempotent + a backstop, so a bad run self-corrects next pass. Confirm, don't block. |
| OP-5 | Migrations 0240–0243 auto-apply on deploy; **renumber 0243** if a `0243+` migration lands on `main` first | 🟡 | Only a NIT renumber (+journal offset) needed on a collision — verify at merge. |

## 3. Closed for go-live (code-fixable — done / in this branch)

| # | Item | Status |
|---|------|--------|
| CF-1 | **Guard-miss sub-case (i)** — succeeded/non-`failed` row stamped no marker → false OOB on both webhooks | ✅ CLOSED — `attachAutoRefundMarkerOnFailed` generalised to `attachAutoRefundMarkerIfAbsent` (guards on `auto_refund_processor_refund_id IS NULL` only), called in the else branch; runbook §1.1 → CLOSED. |
| CF-2 | **Failed-auto-refund forensic has no resolve/acknowledge event** — admin alert + member "reconciling" copy persist forever after out-of-band reconciliation | ⏳ in progress — append-only `auto_refund_reconciled` event (10y) + an admin acknowledge action; `findStaleInvoiceAutoRefund.failed` returns false once a reconcile event exists. Money-safe today (forensic still pages) — a forensic/UX-closure gap, not a data risk. |
| CF-3 | a11y/UX polish nits — refund-dialog `?refund=1` URL strip, SV en-dash | ⏳ in progress — cosmetic; the renewals semantic-token migration + T9a chip labels are **pre-existing PR #181** items, not #185's. |
| CF-4 | ~18 ledger MINOR cosmetic items (stale comments, doc drift) | ⏳ in progress — all triaged SAFE by the whole-branch review; e.g. `6x6`→`7x7` matrix comment. |

## 4. Known limitations — accepted residuals (NOT fixed by design; safe to launch)

Each is a genuine inherent trade-off or an intentional design choice, **not a forgotten bug**.
None blocks a safe go-live. Revisit criteria noted where relevant.

| # | Residual | Why deferred (accepted) |
|---|----------|--------------------------|
| KL-1 | **B.1** manual F4 credit-note vs F5 refund pre-flight cross-module race (stale credited-total cap) — runbook §1.2 | Full close needs a shared cross-module F4↔F5 advisory-lock namespace — an inherent architectural cost. Window is seconds-wide; low volume / few admins; F4 already rejects over-credit at book time, so the residual is only an orphan-refund window reconciled via the OOB runbook §2–3. **Revisit** if refund volume or admin count grows materially. |
| KL-2 | **F8 marker-commit crash window** — crash between the F5 return and the reject-refund marker-commit → cycle lapses instead of cancelled (label wrong, money right) — runbook §1.3 | The marker stamp is a separate tx from the external Stripe call and cannot be made atomic across an external boundary. Money-safe (refund already succeeded); narrow window; strictly better than the pre-F8-RP-2 baseline (where **every** async reject lapsed); the 30-day timeout resolves the label. |
| KL-3 | issue-refund Phase-B / finalise **double-fault** compensation (Stripe refunded, DB CN write failed) | Designed compensation path — no distributed tx spans Stripe+DB. Row stays `pending`, recovered by the stale-pending sweep cron (`stale_pending_refund_detected`, 10y forensic) + OOB runbook keyed on `credit_notes.source_refund_id`. |
| KL-4 | `process-charge-refunded` **full per-refund amount invariance** needs a webhook-verifier projection extension | Genuinely code-fixable but feature-sized (verifier would emit `refunds.data[i].amount` per id; today only `refundIds[]` + total). Already mitigated by `refund_amount_mismatch_detected` + the OOB sweep. Track as the R2 follow-up. |
| KL-5 | Sweep row-cap fairness at multi-tenant scale (`MAX_STALE_REFUNDS_PER_SWEEP`; rows past position 50 deferred) | Bounds external Stripe calls per run; the idempotent next pass drains the rest. Partially hardened (`ORDER BY initiated_at ASC`). Only matters at large multi-tenant scale — not real at single-tenant SweCham volume. |
| KL-6 | Pending refund amounts **intentionally NOT subtracted** from `computeRemainingRefundable` | Deliberate + correct: a pending refund can still fail and re-open the balance, so the UI gates on pending-**existence** instead of subtracting. |
| KL-7 | OOB forensic redundancy assumes the webhook keeps **both** `charge.refunded` and `charge.refund.updated` — runbook §1.4 | Config/ops invariant, not a code gap: dropping one while keeping the other is a Stripe endpoint misconfiguration. On-call dedupes the dual audit by `processor_refund_id`; the paging metric is single-owner. |
| KL-8 | prettier not run / `format:check` not in CI (printWidth 100 vs committed ~80-col) | Running prettier now balloons the diff for no reliability benefit. Leave to a repo-wide formatting decision. See `reference_no_prettier_this_repo`. |
| KL-9 | F8-RP-2 `refund_pending`/`failed` emit no F8-side audit | Matches the sync path; the events are fully audited on the F5 side. An F8-side duplicate would be redundant. |
| KL-10 | Ambient pre-existing F4/F8/F7.1 TODO markers in files this branch merely edited | Predate #185 (F4/F8/F7.1 backlogs). Reviewers should not treat them as introduced by this PR. |
| KL-11 | Payments post-MVP schema tech-debt (`reason_kind` enum; refunds-repo `Result`-return migration) | Refactor-only / schema-enhancement; no behavioural or money impact. Track post-MVP. |

## 5. Out of scope (business / post-MVP — not this branch)

| # | Item | Why out of scope |
|---|------|------------------|
| OOS-1 | `charge.dispute.created` leaves `invoiceId` undefined — TODO pending dispute UI | Only relevant once a dispute feature/UI is in scope, which #185 is not. No refund-lifecycle path depends on it. |
| OOS-2 | Cross-FY credit-note numbering convention (tax#2) | **Business/accountant decision.** Code pins current behaviour (CN takes §87 number + fiscal year from the invoice's frozen FY; issue-date = settle date). A tax auditor **VERIFIED** no §87 gap and correct ภ.พ.30 VAT bucketing by `issueDate`. Only the number-by-issue-year *convention* is open (RD interpretation). If the accountant elects issue-year, it is a small code change (`loaded.fiscalYear` → current FY at settle). Not go-live-blocking as-is. |

---

## Bottom line for go-live

- **Code**: the 4 code-fixable deferrals are being closed on this branch (CF-1 done; CF-2/3/4 in progress). Nothing in §4/§5 needs code before launch.
- **Merge gate (§1)**: MG-1 (≥2 reviewers + security sign-off) and MG-2 (CI coverage) are the real blockers — both human/CI, not code.
- **Ship-day (§2)**: OP-1, OP-2, OP-3 are 🔴 must-do at deploy in the stated order. OP-4/OP-5 are confirm-not-block.
- **Known limitations (§4/§5)**: documented + accepted; none blocks a safe launch. Revisit KL-1 (B.1) and KL-5 (sweep fairness) if volume/tenancy grows.
