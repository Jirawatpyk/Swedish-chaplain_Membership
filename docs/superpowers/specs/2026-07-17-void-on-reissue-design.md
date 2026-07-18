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
- Route the renewal membership-issue path (the bridge `issueInvoiceForRenewal`) through it; #2's `issueExistingDraftForRenewal` joins when it lands. (The `issue/route.ts` refusal of `origin='auto_renewal'` drafts is **#2's** — it owns the `origin` column; see §4.1.)
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
- Sub-project #2's `issueExistingDraftForRenewal` (auto-draft issue) — routes here when #2 lands.
- **Manual/import/event issuance keeps using raw `issueInvoice`** (no supersede — correct: no prior renewal bill to supersede, and this is what keeps backfill/import safe).

**Enforcement test (Principle-III-style boundary):** a guard test asserts the **renewal bridge** calls `issueMembershipBill`, not bare `issueInvoice`, for a membership subject.

**Deferred to #2 (rev-3, review N1):** refusing an `origin='auto_renewal'` / renewal-cycle-linked membership draft at `issue/route.ts` belongs to **#2** — the `origin` column is introduced by #2 (§7), and in #1's world no cycle-linked membership draft is ever left dangling for a human to click Issue (the bridge creates+issues atomically). #1 therefore does **not** touch `issue/route.ts`.

Right module (F4 owns invoice integrity — **no new cross-module import**: `invoice_subject` + `member_id` + `voidInvoice` are all F4-internal) and right altitude (an invoice-integrity invariant), now placed at the concrete, feasible sub-location.

### 4.2 Which bills get voided (matching rule — new-flow bill shape + **asymmetric ordering**)
List the member's **strictly-older** outstanding **new-flow** bills and void each:

> `WHERE tenant_id = <tenant> AND member_id = <memberId> AND invoice_subject = 'membership' AND status = 'issued' AND bill_document_number_raw IS NOT NULL AND document_number IS NULL AND (created_at, id) < (<newBill.created_at>, <newBill.id>)`

- **`(created_at, id) < (newBill…)` — asymmetric ordering (rev-3, closes mutual-void without a spanning lock).** Each issue voids only bills created *before* itself, so the **latest-created bill is never voided by anyone** → concurrent same-member issues converge to exactly **one deterministic survivor** (the newest). This replaces the rev-2 `pg_advisory_xact_lock` (which was transaction-scoped and could not span the post-commit void steps — a `pg_advisory_xact_lock` releases at each tx boundary, so it never actually serialized the composition; review-refuted). It also removes the per-member×per-cycle lock-ordering (ABBA) risk entirely, since no per-member lock is taken. Tiebreak by `id` for equal `created_at`.
- `status='issued'` = the only outstanding-unpaid, pre-receipt state.
- **`bill_document_number_raw IS NOT NULL AND document_number IS NULL`** binds the match to a **088 new-flow bill**, structurally **excluding a legacy issued §86/4** (which has a non-NULL `document_number` and already triggered the tax point). A legacy §86/4 matched by member+subject+status must **not** be auto-voided — surface it as a warning (§4.4). This also makes the auto-void **immune to a flag regression** (if 088 were off, new issuance would mint a §86/4 and `requireStatus` alone would be insufficient).
- Excluding the just-issued id guards the fresh bill.
- **Ship pre-check:** query prod for legacy issued-unpaid §86/4 membership rows (`invoice_subject='membership' AND status='issued' AND document_number IS NOT NULL`) before enabling — if any exist, hand them to the treasurer first.

### 4.3 Void mechanic (ordering, per-member serialization, guards)
1. **Issue-first, then void.** The new bill is issued (PDF rendered) *before* any void. Void failure ⇒ member still has a valid payable bill (worst case = today's dangling-bill state).
2. **Mutual-void closed by asymmetric ordering, NOT a lock (rev-3).** Two near-simultaneous issues for the same member must not each void the *other's* new bill (→ **0 open bills**, an under-billing defect). The rev-2 `pg_advisory_xact_lock` cannot achieve this — it is transaction-scoped and releases at each tx boundary, so it never spans the committed issue tx + the post-commit void txs (holding it across would require an outer idle-in-transaction across the multi-second PDF render/upload — pool pressure + the §4.3.4 nesting-deadlock class). Instead the §4.2 **asymmetric `(created_at, id) <` match** makes the newest bill un-voidable, with **no spanning lock and no ABBA** (no per-member lock is taken at all). **Guarantee (corrected rev-4, empirically verified on live Neon — the rev-3 "deterministic single survivor" was an over-claim):** survivors are **never zero** (mutual annihilation is impossible — the newest is un-voidable); **exactly one** for the *reactivation* shape (the prior stale bill is already committed, so a new issue's void-step always sees and voids it); but **two brand-new bills issued for the same member in the same instant can leave two** (~50% observed) — the tuple-newer bill's void-step can run before the tuple-older bill's commit is visible, so it does not void it. That two-brand-new race is **not reachable through #1's real callers** (reactivate acts on a *lapsed* member, member-confirm on an *active* one — disjoint cycle states; they cannot both mint a brand-new bill for one member at once), it leaves only two *unpaid* bills (**no duplicate §86/4**), and it is exactly the race **#2's content-based pre-issue guard closes** (§10). No per-member serialization primitive is needed for #1's scope.
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
- **Observability (review gap I3/M1, hardened rev-3 for N2/N3):** a failed auto-void leaves a *dangling duplicate bill* — so it must be **discoverable, not just logged**, and the signal must survive the failed void's rollback and not corrupt void-count semantics:
  - **Primary = a metric + alert** `void_on_reissue.failed{reason}`, emitted by the **`issueMembershipBill` composition** (process-level, so it survives even when `voidInvoice`'s own tx rolls back). This is the actionable signal — on the member-self-confirm path `supersedeWarnings` ride the *member's* response and are not actionable.
  - **Do NOT reuse `invoice_voided`** for a *failure* (N3): that event means a bill *was* voided — reusing it would overcount real voids and tell a compliance reader the bill is gone when a dangling duplicate remains. If a durable audit row is wanted, use a **distinct** signal (a new F4 anomaly event — 4-place, 10-year retention as a tax-hygiene record — or an existing anomaly event), **emitted from a separate/`null` tx** so it survives the rollback (the `issue-invoice.ts:332` cross-tenant-probe pattern). Exact event choice at plan time; the constraint is: distinct-from-`invoice_voided` + rollback-surviving.

### 4.5 Audit + idempotency
- **Success:** reuse `invoice_voided` (10y retention, `audit-port.ts:201`) + a `supersededByInvoiceId` payload field (no new enum).
- **Idempotency:** voiding an already-`void` bill → `invalid_status` → skipped; a caller retry does not double-void. Concurrent same-member issues are handled by the §4.2 **asymmetric ordering** (never zero survivors — see the corrected §4.3.2 guarantee), **not** a lock.

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
- **Kill-switch (review gap I9):** add an env flag `FEATURE_VOID_ON_REISSUE` (zod, **default off**). When off, `issueMembershipBill` = plain issue (no supersede) → degrades to today's behaviour; reversible without a deploy. Given it touches the hot `issueInvoice` path + tax documents, flip on **after** the two ship-gates below.
- **Ship-gates before flipping the flag:**
  1. **Legacy-§86/4 prod pre-check** (§4.2): confirm no `invoice_subject='membership' AND status='issued' AND document_number IS NOT NULL` rows, or hand them to the treasurer first.
  2. **Stale-PaymentIntent block (rev-3, review NEW-3 — elevated from "confirm at plan time" to a ship-gate).** `record-payment.ts:343-350` exempts the `webhook` rail from the `membership_terminated` gate, so a Stripe PaymentIntent created *before* termination could settle a terminated member's old bill. #1 has **no** content-based guard (that is #2's). Auto-void is net-neutral-to-positive here (if it wins the race it voids the old bill before settlement; if it loses, `requireStatus:'issued'` still prevents VOID-stamping the now-paid §86/4 — residual is a *spurious open bill*, not a duplicate §86/4). But #1 does not *close* the window, so **prove** that the 059 portal chokepoint + F5 prevent a stale PI from settling on a terminated member's old bill **before** enabling — do not rely on the assumption.

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
7. **Asymmetric ordering — never zero (live-Neon concurrency)** — the reactivation shape (a pre-committed older bill + a new issue) → exactly **one survivor** (the older is voided); two brand-new concurrent issues → **never zero** survivors (the newest is un-voidable) — assert that true bound (two survivors *is* possible and acceptable for #1, closed by #2's content-guard, §10); assert no per-member advisory lock is taken.
8. **Failed auto-void observability** — stub `voidInvoice` to error → `supersedeWarnings` non-empty **and** the failure metric + audit row are emitted (both admin and member-self-confirm surfaces).
9. **Subject filter + exclude-self** — issuing a membership bill does NOT void the member's `issued` **event** invoice; issuing a non-membership invoice triggers no supersede; the freshly-issued bill is never self-voided.
10. **No email on auto-void** — cancellation-email outbox row **not** enqueued when `suppressCancellationEmail:true` (fixture sets tenant `auto_email_enabled=true` so the guard proves something); **is** enqueued on a normal manual UI void (regression).
11. **Entry-point boundary** — a guard test proves the **renewal bridge** calls `issueMembershipBill`, not bare `issueInvoice`, for a membership subject. (The `issue/route.ts` `origin='auto_renewal'` refusal test lives in #2, which owns the column.)
12. **Cross-tenant** — the list-outstanding read is tenant-scoped (RLS + explicit filter); a peer tenant's bills are never matched.

Coverage: the new F4 read + `issueMembershipBill` composition hit Application thresholds; the money-adjacent void path keeps its existing branch coverage (budget for the two new `voidInvoice` branches).

---

## 9. Assumptions + limitations

- **One open membership bill per member** (SweCham annual model) — so §4.2 normally matches 0 or 1. The rule is **member-scoped, not cycle/period-scoped** (intentional, catches orphan bills). If a tenant ever bills multiple concurrent memberships, it would over-void → add period scoping then. **Keep this loud in `plan.md` § Complexity Tracking.**
- **Backfill/import safety (review C2):** because the supersede is a renewal-scoped composition and import (`scripts/import-invoices.ts`) + manual issuance call **raw `issueInvoice`**, multi-bill-per-member backfill is **unaffected** (no auto-void). Confirmed the import path does not route through `issueMembershipBill`.
- **A partial unique index** on `(tenant, member, subject='membership', status='issued')` was **considered and rejected** — it would make a failed best-effort void *block* the next issue, contradicting the non-fatal degradation model. Documented, not adopted.
- **Webhook-rail edge (review M2, elevated to a ship-gate in rev-3):** the "terminated member cannot concurrently pay" claim is not airtight against a *stale Stripe PaymentIntent* created before termination (`record-payment.ts:343-350` exempts the `webhook` rail from the `membership_terminated` gate). `requireStatus:'issued'` still prevents VOID-stamping a paid §86/4 (residual = a spurious open bill, not a duplicate tax doc). This is now **§6 ship-gate 2** — prove the 059 chokepoint + F5 block stale-PI settlement before enabling, do not merely assume it.

---

## 10. Dependency for Sub-project #2 (auto-invoice, A3 auto-draft + admin review)

#2 (designed 2026-07-17, stance A3) issues a cron-created **draft** through **`issueExistingDraftForRenewal`** — a renewal issue path that now routes through **`issueMembershipBill`**, so it inherits void-on-reissue. Three follow-ons belong to **#2** (rev-3 moved the third here):
0. **`issue/route.ts` refusal of `origin='auto_renewal'` / renewal-cycle-linked membership drafts** — #2 owns the `origin` column and is the first phase where a cycle-linked membership draft can dangle for a human to click Issue, so the enforcement lives there (review N1).
1. **Draft-discard extension** — #2 also discards stale `status='draft'` membership invoices for the same member when a bill is issued (void-on-reissue only touches `issued` bills). Because both are F4 invoices this *is* atomic-achievable, but #2 must run it **post-issue in its own tx with a `requireStatus:'draft'` guard** (never inside the issue tx — two concurrent same-member issues each locking+deleting the other's draft deadlocks).
2. **Paid-race guard (renewals-side, content-based)** — #2's pre-issue guard must re-run the **content check** `NOT EXISTS live membership invoice for (member, plan_year)` under the cycle lock, **not** a `renewal_cycles.linked_invoice_id` re-read (which misses orphan/unlinked bills → duplicate §86/4). **#1 does not need this** — #1's only new caller is reactivation (terminated member, cannot concurrently pay, modulo the §9 webhook edge).
   - **(rev-4) Empirical confirmation:** live-Neon concurrency testing (Task 4) showed #1's asymmetric match gives *never zero* survivors but **not** *exactly one* under two brand-new concurrent same-member issues (~50% two-survivor). This same content guard closes that race too (a second concurrent issue sees the first and refuses) — another reason it is **#2's, not #1's**. In #1's scope the race is unreachable (disjoint-cycle-state callers) and harmless (two *unpaid* bills, no §86/4).

**#1 must land first**, with the composition placement + the **asymmetric-ordering void match** + bill-shape matching in place, because #2's issue-half is one of the entry points routed through `issueMembershipBill`.
