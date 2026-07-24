# Runbook — plan-change frozen-price divergence (`check:plan-divergence`)

**Script:** `scripts/check-plan-change-divergence.ts` · **npm:** `pnpm check:plan-divergence` · **Read-only.**

## What it means

The detector finds renewal cycles whose **frozen price disagrees with the
§86/4 that was issued + linked to them**. For every `renewal_cycles` row with a
non-null `linked_invoice_id` pointing at an `invoices` row that is
`status IN ('issued','paid')` and `invoice_subject='membership'`, it compares:

- **cycle side** — `parseThbDecimalToSatang(frozen_plan_price_thb)`
  (VAT-exclusive satang), and
- **invoice side** — the invoice's single `membership_fee` line's
  `unit_price_satang` (VAT-exclusive, **pre-pro-rate**).

The two are directly comparable because the renewal billing path
(`f4-invoicing-for-renewal-bridge-drizzle.ts` → `createInvoiceDraft`) writes the
frozen price verbatim into the line's `unit_price_satang` and forces
`quantity = pro_rate_factor = 1.0000` (a renewal is always a full cycle,
FR-022). We compare on `unit_price_satang` rather than the raw `total_satang`
so the check is immune to a legitimately pro-rated line and to two-step
rounding — comparing the full-cycle frozen price to a pro-rated total would
false-positive.

Two finding kinds:

- `price_divergence` — the frozen price ≠ the billed unit price. This is the
  drift the immediate re-freeze flag can create (a cycle re-frozen to a new
  price while an old §86/4 stays issued+linked at the old price).
- `membership_line_anomaly` — the linked invoice does not carry **exactly one**
  `membership_fee` line (0 or >1). A real membership §86/4 always has exactly
  one; a `lines=0` result on a `test-*` tenant is fixture noise (see below).

## The superseded-audit + reconcile contract (Finding #20 / M1)

Two use-cases issue a membership §86/4 through a create/capture → issue → link
sequence where the frozen-price capture + the issue run OUTSIDE the per-cycle
advisory lock: **confirm-renewal** (member self-renew, Step-4 link) and
**admin-renew-lapsed-member** (admin lapsed-comeback, Step-3 link). In the gap
between capture and link, a concurrent admin `change-plan` immediate-refreeze
(`FEATURE_PLAN_CHANGE_IMMEDIATE_REFREEZE=true`) can CAS-refreeze the still-open,
still-unlinked cycle to a NEW plan and record
`member_plan_change_billing_effect(effect = applied_to_open_cycle)`.

Both link steps use `linkInvoiceAndReconcileFrozenPlanInTx`, which — under the
re-acquired lock — links the invoice AND overwrites the cycle's **5**
`frozen_plan_*` columns (plan_id, tier, price, term, currency) back to the snapshot
the §86/4 was actually billed from. When that reconcile heals a real difference
the use-case emits a corrective
`renewal_cycle_price_frozen(reconciled_from_concurrent_plan_change: true)` on the
same cycle, carrying `reverted_plan_id` / `reverted_frozen_price_thb` (the values
the concurrent change-plan had refrozen the cycle to, now undone).

Consequences for anyone reading these audit rows:

- **An `applied_to_open_cycle` billing-effect row may be SUPERSEDED** by a later
  `renewal_cycle_price_frozen(reconciled_from_concurrent_plan_change: true)` on the
  **same `cycle_id`**. When both exist for a cycle, the plan change did NOT take
  effect on that cycle — it deferred to the next cycle. `members.plan_id` still
  reflects the admin's new plan (the change is not lost), but the CURRENT cycle
  bills the pre-change plan.
- **Any consumer that aggregates plan changes per cycle** (e.g. a future
  plan-mix / churn / MRR-by-tier report) **MUST NET** a superseded
  `applied_to_open_cycle` against its corrective `renewal_cycle_price_frozen`
  row — otherwise it double-counts the plan move on the current cycle. The
  corrective row is a DIFFERENT event type, so a naive `count(applied_to_open_cycle)`
  overcounts.
- **The §86/4 and the member charge are ALWAYS correct** regardless of netting:
  the tax document is immutable and the reconcile guarantees
  `cycle.frozen_plan_price_thb == linked membership_fee line unit_price_satang`
  (this detector's invariant). The netting caveat is a REPORTING/analytics concern
  only — never a money one.

**M1 widening:** the corrective audit is gated on "any of the 5 `frozen_plan_*`
fields differ" (`frozenPlanSnapshotsDiffer`, satang-normalized price), NOT price
alone. A same-price cross-plan swap (A@50,000 regular → B@50,000 premium) leaves
this price detector CLEAN but still resets plan_id/tier — the widened gate emits
the corrective row so the supersede is auditable.

**Current consumers (2026-07-23):** no F9/insights dashboard, KPI, or export reads
`member_plan_change_billing_effect` or `applied_to_open_cycle` for aggregation
(grep of `src/modules/insights/**` + repo-wide is emitters/ports/wiring only). The
F9 audit viewer / activity feed display raw rows chronologically, which is CORRECT
for an audit trail (both the superseded row and its correction should show). No
reader overcounts today; this note pre-empts the netting requirement for the first
consumer that aggregates these events.

## When to run it

- **Before** setting `FEATURE_PLAN_CHANGE_IMMEDIATE_REFREEZE=true` in Vercel
  prod — this is the standing pre-flag-flip gate. It must return **CLEAN (0
  divergences, exit 0)**.
- As a **recurring gate** afterwards — it catches any cycle↔invoice price drift
  regardless of the flag's state. This runs automatically as a **native Vercel
  Cron** (`GET /api/internal/cron/plan-change-divergence`, `CRON_SECRET` Bearer,
  daily 03:20 UTC — `vercel.json`). On any divergence the route emits the
  `renewals_plan_change_divergence_detected_total{tenant}` counter with the
  per-tenant count **and returns HTTP 500** so Vercel cron-failure alerting fires
  independently of the metrics pipeline. Expected steady state is CLEAN (0) — the
  confirm-renewal reconcile-at-link guard (Finding #20) heals the immediate-
  refreeze↔self-renew race that used to create these, emitting the paired
  `renewals_plan_change_divergence_reconciled_total{tenant}` counter when it does.

Operator ship-gate run (prod, read-only):

```bash
node --env-file=.env.local.bak.prod --import tsx scripts/check-plan-change-divergence.ts
```

Dev smoke-test:

```bash
pnpm check:plan-divergence
```

> **Dev-branch noise:** the shared `dev` Neon branch accumulates `test-*` tenant
> fixtures from integration tests that seed a linked invoice with **no**
> `membership_fee` line. These surface as `membership_line_anomaly` (`lines=0`)
> on `test-*` tenants and are expected on dev — they do NOT exist on prod (every
> real issued membership invoice carries a line). The gate-relevant signal is
> any finding on a **real** tenant, and any `price_divergence` anywhere.

## Exit codes

- `0` — CLEAN (0 divergences). Gate PASSES.
- `1` — divergence(s) found (gate FAILS) **or** a fatal query error.

## What to do on a hit

1. **Do NOT enable / immediately disable `FEATURE_PLAN_CHANGE_IMMEDIATE_REFREEZE`.**
2. For each `price_divergence` row, note the `cycle_id`, `member_id`,
   `invoice_id`, the printed document number, `frozen` vs `line unit`, and the
   `delta` (satang). Decide the source of truth:
   - If the **issued §86/4 is correct** (the member was billed the right price)
     and the cycle's frozen price is stale, the cycle needs its frozen fields
     re-aligned to the invoice (an admin/maintenance correction — never rewrite
     an issued tax document).
   - If the **cycle's frozen price is correct** and the invoice is wrong, the
     invoice must be handled through the normal void/credit-note flow
     (§86/10 / ป.86/2542) by the treasurer — a §86/4 is never silently edited.
3. For a `membership_line_anomaly` on a **real** tenant, treat it as a
   data-integrity incident: an issued membership invoice with 0 (or >1)
   `membership_fee` lines should be impossible via `createInvoiceDraft`.
   Investigate how the row was written before proceeding with the flag.
4. Re-run until CLEAN before flipping the flag.
