# void-on-reissue @ F4 (renewal issue composition) — Design

> **Date:** 2026-07-17 (rev 2 after 4-lens review 2026-07-18) · **Branch:** `106-void-on-reissue` · **Sub-project #1** of the deferred renewal-invoicing workstream (066 §8 rows L175/L176).
> **Supersedes:** the 066 design's manual "void the old bill" runbook step (§4.4(4), §4.5) and the L175/L176 deferrals.
> **Unblocks:** Sub-project #2 (auto-invoice, 066 §8 L180) — this is its stated HARD-dependency.
> **Rev-2 changes (folded from architect / thai-tax / reliability / QA review):** placement resolved to a **renewal-scoped composition** (not "inside `issueInvoice`"); matching bound to the **new-flow bill shape** (protects legacy §86/4); **per-member serialization** (mutual-void); failed-void **observability**; import/backfill safety made explicit; kill-switch; expanded tests.

---

## 1. Goal

When a **new membership bill is issued through a renewal path**, **automatically void that member's prior outstanding (unpaid, new-flow `bill`) membership bill(s)** — in one composition every renewal issue path routes through — so a member never carries two open bills for overlapping coverage. This kills the duplicate-§86/4 risk and retires the manual "void the old bill" runbook step.

One sentence: *reissue supersedes — the old unpaid bill dies when the new one is born, enforced by a renewal-scoped F4 composition (`issueMembershipBill`) so every renewal issue path inherits it, while raw `issueInvoice` stays pristine for import/manual issuance.*

---

## 2. Motivation / current state (verified in code, review-confirmed)

- **Reactivation leaves a dangling bill.** `admin-renew-lapsed-member.ts:468` issues a **new** invoice via the bridge (with `autoEmailOnIssue:true`, `:479`) and **never touches** the member's old unpaid bill from the lapsed cycle → two open bills for one membership → duplicate-§86/4 risk. Today's mitigation is the manual 066 §4.4(4)/§4.5 "void the old open bill" runbook step (forgettable).
- **`voidInvoice` already does the hard part** (`src/modules/invoicing/application/use-cases/void-invoice.ts`): it accepts **both `issued` and `paid`** (`:216`); void is terminal, keeps the §87 number, re-stamps the PDF with the VOID/ยกเลิก overlay, and emits `invoice_voided` **inside its own tx** (`:495`) with 10-year retention (`audit-port.ts:201`). Voiding an `issued` **new-flow bill** (pre-receipt) needs **no §86/10 credit note** (no §86/4 exists yet) — fully tax-clean.
- **The bridge calls _raw_ `issueInvoice`.** `issueInvoiceForRenewal` composes `createInvoiceDraft → issueInvoice` (`f4-invoicing-for-renewal-bridge-drizzle.ts:41,77`). `issueInvoice` returns from **inside its own `withTx`** (`issue-invoice.ts:310,901`) — there is **no post-commit hook**. So the supersede **cannot** live inside `issueInvoice`; it must be a **composition** that runs the void(s) after the issue tx commits (this is why §4.1 is a wrapper, not an `issueInvoice` edit — a review-confirmed correction to rev 1).
- **Raw `issueInvoice` has many callers**, not just renewal: the generic admin issue route (`src/app/api/invoices/[invoiceId]/issue/route.ts:75`), the historical import script (`scripts/import-invoices.ts`, which issues **multiple** membership bills per member by design), and event/manual issuance. A supersede placed *inside* `issueInvoice` would **destroy backfill/import** (void earlier bills). Therefore the supersede is **renewal-scoped**, not universal.
- **088 flow** (flag ON in prod): at issue only a non-§87 `bill` number is minted into `bill_document_number_raw` (`issue-invoice.ts:575-588`), `document_number`/`sequence_number` stay NULL; the §86/4 receipt `RC-…` mints at payment into `receipt_document_number_raw` (`record-payment.ts:715-746`). A **legacy** membership §86/4 (pre-088) is an `issued` row with a non-NULL `document_number` — a *real* tax document that already triggered the tax point. The match must exclude these (§4.2).

---

## 3. Scope + non-goals

### In scope
- A new **renewal-scoped F4 composition** `issueMembershipBill` = `issueInvoice` (unchanged) → list the member's other outstanding new-flow bills → `voidInvoice[]` (each own-tx, post-commit), serialized per member.
- Route **every renewal membership-issue path** through it: the bridge `issueInvoiceForRenewal`, and Sub-project #2's `issueExistingDraftForRenewal`.
- Make **`issue/route.ts` refuse** a membership draft that belongs to a renewal cycle / `origin='auto_renewal'` (typed error → the renewals queue) — enforcement, not UI-hiding.
- A `voidInvoice` options object: `requireStatus?: 'issued'` (tax-safety guard) + `suppressCancellationEmail?: boolean` (default `false`).
- An F4 read: "list the member's outstanding **new-flow** `issued` membership bills."
- Failed-auto-void **observability** (metric + audit).
- A **kill-switch** env flag (§6).
- Retire the manual void step in 066 admin copy/runbook (§4.4(4), §4.5).

### Non-goals (explicit)
- **Never auto-void a `paid` / `partially_credited` / `credited` bill** (§86/4 reversal = §86/10 credit note = human).
- **Never auto-void a legacy §86/4** (`document_number` non-NULL) — surface it as a warning for the treasurer to cancel per ป.86/2542; never silent.
- **Do NOT modify raw `issueInvoice`** — it stays pristine so import/backfill/manual/event issuance is unaffected.
- **No new invoice column / status / enum.** Supersession is expressed by the audit trail, not schema.
- **No change to the F8 cycle state machine, no touching the old (terminal) cycle.**
- **No auto-invoice** (Sub-project #2). This design only makes reissue safe.

---

## 4. Design

### 4.1 Placement — a renewal-scoped composition (NOT inside `issueInvoice`)
The supersede is a **new F4 Application use-case** `issueMembershipBill(deps, input)`:
1. `issueInvoice(...)` (the universal primitive, **unchanged** — no subject branch) → the new bill is issued + its PDF rendered, its tx commits.
2. Then, **in a separate step**, list the member's *other* outstanding new-flow membership bills (§4.2) and `voidInvoice(...)` each (§4.3), each in **its own tx**.

**Callers routed through it (enumerate + enforce):**
- the bridge `issueInvoiceForRenewal` (reactivate + member-confirm) — swap its bare `issueInvoice` call for `issueMembershipBill`;
- Sub-project #2's `issueExistingDraftForRenewal` (auto-draft issue);
- **`issue/route.ts`**: a membership draft linked to a renewal cycle / `origin='auto_renewal'` is **refused** (typed error → queue). A truly manual, non-renewal membership issue may still use raw `issueInvoice` (no supersede — correct; there is no prior renewal bill to supersede, and this keeps backfill/import safe).

**Enforcement test (Principle-III-style boundary):** a guard test asserts no renewal path calls bare `issueInvoice` for `invoice_subject='membership'`, and that `issue/route.ts` refuses a renewal-cycle membership draft.

Right module (F4 owns invoice integrity — **no new cross-module import**: `invoice_subject` + `member_id` + `voidInvoice` are all F4-internal) and right altitude (an invoice-integrity invariant), now placed at the concrete, feasible sub-location.

### 4.2 Which bills get voided (matching rule — bound to the new-flow bill shape)
List the member's other outstanding **new-flow** bills and void each:

> `WHERE tenant_id = <tenant> AND member_id = <memberId> AND invoice_subject = 'membership' AND status = 'issued' AND bill_document_number_raw IS NOT NULL AND document_number IS NULL AND id <> <newlyIssuedInvoiceId>`

- `status='issued'` = the only outstanding-unpaid, pre-receipt state.
- **`bill_document_number_raw IS NOT NULL AND document_number IS NULL`** binds the match to a **088 new-flow bill**, structurally **excluding a legacy issued §86/4** (which has a non-NULL `document_number` and already triggered the tax point). A legacy §86/4 matched by member+subject+status must **not** be auto-voided — surface it as a warning (§4.4). This also makes the auto-void **immune to a flag regression** (if 088 were off, new issuance would mint a §86/4 and `requireStatus` alone would be insufficient).
- Excluding the just-issued id guards the fresh bill.
- **Ship pre-check:** query prod for legacy issued-unpaid §86/4 membership rows (`invoice_subject='membership' AND status='issued' AND document_number IS NOT NULL`) before enabling — if any exist, hand them to the treasurer first.

### 4.3 Void mechanic (ordering, per-member serialization, guards)
1. **Issue-first, then void.** The new bill is issued (PDF rendered) *before* any void. Void failure ⇒ member still has a valid payable bill (worst case = today's dangling-bill state).
2. **Per-member serialization (closes mutual-void).** `issueMembershipBill` takes a **per-member advisory lock** (`pg_advisory_xact_lock` keyed on `tenant+memberId`, namespace disjoint from F4 `invoicing:` §87 locks) around the issue+void sequence. Without it, two near-simultaneous issues for the same member each void the *other's* new bill → the member ends with **0 open bills** (review-confirmed race). The lock serializes them: the second issue sees the first's bill and supersedes it correctly, one survivor.
3. For each matched prior bill, call `voidInvoice` with:
   - `requireStatus: 'issued'` — under `voidInvoice`'s row lock, re-assert `status==='issued'` and return `invalid_status` (→ skipped) otherwise. `voidInvoice` accepts `issued`+`paid` (`:216`); this guard is what keeps the automated path from ever VOID-stamping a `paid` §86/4 if a bill raced `issued→paid`. **The bill-shape filter (§4.2) is defence-in-depth; this lock-time guard is the barrier.**
   - `suppressCancellationEmail: true` — no cancellation email on an automated supersede. Semantics: `shouldAutoEmail = !suppressCancellationEmail && (loaded.autoEmailOnIssue ?? settings.autoEmailEnabled)` (force-suppress regardless of the invoice's stored flag; `void-invoice.ts:534`).
   - `voidReason` (canonical): `"auto-void: superseded by renewal reissue <newInvoiceId>"`.
4. Each `voidInvoice` runs in **its own F4 tx** (never nested inside the issue tx — nesting `runInTenant` while holding the issue row lock deadlocks, the `void-invoice.ts:161` settings-read-outside-tx gotcha class).

### 4.4 Failure handling + observability
- The void step is **best-effort, non-fatal to the renewal.** `issueMembershipBill` returns the issued new bill immediately; void failures ride a non-blocking `supersedeWarnings: string[]` on the result.
- Failure modes:
  - *find-query error* → skip, warn, **emit `invoice_voided` failure metric + a lightweight audit** (see below), log.
  - *`voidInvoice` → `invalid_status`* (already `void`, or raced to `paid`, or a legacy §86/4 that slipped the filter) → **no-op** (paid/legacy preserved).
  - *`voidInvoice` → `concurrent_state_change` / any error* → warn + metric + audit; the dangling bill is admin-voidable.
- **Observability (review gap I3/M1):** a failed auto-void leaves a *dangling duplicate bill* — a tax-hygiene event — so it must be **discoverable, not just logged.** Emit a metric `void_on_reissue.failed{reason}` **and** an audit row (reuse `invoice_voided` with an outcome/`failed` marker in the payload, or the nearest existing event) so the compliance trail reflects the residual duplicate-bill risk regardless of which surface (admin route or member self-confirm) saw the response. On the member-self-confirm path `supersedeWarnings` ride the *member's* response and are not actionable — the metric/audit is the only signal.

### 4.5 Audit + idempotency
- **Success:** reuse `invoice_voided` (10y retention, `audit-port.ts:201`) + a `supersededByInvoiceId` payload field (no new enum).
- **Idempotency:** voiding an already-`void` bill → `invalid_status` → skipped; a caller retry does not double-void; the per-member lock (§4.3.2) serializes concurrent issues.

---

## 5. Architecture & boundaries (Principle III)

- The composition lives **inside F4** (Application). `issueInvoice` stays the pristine universal primitive; `issueMembershipBill` composes it with the new F4 read + `voidInvoice`. **No new cross-module import** (all inputs F4-internal). (Verified precedent: F4 already reaches renewals via `deriveMembershipAccess` through a leaf bridge, and F8 already reads `invoices` via the barrel — but the supersede needs neither; it is purely F4-internal.)
- **Entry-point enforcement is the load-bearing boundary:** every renewal membership-issue path routes through `issueMembershipBill`; `issue/route.ts` refuses renewal-cycle membership drafts; a test asserts no renewal path calls bare `issueInvoice` for a membership subject. Raw `issueInvoice` stays available to import/manual/event.
- New F4 internals: `issueMembershipBill` use-case; the list-outstanding read (tenant-scoped repo — **MUST thread `tx` from `runInTenant`, never the global `db`** — Review-Gate blocker); the two `voidInvoice` options.
- `voidInvoice` + `makeVoidInvoiceDeps` are already barrel-exported (`invoicing/index.ts:332,470`); the new options map cleanly to `void-invoice.ts:216` (status) + `:534` (email).
- No Domain change; no new module.

---

## 6. Data / schema impact + rollout gate

- **Schema: none.** No migration/column/enum. `requireStatus`/`suppressCancellationEmail` are application inputs; `supersededByInvoiceId` rides the `invoice_voided` JSON payload.
- **Kill-switch (review gap I9):** add an env flag `FEATURE_VOID_ON_REISSUE` (zod, **default off**). When off, `issueMembershipBill` = plain issue (no supersede) → degrades to today's behaviour; reversible without a deploy. Given it touches the hot `issueInvoice` path + tax documents, flip on **after** the §4.2 legacy-§86/4 prod pre-check passes. (Alternative considered: ship unflagged with the import path confirmed safe — rejected in favour of the cheap kill-switch.)

---

## 7. Ripple: runbook + copy + i18n

- **Retire 066 §4.4(4)/§4.5 "void the old bill" manual step** — update the reactivation admin callout in **all three locales**. Concrete keys: the `admin.renewals.*` reactivation-callout string(s) that carry "void the old open bill" (do **not** touch the F8 renewal-reminder `copy.ts`, a separate model). Update the `record-payment.ts` `membership_terminated` doc-comment to note auto-void.
- **i18n:** any changed callout string → EN canonical + TH mandatory + SV (label-coverage guard fails the build otherwise).
- `docs/runbooks/*` reactivation runbook updated.

---

## 8. Testing (TDD; money-path → live Neon)

1. **Reactivate auto-voids the stale bill** (live-Neon integration) — member with one new-flow `issued` bill → reactivate → old bill `void` with canonical reason + `supersededByInvoiceId` payload; new bill `issued`; assert the tenant-scoped read threaded `tx` from `runInTenant`.
2. **No prior bill → no-op** — no outstanding bill → new bill issued, zero voids, no warning.
3. **Paid bill never voided (filter)** — a `paid` bill stays `paid`; no `voidInvoice` targets it.
4. **`issued → paid` race (lock-time guard, live-Neon)** — bill races to `paid` before the void lock → `requireStatus:'issued'` → `invalid_status`, no VOID over the §86/4.
5. **Legacy §86/4 is never auto-voided** — an `issued` membership row with non-NULL `document_number` is excluded by the §4.2 shape filter and surfaced as a warning; assert no `voidInvoice` targets it.
6. **Multi-bill partial-failure loop** — member with 2 stale bills; `voidInvoice` on the 2nd throws → 1st is `void`, warning + failure-metric/audit emitted, renewal still succeeds.
7. **Mutual-void serialization** — two concurrent `issueMembershipBill` for the same member → exactly one survivor open bill (not zero); the per-member advisory lock serializes them (live-Neon concurrency test).
8. **Failed auto-void observability** — stub `voidInvoice` to error → `supersedeWarnings` non-empty **and** the failure metric + audit row are emitted (both admin and member-self-confirm surfaces).
9. **Subject filter + exclude-self** — issuing a membership bill does NOT void the member's `issued` **event** invoice; issuing a non-membership invoice triggers no supersede; the freshly-issued bill is never self-voided.
10. **No email on auto-void** — cancellation-email outbox row **not** enqueued when `suppressCancellationEmail:true` (fixture sets tenant `auto_email_enabled=true` so the guard proves something); **is** enqueued on a normal manual UI void (regression).
11. **Entry-point boundary** — `issue/route.ts` refuses a renewal-cycle / `origin='auto_renewal'` membership draft (typed error → queue); a guard test proves no renewal path calls bare `issueInvoice` for a membership subject.
12. **Cross-tenant** — the list-outstanding read is tenant-scoped (RLS + explicit filter); a peer tenant's bills are never matched.

Coverage: the new F4 read + `issueMembershipBill` composition hit Application thresholds; the money-adjacent void path keeps its existing branch coverage (budget for the two new `voidInvoice` branches).

---

## 9. Assumptions + limitations

- **One open membership bill per member** (SweCham annual model) — so §4.2 normally matches 0 or 1. The rule is **member-scoped, not cycle/period-scoped** (intentional, catches orphan bills). If a tenant ever bills multiple concurrent memberships, it would over-void → add period scoping then. **Keep this loud in `plan.md` § Complexity Tracking.**
- **Backfill/import safety (review C2):** because the supersede is a renewal-scoped composition and import (`scripts/import-invoices.ts`) + manual issuance call **raw `issueInvoice`**, multi-bill-per-member backfill is **unaffected** (no auto-void). Confirmed the import path does not route through `issueMembershipBill`.
- **A partial unique index** on `(tenant, member, subject='membership', status='issued')` was **considered and rejected** — it would make a failed best-effort void *block* the next issue, contradicting the non-fatal degradation model. Documented, not adopted.
- **Webhook-rail edge (review M2):** the "terminated member cannot concurrently pay" claim (which is why #1's reactivation scope has no paid-race) is not airtight against a *stale Stripe PaymentIntent* created before termination, since `record-payment.ts:334-349` exempts the `webhook` rail from the `membership_terminated` gate. Probability is low and `requireStatus:'issued'` still prevents VOID-stamping a paid bill; confirm at plan time that the 059 chokepoint + F5 also prevent settling a stale PaymentIntent on a terminated member's old bill.

---

## 10. Dependency for Sub-project #2 (auto-invoice, A3 auto-draft + admin review)

#2 (designed 2026-07-17, stance A3) issues a cron-created **draft** through **`issueExistingDraftForRenewal`** — a renewal issue path that now routes through **`issueMembershipBill`**, so it inherits void-on-reissue. Two follow-ons belong to **#2**:
1. **Draft-discard extension** — #2 also discards stale `status='draft'` membership invoices for the same member when a bill is issued (void-on-reissue only touches `issued` bills). Because both are F4 invoices this *is* atomic-achievable, but #2 must run it **post-issue in its own tx with a `requireStatus:'draft'` guard** (never inside the issue tx — two concurrent same-member issues each locking+deleting the other's draft deadlocks).
2. **Paid-race guard (renewals-side, content-based)** — #2's pre-issue guard must re-run the **content check** `NOT EXISTS live membership invoice for (member, plan_year)` under the cycle lock, **not** a `renewal_cycles.linked_invoice_id` re-read (which misses orphan/unlinked bills → duplicate §86/4). **#1 does not need this** — #1's only new caller is reactivation (terminated member, cannot concurrently pay, modulo the §9 webhook edge).

**#1 must land first**, with the composition placement + per-member serialization + bill-shape matching in place, because #2's issue-half is one of the entry points routed through `issueMembershipBill`.
