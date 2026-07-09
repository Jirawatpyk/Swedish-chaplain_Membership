# Renewal Rolling-Anchor Refactor — Design

**Date**: 2026-07-08 (rev 2 — post chamber-os-architect review, all Critical/Important findings resolved)
**Status**: Approved design, revised per adversarial review; awaiting maintainer re-confirmation of rev-2 deltas
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

## Decisions (from brainstorm + TSCC + review round 1)

| Question | Decision |
|---|---|
| Scope | R1 (first-payment anchor) + R2 (coverage text) + R3 (payment↔cycle classification at every settlement site) + dispatcher skip-guard + grace-30 config + F-3 scorer filter + New-invoice form context/warning UI. **F-2 credit-note chip excluded** (no TSCC business rule yet). |
| Payment→cycle mechanism | **Shared pure classifier applied at every settlement site** (rev 2 — was "one hook"): the same classification function runs in (1) a new unlinked-invoice hook, (2) `mark-paid-offline`, (3) `markCycleCompleteInTx` (covers confirm-renewal + any linked path), and (4) the New-invoice form preview. One source of truth; no site can drift. Rejected: B (link at invoice creation) and C (manual admin button) — see rev-1 rationale. |
| First-payment marker | New nullable columns on `renewal_cycles`: **`anchored_at timestamptz`** (the discriminator — set by re-anchor AND by the R4 backfill) + **`anchor_invoice_id uuid`** (forensic reference; null for backfilled pre-system payments). `linked_invoice_id` is **never** occupied by the anchoring invoice (rev 2, fixes the `linkInvoice` I1-guard collision — the member's next renewal must be able to link cleanly). |
| Anchor date source | **`paymentDate`** (the admin-entered actual payment date, already an input on record-payment / mark-paid-offline), added to `F4InvoicePaidEvent`; falls back to `paidAt` on rails where they coincide (Stripe webhooks). Anchoring at the server *recording* timestamp would mis-date bank transfers recorded days later (rev 2). **Granularity (rev 3, 2026-07-08 — verified against TSCC's own records in `Membership Database_Since 2025.xlsx`, 19 explicit period pairs): the anchor is the FIRST DAY of the payment month (Bangkok)** — paid 16 Mar 2026 → period 1 Mar 2026 → 1 Mar 2027 (`periodTo` exclusive = TSCC's inclusive "28 Feb 2027"). TSCC operates month-boundary periods throughout; exact-date anchoring would drift days off their books. |
| First bill coverage wording | **"12 months effective from payment date"** (generic) — the anchor doesn't exist when the bill is issued. The §86/4 receipt renders at payment and carries the payment date on its face, so stored line text is never mutated. |
| Renewal-invoice coverage wording | Exact dates (`periodTo → periodTo + term`). The standalone `ปี {planYear}` token is **dropped from the `window` line text** (rev 2) — it contradicted the printed window on a tax document (e.g. "2025" label on 2026–2027 coverage). The plan display name (data) is printed as-is. |
| Frozen-price re-resolution | Re-anchor that crosses a fiscal-year boundary **re-freezes** the plan fields for the new `periodFrom`'s year (same two-step invariant as `createCycleInTx:260-280`) — a 2025-frozen cycle re-anchored into 2026 must not bill 2025 prices at its 2027 renewal (rev 2). **`thai-tax-compliance-auditor` sign-off required** on both wording + re-freeze at review gate. |
| Cycle period semantics | A cycle = one membership period. First payment **re-anchors** the provisional cycle (status returns to `upcoming`). A renewal payment **completes** the open cycle and creates the next one at `prior.periodTo` (gapless — paying within grace backdates automatically per TSCC). |
| Members with no cycle at all | **Self-heal** (rev 2): first membership payment for an active, non-erased member with zero cycle rows creates + anchors the cycle (`createCycleInTx`, `periodFrom` = payment date, then stamp `anchored_at`/`anchor_invoice_id`). Closes the DV-18 members-without-cycle gap at exactly the right moment. Members with only terminal cycles (lapsed/cancelled) stay no-op + loud log — the admin-comeback flow owns them. |
| Double payment | Paying N membership invoices rolls N periods forward (= buying N years). Intended. Crediting a duplicate later does NOT revert (F-2 territory, out of scope). Mitigated by the New-invoice duplicate warning. |
| Dispatcher skip-guard | **In scope** (rev 2 — restored from bug-doc R3): new skip reason `unreconciled_paid_membership_invoice` — skip + loud log when the member has a paid, un-anchored, un-linked membership invoice from the last 12 months. Belt-and-suspenders for the deploy→backfill gap (backfill deliberately runs after testing). `SKIP_REASONS` 13 → 14 (+ count assertion). |
| Grace / lapse | `tenant_renewal_settings.grace_period_days` 14 → **30** — config only (ops step at ship; working assumption from TSCC's public site, flagged for official confirmation). |
| Quota years | Stay **calendar-year** (maintainer confirmed) — F7/F9 untouched. |
| Backfill of existing members | Separate ship-day script, run **after testing**, awaiting TSCC per-member 2025 payment dates. Sets `period_from/to` AND `anchored_at` (so backfilled members never re-classify as first-payment). Not part of this feature's automated migrations. |

## Architecture

### 1. Shared classifier + settlement sites (R1 + R3 core)

**Pure Domain function** `classifyMembershipPayment` (new, `src/modules/renewals/domain/`):

```ts
interface ClassificationInput {
  readonly cycleCountForMember: number;        // ALL cycles ever, incl. terminal
  readonly settledCycleCountForMember: number;  // F2 fix (2026-07-09): cycles
    // EXCLUDING the open cycle with status='completed' OR anchored_at IS
    // NOT NULL — i.e. genuine prior payment history. A predecessor that
    // was cancelled/lapsed WITHOUT ever anchoring does NOT count.
  readonly openCycle: {                        // status upcoming|awaiting_payment, or null
    readonly status: 'upcoming' | 'awaiting_payment';
    readonly anchoredAt: string | null;
  } | null;
  readonly memberErased: boolean;
}
type Classification =
  | { kind: 'first_payment' }   // re-anchor the open cycle
  | { kind: 'renewal' }         // complete open cycle + create next
  | { kind: 'heal_no_cycle' }   // zero cycles ever → create + anchor
  | { kind: 'not_applicable'; reason: 'erased' | 'terminal_only' };
```

Classification table (statuses per `cycle-status.ts` TRANSITIONS; `'reminded'` is a
declared-but-never-written status — no writer exists in `src/`; the classifier
treats it as `upcoming` defensively and the spec records it as vestigial):

| Member state | Classification |
|---|---|
| GDPR-erased | `not_applicable` — never auto-anchor/renew (COMP-1 guard reused) |
| Zero cycle rows ever | `heal_no_cycle` — create cycle at payment date + stamp anchor |
| Open cycle (`upcoming` **or** `awaiting_payment`), `anchored_at IS NULL`, AND zero SETTLED predecessor cycles (`settledCycleCountForMember === 0`) | `first_payment` — re-anchor (rev 2: the post-T-0 `awaiting_payment` provisional cycle is first-payment, NOT renewal. **F2 fix, 2026-07-09**: a predecessor cycle that was cancelled/lapsed WITHOUT ever anchoring — i.e. genuinely never paid — does NOT disqualify this branch, even though `cycleCountForMember > 1` for that member) |
| Open cycle exists, anything else (anchored, or member has a SETTLED predecessor cycle) | `renewal` — complete + next cycle at `periodTo` |
| Only terminal cycles (lapsed/cancelled), none open | `not_applicable` — loud log; admin-comeback flow owns reactivation |

**Consuming sites** (all four consume the same function):

1. **New unlinked-invoice hook** — new F8 use-case `resolveUnlinkedMembershipPayment`
   invoked from the `no_cycle_for_invoice` branch of
   `mark-cycle-complete-from-invoice-paid.ts` (~line 128). Guards first:
   `invoiceSubject === 'membership'`, `memberId !== null`. Same `TenantTx` as the
   payment.
2. **`markCycleCompleteInTx`** (linked path — confirm-renewal + dispatched invoices):
   before completing, classify; a `first_payment` cycle **re-anchors instead of
   completing** (rev 2 — a never-paid member confirming through
   `/portal/renewal/[memberId]` previously settled the wrong-anchor period; the old
   "cannot realistically be reached" rationale was wrong: the page renders for any
   active cycle). On re-anchor via this path, the invoice that confirm-renewal
   parked in `linked_invoice_id` is **moved** to `anchor_invoice_id` and
   `linked_invoice_id` is cleared — the next renewal links cleanly.
3. **`mark-paid-offline`** — same classification on its target cycle. Output/audit
   contract per branch (rev 2):
   - Output union gains a discriminator: `outcome: 'completed' | 'reanchored'`;
     `newExpiresAt` = `periodTo + term` (completed) vs `paymentDate + term`
     (reanchored). Route/UI copy per branch (i18n EN/TH/SV).
   - Audit: `renewal_cycle_completed_offline` (completed branch, unchanged) vs
     `renewal_cycle_reanchored` (re-anchor branch).
   - Its `onPaid` closure runs `createNextCycleOnPaidInTx` afterwards: after a
     re-anchor the cycle is still active, so `findActiveForMemberInTx` skips
     next-cycle creation — this reliance is asserted by a dedicated test.
4. **New-invoice form preview** (§3b) — advisory only; server re-derives at payment.

Cross-cutting notes:

- **Idempotent**: re-fire finds `anchor_invoice_id = this invoice` (first-payment)
  or the cycle `completed` (renewal) → no-op.
- The renewal sub-case where the open cycle is linked to a DIFFERENT (dispatched)
  invoice orphans that invoice — loud log tells staff to void it. Not auto-voided.
- **Callback ordering** (`renewals-deps.ts` f8OnPaidCallbacks): the hook extends
  callback[0]'s no-cycle branch; callback[1] (`applyPendingTierUpgrade`) and
  callback[2] (`createNextCycleOnPaidInTx`) now observe the hook's in-tx writes.
  [2] resolves the same invoice: after `first_payment`/`heal` it finds an ACTIVE
  cycle → `createCycleInTx`'s `findActiveForMemberInTx` guard no-ops; after
  `renewal` the hook already created the next cycle → same guard no-ops. Both
  interplays get unit tests.
- **Degraded-mode refusal** (rev 2): callback[0] has a documented non-tx fallback
  (`onPaidInvalidTx` alarm path, `renewals-deps.ts:509-514`). The hook REFUSES to
  run there (skip + loud log + metric) — a separately-committed re-anchor followed
  by a payment rollback must be impossible. The dispatcher skip-guard +
  reconciliation covers the miss.
- Throw semantics on the tx path: infra throws propagate → payment tx rolls back →
  webhook/admin retry heals (existing chain contract).

### 2. Schema + repo surface

**Migration** (one file): `renewal_cycles` gains
`anchored_at timestamptz NULL` + `anchor_invoice_id uuid NULL` (tenant-composite FK
to `invoices`, ON DELETE SET NULL) + the `renewal_cycle_reanchored` audit enum value.

**New repo methods** (`RenewalCycleRepo`, all in-tx variants; rev 2 — enumerated):

- `countCyclesForMemberInTx(tx, tenantId, memberId): Promise<number>` — ALL
  statuses (the "only cycle ever" test).
- `findOpenCycleForMemberInTx(tx, tenantId, memberId)` — status
  `upcoming | awaiting_payment`, at most one by invariant.
- `reanchorPeriodInTx(tx, tenantId, cycleId, args)` — guarded UPDATE:

```sql
UPDATE renewal_cycles
SET period_from = $1, period_to = $2, status = 'upcoming',
    anchored_at = $3, anchor_invoice_id = $4,
    linked_invoice_id = NULL,
    frozen_plan_price_thb = $5, frozen_plan_term_months = $6   -- re-freeze when FY crossed
WHERE tenant_id = $7 AND cycle_id = $8
  AND status IN ('upcoming','awaiting_payment') AND anchored_at IS NULL
RETURNING *
```

  Zero rows = lost a race → re-read; if the re-read shows a genuinely
  non-first-payment state, fall through to `renewal`; if terminal → no-op + log
  (payment stands). `expires_at` is maintained by the `sync_expires_at` trigger
  (migration 0087). Status reset `awaiting_payment → 'upcoming'` happens inside
  this deliberate, singly-scoped write — it is NOT routed through
  `transitionStatus`/TRANSITIONS (declared here as the one sanctioned bypass, with
  the audit payload carrying old/new status).
- **Reminder idempotency reset** (rev 2): the same use-case deletes
  `renewal_reminder_events` rows for the cycle in the same tx — a step fired
  against the provisional expiry must not suppress that step for the re-anchored
  (later) expiry. Row count goes in the audit payload.

**Bangkok anchor derivation (rev 3 — month-start granularity)**: resolve the
payment's Bangkok calendar date (`paymentDate` verbatim when present; else `paidAt`
+7h), then truncate to the FIRST DAY of that month → `periodFrom` = `YYYY-MM-01`
at UTC midnight; `periodTo` = `addMonthsUtc(periodFrom, termMonths)` (lands on the
1st twelve months later = TSCC's inclusive end-of-month). Verified against 19
explicit period pairs in TSCC's workbook (e.g. paid 2026-03-16 → 2026-03-01 →
2027-02-28 inclusive; late renewal payments backdate to the gapless month start).

**Frozen-field re-resolution**: when `deriveFiscalYear(newPeriodFrom) !==
deriveFiscalYear(oldPeriodFrom)`, re-resolve `loadPlanFrozenFields` (`mode:
'freeze'`, the cycle's `planIdAtCycleStart`) for the new year and write the new
frozen price/term; unresolvable plan (not_found/inactive) → keep old frozen fields
+ loud log + audit flag (payment must not fail on a catalogue gap).

**`F4InvoicePaidEvent`** gains **required** fields `invoiceSubject:
'membership' | 'event'` and `paymentDate: string | null` — required so the compiler
forces BOTH emit sites (`record-payment.ts:1075` and
`issue-event-invoice-as-paid.ts:~758`; rev 2).

### 3. Invoice coverage text (R2)

`createInvoiceDraft` input gains an optional discriminated field:

```ts
membershipCoverage?:
  | { kind: 'window'; fromIso: string; toIso: string }   // renewal — dates known
  | { kind: 'from_payment' }                             // first bill — anchor unknown
```

- **Default for membership lines becomes `{ kind: 'from_payment' }`** — the current
  FY-boundary text (`create-invoice-draft.ts:263-281`) is wrong under rolling policy
  wherever the caller doesn't know better.
- Line text (stored once, forward-only — 088 T036 pattern; old documents untouched):
  - `from_payment` — TH: `ค่าสมาชิก {แผน} (12 เดือน เริ่มตั้งแต่เดือนที่ชำระค่าธรรมเนียม)`
    EN: `Membership {plan} (12 months, effective from the month of payment)` —
    rev 3: month-of-payment wording matches the month-start anchor.
  - `window` — TH: `ค่าสมาชิก {แผน} (ระยะเวลา {from} ถึง {to})`
    EN: `Membership {plan} (coverage {from} to {to})`
  - Rev 2: **no standalone `ปี {planYear}` token in either kind** — it contradicted
    rolling windows on a tax document. The plan display name (which may itself
    contain a year, e.g. "Regular Corporate 2026") prints as data.
- Callers: F8 bridges classify the payment (shared `classifyMembershipPayment`)
  before calling the F4 bridge and pass `window` = `cycle.periodTo →
  addMonthsUtc(periodTo, term)` ONLY for a `renewal`-classified cycle; a
  `first_payment`-classified cycle omits the field entirely (falls back to
  `from_payment` — the re-anchored period isn't known until the member actually
  pays). `confirm-renewal.ts` gates this way (final-review fix, 2026-07-09) —
  matches `mark-paid-offline.ts`'s pre-existing gate. The admin New-invoice surface
  resolves the member's open cycle via the F8 barrel (presentation orchestrates two
  modules' barrels — Principle III holds; F4 never imports F8) and passes `window`
  for renewal-classified members, nothing otherwise.
- `fiscalYearBoundaryForYear` remains for pro-rate math (policy `none` for TSCC) —
  untouched.
- The §86/4 receipt renders stored line text + its own payment-date field: a
  `from_payment` line is self-completing on the receipt. No post-issue mutation.

### 3b. New-invoice form: renewal context + duplicate warning (UI)

The admin New-invoice form (membership path, `POST /api/invoices`) already gains an
open-cycle read for R2's coverage text. Surface what it finds — closes the
"implicit magic" weakness:

- **Renewal-context line** (informational, always shown for membership invoices),
  derived from the SAME `classifyMembershipPayment` function:
  - `renewal`: "รอบปัจจุบันถึง {periodTo} — จ่ายบิลนี้ = ต่ออายุ (รอบใหม่ {periodTo} ถึง {periodTo+term})"
  - `first_payment` / `heal_no_cycle`: "ยังไม่เริ่มรอบสมาชิกภาพ — จ่ายบิลนี้ = เริ่มนับ 12 เดือนจากวันชำระ"
  - `not_applicable`: "ไม่มีรอบสมาชิกที่ดำเนินอยู่ — บิลนี้จะไม่กระทบระบบต่ออายุ (ใช้ flow reactivate สำหรับสมาชิกที่พ้นสภาพ)"
- **Duplicate-billing warning** (non-blocking, amber): member already has an issued
  unpaid membership invoice, OR current period end is >6 months away (another bill
  = buying a further year — legitimate, so warn, never block).
- i18n EN/TH/SV from day one; WCAG per `docs/ux-standards.md` (never colour-alone).
- Server remains authoritative — the hook re-derives at payment time.

### 4. Dispatcher skip-guard + config + scorer fix

- **Skip-guard** (rev 2, restored): `dispatch-one-cycle.ts` gains skip reason
  `unreconciled_paid_membership_invoice` — before dispatching a reminder, skip +
  loud log when the member has a paid membership invoice from the last 12 months
  that is neither linked to any cycle nor recorded as any cycle's
  `anchor_invoice_id`. Covers the deploy→backfill gap and any future hook miss.
  `SKIP_REASONS` 13 → 14 + count-assertion update + audit emit per existing
  taxonomy.
- **Grace 30**: ship-day ops step (runbook entry):
  `UPDATE tenant_renewal_settings SET grace_period_days = 30 WHERE tenant_id = 'swecham';`
  (domain validates 0–90; no code). TSCC's "30 days after invoice/reminder" vs
  F8's "30 days after period end" wording nuance stays flagged for official
  confirmation.
- **F-3**: both at-risk scorers filter the last-payment lateral —
  `WHERE status IN ('paid','partially_credited')`
  (`drizzle-member-renewal-flags-repo.ts:574` batch; `drizzle-at-risk-scorer.ts:~152`
  single-member).

### 5. Audit & observability

- New audit event `renewal_cycle_reanchored` (5-year retention), payload
  `{cycle_id, member_id, invoice_id | null, old_period_from | null, old_period_to | null,
  new_period_from, new_period_to, old_status, refroze_plan_fields: boolean,
  reminder_events_reset: number}` — nullable old_* covers the `heal_no_cycle`
  branch (no prior period). Emitted in the SAME tx as the write (Principle VIII).
- 4 canonical touch-points (domain const, pgEnum migration, 2 parity-test counts)
  + `REQUIRED_ENUM_VALUES` guard entry (`scripts/lib/enum-migration-guard.ts`).
- Loud logs: orphaned-dispatched-invoice sub-case; terminal-only no-op;
  degraded-mode refusal; frozen-field re-resolution failure.
- Metrics: hook outcome counter (`reanchored | renewed | healed | held | skipped`).

## Security & compliance

- All reads/writes inside the caller-provided `TenantTx` (never the global `db`) —
  Principle I two-layer isolation; integration suite includes a cross-tenant probe
  (Review-Gate blocker).
- Audit emitted in the SAME tx as state changes (Principle VIII).
- GDPR-erased members classify `not_applicable` (COMP-1 guard reused).
- Tax documents never mutated after issue; §86/4 wording + re-freeze rule require
  **`thai-tax-compliance-auditor` sign-off** at the review gate.
- Renewal state + invoices = finance-adjacent: ≥2-reviewer gate (solo-maintainer
  substitute per Constitution v1.4.2 where applicable).

## Error handling

- Hook infra throw (tx path) → payment tx rolls back → invoice stays `issued` →
  retry heals. Never swallow after commit.
- Re-anchor race (0 rows) → re-read → renewal fall-through only when genuinely
  ineligible; terminal → no-op + log.
- Degraded (non-tx) callback mode → hook refuses (skip + loud log + metric);
  skip-guard catches the member later.
- Unknown future `invoiceSubject` value → skip hook + loud log (fail open; never
  block a payment).
- Plan unresolvable during re-freeze → keep old frozen fields + loud log + audit
  flag (payment never fails on catalogue gaps).

## Testing (TDD)

1. **Unit** — `classifyMembershipPayment` full table (erased / heal / first-payment
   incl. post-T-0 `awaiting_payment` / renewal / terminal-only / vestigial
   `reminded`); Bangkok anchor-date math (23:30 UTC = next Bangkok day;
   paymentDate-vs-paidAt precedence); coverage-text builder (both kinds, TH+EN, no
   planYear token); F-3 filter; callback [1]/[2] interplay after each
   classification outcome; degraded-mode refusal.
2. **Contract** — `createInvoiceDraft` accepts `membershipCoverage`;
   `F4InvoicePaidEvent` requires `invoiceSubject` + `paymentDate` (both emit
   sites); `mark-paid-offline` output union.
3. **Integration (live Neon dev branch)** —
   pay unlinked first invoice → re-anchored to paymentDate + `anchored_at` stamped
   + audit row; pay second → completed + next at `periodTo`;
   **confirm-renewal AFTER a re-anchor → links + completes cleanly (the C1
   regression — must start from a re-anchored cycle)**;
   first payment on a post-T-0 `awaiting_payment` provisional cycle → re-anchors
   (not completes) + reminder-event rows reset;
   zero-cycle member payment → healed cycle at payment date;
   `mark-paid-offline` on a first-payment cycle → `outcome:'reanchored'` + correct
   audit event + no next cycle created;
   FY-crossing re-anchor → frozen fields re-resolved;
   dispatcher skip-guard fires for an unreconciled paid invoice;
   webhook re-fire → no-op; cross-tenant probe; dispatch path regression.
4. **E2E** — admin: create member → New invoice (form shows first-payment context
   line) → record payment (with a backdated paymentDate) → member-detail Renewal
   card + portal dashboard show the period anchored at the payment date; second
   invoice for the same member shows the duplicate warning.
5. Audit-event parity tests (4 touch-points) + enum-guard fixture + SKIP_REASONS
   count assertion.

## F-2 — credit-note membership effect (ADDED to scope 2026-07-08, rev 3.1)

TSCC has no established mid-term-refund practice (verified: Cancelled-2026 sheet =
non-renewals only), so the per-case intent of the issuing staff member IS the
business rule. Standard ERP pattern — capture at issue time:

- Full credit on a membership invoice → the credit-note form REQUIRES a choice:
  `keep` (correction/duplicate — membership unaffected, default) vs
  `cancel_membership` (refund + withdrawal — the route cancels the member's
  in-flight cycles via the existing F8 `cancelInFlightCyclesForMember` after the
  credit commits).
- Partial credits and event invoices never ask (no membership effect possible).
- Sequencing: credit note commits first (§86/10 numbering never depends on F8);
  cancellation failure → success-with-warning + loud log; staff retry via the
  renewals UI (idempotent). F4 never imports F8 — the route orchestrates barrels.
- No new audit enum values: the F8 cancel path emits its existing events, with
  `correlationId = 'credit-note:{creditNoteId}'` for the forensic chain.

## Out of scope (explicitly)

- Reminder suppression for members who never paid their first invoice (beyond what
  re-anchor + skip-guard already give).
- Backfill script execution (ship-day task; blocked on TSCC per-member payment
  dates; run after testing per maintainer; sets `anchored_at`).
- Auto-voiding orphaned F8-dispatched invoices.
- Custom pricing / discounts / a third "service" invoice subject (WHT 3%
  implications — separate feature with accountant + thai-tax review).
- Any F7/F9 quota-year change (stays calendar-year).
