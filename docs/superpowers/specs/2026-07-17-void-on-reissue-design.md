# void-on-reissue @ F4 mint point — Design

> **Date:** 2026-07-17 · **Branch:** `106-void-on-reissue` · **Sub-project #1** of the deferred renewal-invoicing workstream (066 §8 rows L175/L176).
> **Supersedes:** the 066 design's manual "void the old bill" runbook step (§4.4(4), §4.5) and the L175/L176 deferrals.
> **Unblocks:** Sub-project #2 (auto-invoice, 066 §8 L180) — this is its stated HARD-dependency.

---

## 1. Goal

When a **new membership bill is issued for a member** through the renewal path, **automatically void that member's prior outstanding (unpaid, `issued`) membership bill(s)** — in one place — so a member never carries two open bills for overlapping coverage. This kills the duplicate-§86/4 risk and retires the manual "void the old bill" runbook step.

One sentence: *reissue supersedes — the old unpaid bill dies when the new one is born, enforced at F4's `issueInvoice` so every membership-bill mint path (renewal bridge, auto-draft issue, manual) inherits it.*

---

## 2. Motivation / current state (verified in code)

- **Reactivation leaves a dangling bill.** `admin-renew-lapsed-member.ts` creates a **fresh** `awaiting_payment` cycle and issues a **new** invoice via the bridge (`:468`), but **never touches the member's old unpaid bill** from the lapsed cycle. After reactivation the member is no longer terminated, so the old bill becomes payable again → **two open bills for one membership → duplicate §86/4 risk.**
- **Today's mitigation is manual + forgettable.** 066 §4.4(4)/§4.5 tell the admin to "void the old open bill" via the F4 admin UI (`/admin/invoices/[invoiceId]` → void). A missed step is a tax-hygiene incident.
- **`voidInvoice` already does the hard part** (`src/modules/invoicing/application/use-cases/void-invoice.ts`): accepts `issued`; void is terminal, keeps the §87 number (no-gap), re-stamps the PDF with the VOID/ยกเลิก overlay, emits `invoice_voided`. Crucially — **voiding an `issued` (pre-receipt) bill needs NO §86/10 credit note** (no §86/4 exists yet), so it is fully tax-clean.
- **No "reissue/supersedes" concept exists** on the invoice aggregate (no `replaces`/`replaced_by`/`supersedes` column). This design adds the *behaviour* at the F4 issue layer, not a new invoice column.
- **The true universal mint point is F4 `issueInvoice`.** Today's renewal issuance flows through `F4InvoicingForRenewalBridge.issueInvoiceForRenewal` (adapter `src/modules/renewals/infrastructure/ports-adapters/f4-invoicing-for-renewal-bridge-drizzle.ts`, composing `createInvoiceDraft → issueInvoice`) — callers `admin-renew-lapsed-member.ts:468` (reactivate) + `confirm-renewal.ts:523-538` (member self-service). **But that bridge wrapper is NOT the only membership-bill mint path**: Sub-project #2 (auto-invoice, A3) issues a pre-existing draft through a *different* entry point that never touches the create-and-issue wrapper. The one point every membership bill passes through is F4 `issueInvoice` itself — so that is where this design places the supersede (revised from an earlier bridge-wrapper placement after the #2 design review showed the wrapper would miss #2's issue path).

---

## 3. Scope + non-goals

### In scope
- Enforce, at the **F4 membership-bill issue layer**, that issuing a membership bill voids the member's other outstanding `issued` membership bills — so every mint path inherits it (the renewals bridge → reactivate + member-confirm, Sub-project #2's auto-draft issue, and any manual membership-bill issue).
- Add a `voidInvoice` options object: `requireStatus?: 'issued'` (the tax-safety guard) + `suppressCancellationEmail?: boolean` (default `false` — manual voids via the UI keep sending the cancellation email exactly as today).
- An F4 read capability: "list the member's outstanding `issued` membership bills."
- Retire the manual void step in the 066 admin copy/runbook (§4.4(4), §4.5).

### Non-goals (explicit)
- **Never auto-void a `paid` / `partially_credited` / `credited` bill.** Reversing a minted §86/4 is a §86/10 credit note — a human decision, out of scope forever for this automated path.
- **No new invoice column** (no `supersedes` FK). Supersession is expressed by the audit trail (`invoice_voided.supersededByInvoiceId`), not schema.
- **No change to the F8 cycle state machine, and no touching the old (terminal) cycle.** The old cycle's `linked_invoice_id` keeps pointing at the now-void invoice — correct for forensics.
- **No auto-invoice** (that is Sub-project #2). This design only makes reissue safe; it does not originate bills.
- **No new audit event enum value.** Reuse `invoice_voided` (avoids the 4-place enum lockstep) with a distinguishing reason + payload.

---

## 4. Design

### 4.1 Trigger (F4 mint point)
The supersede runs **inside the F4 invoice-issue layer** (`issueInvoice`, or a thin F4 composition over `issueInvoice` + `voidInvoice` — exact shape at plan time), **scoped to `invoice_subject = 'membership'`**, right after the new bill is issued. Placing it at the **F4 mint point** — not the renewals bridge — means *every* path that mints a membership bill inherits it: the renewals bridge (`issueInvoiceForRenewal` → admin reactivate + member confirm), **and** Sub-project #2's auto-draft issue path (`issueAutoDraftedRenewal`, a different entry point that does **not** go through the bridge wrapper), **and** any manual membership-bill issue. This is the correct altitude — it is an F4 invoice-integrity invariant (*"a member holds at most one open membership bill"*), not a renewals concern — and it is the load-bearing dependency that makes Sub-project #2 safe. An event or manual (non-membership) invoice is untouched (the subject filter).

### 4.2 Which bills get voided (matching rule)
Query F4 for the member's **outstanding** membership bills and void each:

> `WHERE tenant_id = <tenant> AND member_id = <memberId> AND invoice_subject = 'membership' AND status = 'issued' AND id <> <newlyIssuedInvoiceId>`

- `status = 'issued'` is the only outstanding-unpaid, pre-receipt state (invoice statuses are `draft | issued | paid | void | credited | partially_credited`; there is no `partially_paid`, and `void` is the literal cancel state). This filter structurally excludes every state that has a §86/4 receipt.
- Excluding the just-issued invoice id guards against voiding the fresh bill.
- **Assumption (SweCham):** a member holds at most one open membership bill at a time (annual membership, one active cycle, lapse is terminal) — so this normally matches exactly 0 or 1 bill. See §9 for the multi-membership limitation.

### 4.3 Void mechanic (ordering, suppress email, reason)
1. **Issue-first, then void.** The new bill is issued (and its PDF rendered) *before* any void runs. If the void step fails, the member still ends with a valid payable bill — the worst case is exactly today's state (an extra dangling bill an admin can void manually).
2. For each matched prior bill, call the existing `voidInvoice` with an automated-path options object:
   - `requireStatus: 'issued'` — **the tax-safety guard.** `voidInvoice` normally accepts *both* `issued` and `paid` (voiding a paid §86/4 is its documented edge path). Under its own row lock it must re-assert `status === 'issued'` and return `invalid_status` (→ skipped) if the bill is anything else. This closes the **`issued → paid` TOCTOU**: if the member pays between the §4.2 SELECT and the void lock, the now-`paid` bill is preserved, never VOID-stamped over a minted §86/4. **The automated path can never void a paid bill** — the `status='issued'` query filter is defence-in-depth, this lock-time guard is the actual barrier.
   - `suppressCancellationEmail: true` — no "your invoice was cancelled" email on an automated supersede (0-email policy).
   - `voidReason` (canonical, human + machine readable): `"auto-void: superseded by renewal reissue <newInvoiceId>"`.
3. Each `voidInvoice` runs in its **own F4 transaction** (F4 use-cases are single-tx; the bridge already composes create/issue as separate txns). No cross-module atomic transaction is attempted or needed.

### 4.4 Failure handling + degradation
- The whole void step is **best-effort and non-fatal to the renewal.** `issueInvoiceForRenewal` returns success as soon as the new bill is issued; void failures are collected and surfaced as a **non-blocking warning** on the bridge result, plus a log line, plus (see §4.5) an audit trail.
- Failure modes and handling:
  - *find-query error* → skip voiding, warn, log. Renewal still succeeds.
  - *`voidInvoice` returns `invalid_status`* (the bill was already `void`, or raced to `paid` and the `requireStatus: 'issued'` guard refused it) → **treat as success/no-op** (idempotent; a paid bill is correctly preserved, not voided).
  - *`voidInvoice` returns `concurrent_state_change`* → warn + log; admin can void manually. (No retry loop — keep it simple.)
- The admin-facing surfaces (`admin-renew-lapsed-member` response → `/admin/renewals` route) render the warning so a human can finish the rare failed case.

### 4.5 Audit + idempotency
- **Audit:** reuse the existing `invoice_voided` event. Add a structured payload field `supersededByInvoiceId: <newInvoiceId>` (and the canonical `voidReason`) so the automated void is distinguishable from a manual one in the audit viewer without a new enum value. Retention follows the existing `invoice_voided` policy.
- **Idempotency / re-run safety:** voiding an already-`void` bill yields `invalid_status` → skipped. Re-invoking `issueInvoiceForRenewal` (caller retry) does not double-void. This composes cleanly with the existing renewal idempotency on the issue side.

---

## 5. Architecture & boundaries (Principle III)

- The behaviour lives **inside the F4 invoicing module** (Application layer), not in renewals. When a membership bill is issued, the F4 issue use-case (or a thin F4 composition over `issueInvoice` + `voidInvoice`) enforces the supersede invariant. Renewals callers opt in simply by issuing through this path; they do **not** orchestrate the void themselves. This keeps a membership-invoice-integrity rule in the module that owns invoices — the right altitude under Principle III — and covers every issue entry point uniformly.
- Everything the supersede needs is **F4-internal**: `invoice.invoice_subject`, `invoice.member_id`, the invoice-status query, and `voidInvoice`. So **no new cross-module import is introduced** — F4 does not reach into renewals; the existing renewals→F4 bridge direction is unchanged.
- New F4 internals (Application/Infrastructure): a read to list a member's outstanding `issued` membership bills; the supersede composition; the `voidInvoice` options object (`requireStatus`, `suppressCancellationEmail`). The Drizzle-inferred type stays inside F4 infrastructure.
- The membership-issue path surfaces a non-fatal `supersedeWarnings?: string[]` on its result; the renewals bridge (`issueInvoiceForRenewal`) forwards it up so `admin-renew-lapsed-member` → the `/admin/renewals` UI can show a warning when a void failed. No signature break for callers that ignore it.
- No Domain change; no new module; no new invoice status/enum.

---

## 6. Data / schema impact

**None.** No migration. No new column, enum, or table. `suppressCancellationEmail` is an application-layer input flag; `supersededByInvoiceId` rides in the existing `invoice_voided` audit payload (JSON), not a typed column.

---

## 7. Ripple: runbook + copy updates

- 066 design §4.4(4) and §4.5 "void the old bill" **manual step is retired** — update the admin callout copy (EN/TH/SV) to drop the "void the old open bill" instruction (the system now does it). The `record-payment.ts` `membership_terminated` doc-comment that points at the runbook should be updated to note auto-void.
- `docs/runbooks/*` (renewal reactivation runbook, if present) updated accordingly.
- i18n: if the reactivation callout string changes, update all three locales (EN canonical; TH mandatory; SV) — the label-coverage guard fails the build otherwise.

---

## 8. Testing (TDD)

Contract/unit/integration, failing-first:

1. **Reactivate auto-voids the stale bill** — member with one `issued` membership bill → `admin-renew-lapsed-member` → the old bill ends `void` with the canonical reason + `supersededByInvoiceId`; the new bill is `issued`.
2. **No prior bill → no-op** — reactivate a member with no outstanding bill → new bill issued, zero voids, no warning.
3. **Paid bill is never voided (filter)** — member with a `paid` bill → reissue → the paid bill stays `paid` (the `status='issued'` filter excludes it); assert no `voidInvoice` call targets it.
3b. **`issued → paid` race is safe (lock-time guard)** — old bill is `issued` at match time, then transitions to `paid` before the void lock → `voidInvoice` with `requireStatus: 'issued'` returns `invalid_status`, the bill stays `paid`, no VOID stamp over the §86/4. (Integration test against live Neon — the race the mock hides.)
4. **Void failure ⇒ renewal still succeeds** — stub `voidInvoice` to error → `issueInvoiceForRenewal` still returns the issued new bill + a non-empty `supersedeWarnings`.
5. **Already-void is idempotent** — pre-void the old bill → reissue → no error, no double-void (`invalid_status` swallowed).
6. **No email on auto-void** — assert the cancellation-email outbox row is **not** enqueued when `suppressCancellationEmail: true`; and **is** enqueued on a normal manual UI void (regression guard).
7. **Member self-confirm path** — the same auto-void fires through `confirm-renewal` (chokepoint coverage), for a member who somehow has a prior `issued` bill.
8. **Cross-tenant safety** — the list-outstanding query is tenant-scoped (RLS + explicit tenant filter); an integration test proves a peer tenant's bills are never matched.

Coverage: the new F4 read use-case + the void-composition logic hit Application-layer thresholds; the money-adjacent void path keeps its existing branch coverage.

---

## 9. Assumptions + limitations

- **One open membership bill per member** (SweCham annual model). If a tenant ever bills multiple concurrent memberships/periods, the §4.2 rule would over-void — at that point add period/cycle scoping to the match (`WHERE ... AND coverage overlaps`). YAGNI now; documented so it is a conscious deferral, not a silent gap.
- Auto-void only reaches bills issued through **any** path (it is member-scoped, not cycle-scoped) — this is intentional so orphan bills not linked to a cycle are also cleaned up.

---

## 10. Dependency for Sub-project #2 (auto-invoice, A3 auto-draft + admin review)

Sub-project #2 was designed (2026-07-17, adversarial 4-lens workflow → stance **A3**: a cron pre-fills renewal **drafts**; the treasurer reviews a queue and clicks Issue / Discard per row). It issues a cron-created draft through **`issueAutoDraftedRenewal`** — a **different entry point** than the bridge's create-and-issue wrapper. Because *this* design places the supersede at the **F4 `issueInvoice` mint point**, that path inherits void-on-reissue automatically. (Had #1 stayed in the bridge wrapper, #2's issue path would have bypassed it and two open §-era bills could coexist — the exact hole the #2 review surfaced, and the reason this spec was revised to the mint point.) That is why 066 §8 names void-on-reissue the HARD-dependency of auto-invoice: **this design must land, with its mint-point placement + idempotency/failure semantics, before #2 starts.**

Two follow-ons belong to **#2, not here**:
1. **Draft-discard extension.** #2 also needs to discard stale `draft` membership invoices (orphan auto-drafts) for the same member when a bill is issued — void-on-reissue only touches `issued` bills. A #2-scoped extension of the same F4 invariant.
2. **Paid-race latch (renewals-side).** The `requireStatus:'issued'` guard correctly refuses to void a `paid` bill, so it does **not** cover the race where an *active* member pays an existing bill concurrently with a new issue. #2 closes this with a renewals-side latch (set `renewal_cycles.linked_invoice_id` in the issue tx + a pre-issue re-read) — which lives in renewals because F4 must not write renewal tables. **#1 does not need it:** #1's only new caller is reactivation, where the member is *terminated* and cannot concurrently pay (059 portal chokepoint + `membership_terminated` admin gate), so the paid-race cannot materialise in #1's scope.
