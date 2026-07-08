# Renewal Rolling-Anchor Refactor — Design

**Date**: 2026-07-08
**Status**: Approved (brainstorm with maintainer, Thai session)
**Provenance**: QA finding triage + TSCC policy answers in
`docs/Bug/2026-07-08-renewal-paid-invoice-disconnect.md` (findings F-1/F-3, decisions R1–R7).
**Owner modules**: `src/modules/renewals` (F8) + `src/modules/invoicing` (F4, coverage text + event shape)

## Purpose

Align the platform with TSCC's confirmed membership policy:

> Membership runs **12 months rolling from the date the member is approved AND the
> first fee payment completes**. Renewals continue **gapless from the period end**
> (paid June 2025 → Jun 2025–May 2026 → renewal Jun 2026–May 2027), regardless of the
> renewal payment date. **No pro-rating.** Lapse after ~30 days overdue.

Today three things disagree with that policy:

1. **F8 anchors the first cycle at `registration_date`**, not the first-payment date
   (SCCM-0004 prod evidence: reg 2025-12-11 = cycle period, while the paid invoice
   says coverage 2026).
2. **F4 membership invoices print calendar-year coverage** ("2026-01-01 to
   2026-12-31" — the FY boundary of `planYear`), which contradicts rolling periods.
3. **A paid membership invoice that F8 didn't create is silently ignored**
   (bug F-1): `markCycleCompleteInTx` resolves cycles only via `linked_invoice_id`,
   so admin-created (ad-hoc) invoices never anchor or renew anything — and the
   September t-90 reminders would fire at already-paid members.

## Decisions (from brainstorm + TSCC)

| Question | Decision |
|---|---|
| Scope | R1 (first-payment anchor) + R2 (coverage text) + R3 (payment↔cycle hook) + grace-30 config + F-3 scorer filter. **F-2 credit-note chip excluded** (no TSCC business rule yet). |
| Payment→cycle mechanism | **Approach A: one on-paid hook** in the existing F4 payment callback chain — covers every payment path (admin record-payment, Stripe card, PromptPay, F8 offline) with zero staff action; runs in the same tx as the payment. Rejected: B (link at invoice creation — still needs a payment-time hook for the anchor, plus draft-deletion/void link cleanup) and C (manual admin button — the bug exists because humans didn't know the extra step). |
| First bill coverage wording | **"12 months effective from payment date"** (generic) — the anchor doesn't exist when the bill is issued. The §86/4 receipt renders at payment and carries the payment date on its face, so the stored line text is never mutated (tax documents stay immutable). |
| Renewal-invoice coverage wording | Exact dates (`periodTo → periodTo + term`) — known at creation. |
| Cycle period semantics | A cycle = one membership period. First payment **re-anchors** the onboarding cycle (status stays `upcoming`). A renewal payment **completes** the open cycle and creates the next one at `prior.periodTo` (existing `createNextCycleOnPaid` — gapless, so paying within grace backdates automatically per TSCC). |
| Double payment | Paying N membership invoices rolls N periods forward (= buying N years). Intended. Crediting a duplicate later does NOT revert (F-2 territory, out of scope). |
| Grace / lapse | `tenant_renewal_settings.grace_period_days` 14 → **30** — config only (ops step at ship; working assumption from TSCC's public site, flagged for official confirmation). |
| Quota years | Stay **calendar-year** (maintainer confirmed) — F7/F9 untouched. |
| Backfill of existing members | Separate ship-day script, run **after testing**, awaiting TSCC per-member 2025 payment dates. Not part of this feature's automated migrations. |

## Architecture

### 1. On-paid resolution hook (R1 + R3 core)

`F4InvoicePaidEvent` gains one additive field: `invoiceSubject: 'membership' | 'event'`
(F4 knows it at emit; all existing consumers unaffected).

New F8 use-case `resolveUnlinkedMembershipPayment` runs inside the existing F8
on-paid callback chain, **only in the branch where `findByInvoiceIdInTx` returns
null** (today's silent `no_cycle_for_invoice` no-op in
`mark-cycle-complete-from-invoice-paid.ts:128`). Same `TenantTx` as the payment —
atomic with the invoice flip. Guards first: `invoiceSubject === 'membership'`,
`memberId !== null`, member not GDPR-erased (existing
`readReactivationGuardsInTx`).

Resolution table (load member's open cycle — status `upcoming | awaiting_payment`;
at most one exists by invariant):

| Member state | Classification | Action |
|---|---|---|
| No open cycle | Not renewal-manageable | No-op + **loud log** (lapsed members go through the existing admin-comeback flow) |
| Exactly one cycle total, status `upcoming`, `linked_invoice_id IS NULL` | **First payment** | `reanchorPeriodInTx`: `periodFrom` = Bangkok calendar date of `paidAt`, `periodTo` = `periodFrom + frozenPlanTermMonths` (existing `addMonthsUtc`), link this invoice, status stays `upcoming`. Audit `renewal_cycle_reanchored`. |
| Anything else (cycle linked to a different invoice, or member has predecessor cycles) | **Renewal** | Transition `upcoming\|awaiting_payment → completed` (`closedReason: 'paid'`, link this invoice — same PAYABLE_STATUSES set as `mark-paid-offline`) + `createNextCycleOnPaidInTx`-equivalent next cycle anchored at `periodTo`. Audit `renewal_completed` (existing event). |

Notes:
- **Idempotent**: a webhook re-fire finds the cycle already linked to this invoice
  (first-payment case) or already `completed` (renewal case) → no-op.
- The "cycle linked to a DIFFERENT invoice" renewal sub-case orphans the
  F8-dispatched invoice (member paid an ad-hoc one instead) — loud log tells staff
  to void the orphan. Not auto-voided (tax-document mutation needs a human).
- Existing F8 flows (dispatch, confirm-renewal, mark-paid-offline) always link
  before payment, so they never enter this hook. Behavior change on those paths is
  limited to the one case below.
- **`mark-paid-offline` applies the same classification**: when its target cycle
  qualifies as FIRST PAYMENT (member's only cycle, `upcoming`, unlinked), it
  re-anchors + links instead of completing — otherwise staff recording a new
  member's first offline payment through that tool would settle a
  wrong-anchor (registration-date) period. Renewal-classified cycles keep the
  existing complete + next-cycle behavior. (`confirm-renewal` is reminder-driven
  and cannot realistically be reached by a never-paid member ~9 months before
  their provisional expiry; accepted as-is and noted in tests as out of scope.)
- Throw semantics match the existing chain: infra throws propagate → the payment tx
  rolls back → Stripe at-least-once retry heals (same contract as
  `createNextCycleOnPaidInTx`).

### 2. Repo addition: `reanchorPeriodInTx`

New `RenewalCycleRepo` method — guarded UPDATE:

```sql
UPDATE renewal_cycles
SET period_from = $1, period_to = $2, linked_invoice_id = $3
WHERE tenant_id = $4 AND cycle_id = $5
  AND status = 'upcoming' AND linked_invoice_id IS NULL
RETURNING *
```

Zero rows = lost a race (concurrent payment/admin transition) → re-read and fall
through to the renewal classification. `expires_at` is maintained by the existing
`sync_expires_at` trigger (migration 0087) — the UPDATE never touches it directly.
Bangkok date derivation: `paidAt` (ISO UTC) → Asia/Bangkok calendar date → UTC
midnight timestamp, consistent with how `registration_date` anchors today (UTC+7,
no DST — plain offset arithmetic, no js-joda needed; helper colocated with
`addMonthsUtc` usage).

### 3. Invoice coverage text (R2)

`createInvoiceDraft` input gains an optional discriminated field:

```ts
membershipCoverage?:
  | { kind: 'window'; fromIso: string; toIso: string }   // renewal — dates known
  | { kind: 'from_payment' }                             // first bill — anchor unknown
```

- **Default for membership lines becomes `{ kind: 'from_payment' }`** — the current
  FY-boundary text (`create-invoice-draft.ts:263-281`) is wrong under rolling policy
  in every case where the caller doesn't know better.
- Line text (stored once, forward-only — existing 088 T036 pattern; old documents
  untouched):
  - `from_payment` — TH: `ค่าสมาชิก {แผน}ปี {planYear} (12 เดือน เริ่มตั้งแต่วันชำระค่าธรรมเนียม)`
    EN: `Membership {plan}{planYear} (12 months, effective from payment date)`
  - `window` — TH: `ค่าสมาชิก {แผน}ปี {planYear} (ระยะเวลา {from} ถึง {to})`
    EN: `Membership {plan}{planYear} (coverage {from} to {to})` — same format as
    today, real dates instead of FY boundary.
- Callers:
  - F8 bridges (`f4-invoice-bridge.ts` offline path, the confirm-renewal invoicing
    bridge) pass `window` = `cycle.periodTo → addMonthsUtc(periodTo, term)`.
  - The admin ad-hoc invoice creation surface (presentation layer) MAY resolve the
    member's open cycle via the F8 barrel read and pass `window` when the member is
    a renewal candidate; otherwise it passes nothing and gets `from_payment`.
    Presentation orchestrating two modules' public barrels is the established
    pattern (Principle III respected — F4 never imports F8).
- `fiscalYearBoundaryForYear` remains in use for pro-rate math (policy stays
  `none` for TSCC — dead in practice) — untouched.
- The §86/4 receipt renders the stored line text + its own payment date field:
  a `from_payment` line is self-completing on the receipt. No post-issue mutation.

### 4. Config + scorer fix

- **Grace 30**: ship-day ops step (runbook entry):
  `UPDATE tenant_renewal_settings SET grace_period_days = 30 WHERE tenant_id = 'swecham';`
  (domain validates 0–90; no code change). Flagged: TSCC's "30 days after
  invoice/reminder" wording vs F8's "30 days after period end" — near-equivalent
  since final notices land at expiry; official confirmation still pending.
- **F-3**: both at-risk scorers add an invoice-status filter to the last-payment
  lateral — `MAX(paid_at) FILTER`/`WHERE status IN ('paid','partially_credited')`
  (a fully-credited or void invoice is not a live payment):
  `drizzle-member-renewal-flags-repo.ts:574` (batch) + the single-member scorer
  (`drizzle-at-risk-scorer.ts`).

### 5. Audit & observability

- New audit event type `renewal_cycle_reanchored` (5-year retention), payload
  `{cycle_id, member_id, invoice_id, old_period_from, old_period_to, new_period_from, new_period_to}`.
  Costs the canonical 4 touch-points (domain const, pgEnum migration, 2 parity-test
  counts) + `REQUIRED_ENUM_VALUES` guard entry (`scripts/lib/enum-migration-guard.ts`)
  since code writes it immediately.
- Loud logs: orphaned-dispatched-invoice sub-case; no-open-cycle no-op.
- Metrics: counter for hook outcomes (`reanchored | renewed | skipped_no_cycle`).

## Security & compliance

- All reads/writes inside the caller-provided `TenantTx` (never the global `db`) —
  Constitution Principle I two-layer isolation; integration suite includes a
  cross-tenant probe (Review-Gate blocker).
- Audit emitted in the SAME tx as the state change (Principle VIII).
- GDPR-erased members never auto-anchor/renew (existing guard reused — mirrors
  `markCycleCompleteInTx` COMP-1 behaviour).
- Tax documents are never mutated after issue; wording decision above exists
  precisely to avoid it.
- Touches renewal state + invoices (finance-adjacent): **≥2-reviewer gate** applies
  at review time (solo-maintainer substitute per Constitution v1.4.2 if applicable).

## Error handling

- Hook infra throw → payment tx rolls back → invoice stays `issued` → webhook/admin
  retry heals (existing chain contract; never swallow after commit).
- Re-anchor race (0 rows) → re-read cycle, fall through to renewal classification;
  if the cycle is now terminal → no-op + log (payment stands).
- Unknown/malformed `invoiceSubject` (future value) → skip hook + loud log (fail
  open to the current no-op, never block a payment).

## Testing (TDD)

1. **Unit** — resolution table (all 3 classifications + idempotent re-fire + erased
   guard + event-invoice skip); Bangkok anchor-date math (UTC+7 boundary crossing:
   paid 23:30 UTC = next Bangkok day); coverage-text builder (both kinds, TH+EN);
   F-3 filter derivation.
2. **Contract** — `createInvoiceDraft` accepts `membershipCoverage` (both kinds +
   default); `F4InvoicePaidEvent` carries `invoiceSubject`.
3. **Integration (live Neon dev branch)** — pay an unlinked first invoice →
   cycle re-anchored to payment date + linked + `renewal_cycle_reanchored` audit
   row; pay a second unlinked invoice → cycle completed + next cycle at `periodTo`;
   webhook-style re-fire → no-op; cross-tenant probe; `mark-paid-offline` on a
   first-payment cycle → re-anchors (not completes); F8 dispatch/confirm renewal
   paths unchanged (regression).
4. **E2E** — admin: create member → create ad-hoc membership invoice → record
   payment → member-detail Renewal card shows the period anchored at the payment
   date; portal dashboard Membership stat agrees.
5. Audit-event parity tests updated (4 touch-points) + enum-guard fixture update.

## Out of scope (explicitly)

- F-2 credit-note → membership reversal (no TSCC business rule yet; warning chip is
  a later feature).
- Reminder suppression for members who never paid their first invoice (t-90 sits
  ~9 months out for a new member; first-payment chasing stays manual).
- Backfill script execution (separate ship-day task; blocked on TSCC per-member
  payment dates; run after testing per maintainer).
- Auto-voiding orphaned F8-dispatched invoices.
- Multi-year contract changes (`frozenPlanTermMonths` flows through re-anchor
  unchanged).
- Any F7/F9 quota-year change (stays calendar-year).
