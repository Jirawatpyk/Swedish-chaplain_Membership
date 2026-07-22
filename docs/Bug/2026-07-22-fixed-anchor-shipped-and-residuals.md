# Fixed-anchor membership period — SHIPPED + residual decisions (2026-07-22)

**Status**: SHIPPED to `main` via **PR #246** (squash `6064c850a`, merged 2026-07-22).
**Supersedes**: the payment-anchor model of PR #173 / #205 and the
`2026-07-08-renewal-rolling-anchor-design.md` spec (see the reversal note below).
**Basis**: maintainer decision 2026-07-22 (authoritative), first argued in
`2026-07-08-renewal-paid-invoice-disconnect.md` § Q-2.

## What changed

A membership renewal cycle's 12-month period is now **FIXED at the member's
registration/enrolment anchor**. Paying the first invoice no longer moves the
period to the payment month — it only **activates** the cycle (status →
`upcoming`, stamps `anchored_at`, clears the parked invoice). Benefit access is
gated by the 059 suspension model (`deriveMembershipAccess` reads status +
`period_to`, never `period_from`). One exception: the **comeback** — if the
fixed period has already fully elapsed at the *actual payment date*, the cycle
re-anchors to the payment month (else the payer would be paid-but-suspended).
`heal_no_cycle` still anchors at the payment date (no prior anchor to preserve).

The reverse (payment-anchor) drifted every member's anniversary to their
payment date and made the §86/4 coverage window mis-state the covered period.

## Residual decisions (the four go-live follow-ups)

### 1. Prod data remediation — NO ACTION NEEDED ✅

Read-only prod diagnostic (2026-07-22, `audit_log` + `renewal_cycles`):

- **`backfill-cycle-anchors` NEVER ran on prod** (0 rows with
  `request_id LIKE 'backfill-anchors:%'`). The CSV-import remediation concern is
  moot — it was never executed.
- Only **4** `renewal_cycle_reanchored` events ever fired, **all** from real
  first payments (`f4-paid:`); **3** moved the period under the old
  payment-anchor code (before this fix): two trivial same-month day-shifts
  (`2026-07-17→2026-07-01`, `2026-07-15→2026-07-01`) and one larger drift
  (`2025-09-30→2026-07-01`).

**Decision: grandfather the 3 drifted cycles.** They are already-anchored,
already-billed rows; retroactively restoring their registration anchor would
claw back coverage the members were granted and shift their anniversaries —
worse than leaving them. This mirrors the "20 anchored open cycles = BY DESIGN"
precedent (`project_renewal_anchored_cycle_prod_open_items`). Fixed-anchor
applies **going forward** to new first payments.

### 2. Audit event name `renewal_cycle_reanchored` — KEEP (do not rename) ✅

The event now fires on first-payment *activation* (period usually KEPT) as well
as the comeback / backfill (period MOVED), so the name is slightly imprecise.
**Decision: keep it.** Renaming a shipped **money** audit enum value is high-risk
for cosmetic benefit — it touches ~16 code/test sites, needs an
`ALTER TYPE … RENAME VALUE` migration on live prod rows, and can break audit
export / dashboard parsers (see the audit-enum-drift history). The payload
already discriminates the two cases: `old_period_from`/`new_period_from` are
equal on an in-place activation and differ on a period move, and
`refroze_plan_fields` is present. A future rename, if ever wanted, is a
dedicated PR — not a fold-in.

### 3. Supersede the payment-anchor docs — DONE ✅

Supersession banners added to
`2026-07-08-renewal-rolling-anchor-design.md`,
`2026-07-16-renewal-swecham-round2-design.md`, and the § Q-2 of
`2026-07-08-renewal-paid-invoice-disconnect.md` (marked IMPLEMENTED), all
pointing here.

### 4. M-1 §86/4 window bounded residual — ACCEPTED (documented) ✅

The invoice's §86/4 coverage line is baked at issue time and the receipt reuses
it verbatim (never re-derived — `invoice-template.tsx` renders the stored
`descriptionEn/Th`). The route now prints the concrete window only when the
period extends beyond the *next* Bangkok month, so a normal-timing payment
cannot cross `period_to` and comeback. **Residual**: a payment **2+ months
late** on a period ending *exactly* two months out can still comeback, leaving
the printed window one period behind the granted one.

**Decision: accept.** The scenario is rare (a first-payment member billed near
their period end who then pays 2+ months late). Fully eliminating it requires
re-deriving the §86/4 window at **receipt-generation time** from the settled
cycle (post-comeback) instead of reusing the stored invoice line — a
cross-module change to the receipt path that is not justified for this edge on a
freshly-shipped surface. Revisit only if a real member hits it.

## Verification of the shipped work

typecheck · lint · check:i18n (4842 keys) · 19 unit+contract · **40 live-Neon
integration** (rolling-anchor-payment, mark-paid-offline, reanchor-period,
admin-renew-lapsed-member, confirm-with-plan-change, offline-frozen-price,
membership-line-period). Two rounds of AI adversarial review (whole-branch, then
financial-integrity on the delta) satisfied the money-surface 2-reviewer bar
under the solo-maintainer substitute; findings **B-1** (mid-month paid-but-
suspended), **H-1** (comeback reminder-collision lapse), **M-1** (§86/4 drift)
were all fixed before merge.
