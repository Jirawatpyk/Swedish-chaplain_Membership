# auto-invoice (auto-draft + admin review) — Design

> **Date:** 2026-07-17 (rev 2 after 4-lens review 2026-07-18) · **Sub-project #2** of the deferred renewal-invoicing workstream (066 §8 row L180). **Implementation branch:** a fresh `NNN-auto-invoice` off `main` **after Sub-project #1 (`106-void-on-reissue`) ships** — #1 is a HARD-dependency (§9).
> **Stance:** **A3 — auto-draft + admin review** (a cron pre-fills renewal *drafts*; the treasurer reviews a queue and clicks Issue / Discard per row). Chosen via an adversarial 4-lens design workflow (thai-tax · reliability · relationship-fit · architecture).
> **Rev-2 changes (folded from architect / thai-tax / reliability / QA review):** the double-open-bill guard rewritten to a **content-based pre-issue check** (the `linked_invoice_id` re-read missed orphan bills → duplicate §86/4); the **3-tx create→issue→link** topology made explicit (the "same-tx latch" was architecturally impossible); **audit registration corrected to the 7-place F8 lockstep** (the 4-place claim reproduces a prod incident); **draft-discard** made deadlock-safe; **§5.8a** reconciled with the *existing* `dueTrackCycleIds` suppression; **i18n**, **prune-sweep**, **drift-flag**, **enrollment/review UX**, and **orphan-window recovery** made concrete; cron committed to **vercel.json native**.

---

## 1. Goal

A daily cron **pre-fills a renewal draft** for each enrolled member whose current term is inside its billing-cycle lead window; the treasurer works an "auto-drafted renewals" queue and, per row, clicks **Issue + Send**, **Issue silently**, or **Discard**. The §-era bill number (and any email) is minted **only** on the admin's Issue click.

One sentence: *the machine does the typing (drafts), the human keeps the decision (issue) — so a cron mistake is a free discard, never a burned tax number or a mis-sent bill.*

---

## 2. Motivation / current state (verified)

- **No proactive billing exists.** Renewal invoicing today is interactive: `confirm-renewal` (member self-serve → auto-issued via the bridge) and `admin-renew-lapsed-member` (admin, lapsed only). If a member never self-confirms and no admin hand-builds a bill, **nothing is billed.** The T-0 cron only flips `upcoming|reminded → awaiting_payment`; it issues no invoice.
- **`billing_cycle` is inert** (`members.billing_cycle`, `pgEnum('calendar','rolling')`, mig 0255, default `rolling`). This design is its first consumer: `calendar` → bill ~Dec 1; `rolling` → bill ~T-30.
- **The calendar cohort renews at once (~Jan 1)** — the once-a-year batch where hand-building is most error-prone and a wrong bulk auto-issue would do the most damage → the core argument for review-before-mint.
- **Chamber reality:** ~110 members, relationship-driven, treasurer collects **out-of-band**, standing **0-email discipline** (one documented 2026-06-04 seed that emailed a real member; `autoEmailOnIssue:false` mandatory on scripts). A cron that auto-sends is the wrong risk profile.
- **F8 reminders are LIVE** (`FEATURE_F8_RENEWALS=true` in prod, confirmed 2026-07-17): the tier×offset **ladder** (anchored on `expires_at`, daily 06:00 ICT) + the **due-track** dunning (due+7/due+30, anchored on the bill `due_date`, `awaiting_payment` only). The ladder already suppresses its email steps for cycles in `dueTrackCycleIds` (`dispatch-one-cycle.ts:618-624`, populated from `listDueTrackCandidates` — 066 §3.2(2)). This existing mechanism is what §5.8a extends.

---

## 3. Chosen stance (A3) + why

**A3 = the cron mints DRAFTS only; a human clicks Issue.** A draft is **not** a tax document (no §87/bill number until issue). Therefore a cron misfire/stale-price/duplicate/FY-straddle produces **at most a discardable draft — zero tax artifact** (robust even if the 088 flag regresses). It matches SweCham's out-of-band collection and 0-email history (email is leak-proof at cron time — drafts have no outbox), and review-before-mint is a **net labour reduction** from today's hand-building. Decisive vs A2: a mistake is a **free discard** vs A2's void + churn on a silent numbered §-era document the member never saw. The five sub-decisions are recorded (resolved) in §13.

---

## 4. Scope + non-goals

### In scope
- A new **vercel.json-native** renewals cron (coordinator → worker → use-case) creating renewal **drafts** for eligible enrolled members.
- An admin **review queue** (a filtered `origin='auto_renewal'` drafts view) with three per-row actions: **Issue + Send**, **Issue silently** (default), **Discard**.
- The renewals-owned **`issueAutoDraftedRenewal`** use-case (routes the issue through #1's `issueMembershipBill` composition), with the **content-based pre-issue guard** (§5.4), the **3-tx create→issue→link** topology, and **orphan-window recovery**.
- The **draft-discard extension** of #1 (deadlock-safe, §5.4).
- The **§5.8a reminder handoff** (extend `dueTrackCycleIds`).
- Three-key **dark-ship** enrollment (+ its UX), config **cadence** columns, **prune sweep**, **drift flag**, **i18n**, and **observability** (queue-age gauges + alert).

### Non-goals
- **No auto-issue and no auto-send at cron time** (A1/A2, rejected).
- **No new renewal-cycle status, no new invoice status.**
- **No cron-created cycle rows** (`createNextCycleOnPaid` spawns the successor at payment).
- **No bespoke read-model** — reuse the admin invoice list + rendering.
- **No new npm dep.** **No** replacement of `confirm-renewal`.

---

## 5. Design

### 5.1 The cron (trigger + selection) — vercel.json native
A **new fifth renewals cron**, not folded into `enter-awaiting`. Copy the existing coordinator → worker → use-case trio + **one `vercel.json` line** (the repo has migrated to Vercel-native cron; `GET = POST` alias, `enter-awaiting-payment-coordinator/route.ts:51`):
- **Coordinator** `.../cron/renewals/auto-draft-coordinator/route.ts`: `runtime=nodejs`, `force-dynamic`, `export const GET = POST`, `gateCronBearerOrRespond`, short-circuit → `200 {skipped}` when `!f8Renewals && !autoInvoice` or `readOnlyMode`, fresh `correlationId`, `Promise.allSettled` per tenant, emit `cron_dispatch_orchestrated` (`cron_kind:'auto_draft'`).
- **Worker** `.../cron/renewals/auto-draft/[tenantId]/route.ts`: bearer gate, flag guard, `tenantId===env.tenant.slug` else 400, `runInTenant` → advisory lock `renewals:autodraft:<tenantId>` (namespace **disjoint** from the per-cycle + dispatch locks and F4 `invoicing:` / F5 `payments:` / F7 `broadcasts:` — asserted by test) → `makeRenewalsDeps` → use-case → `200` counters.
- **Use-case** `auto-draft-due-renewals.ts` + barrel export.
- **Schedule** `0 22 * * *` UTC = **05:00 ICT**, in the renewals block **before** the 06:00 dispatch chain (UTC-only model; verified correct offset).

**Eligibility** `listCyclesEligibleForAutoDraft(tenantId, {nowIso, leadDaysCalendar, leadDaysRolling, pageSize})` joining `members`:
`status IN ('upcoming','reminded') AND period_to > now AND period_to <= now + leadDays(billing_cycle) AND member NOT archived AND members.auto_invoice_enrolled_at IS NOT NULL AND membership-access ∉ {terminated,suspended} AND NOT EXISTS a live membership invoice for (member, plan_year)`. Exactly one active cycle exists (`createNextCycleOnPaid` wired); the cron bills that cycle for the next window and creates **no** cycle row.

### 5.2 What the cron creates — drafts only
Via a new bridge method **`draftInvoiceForRenewal`** = the `createInvoiceDraft`-half only. Result: **no §87/bill number, no `bill_document_number_raw`, no PDF, no outbox row** — `status='draft'`, `origin='auto_renewal'`, `autoEmailOnIssue` stored **explicit `false`**. `renewalSignal.unitPriceSatang` = the current cycle's `frozenPlanPriceThb`; `membershipCoverage = {kind:'window', fromIso: cycle.periodTo, toIso: addMonthsUtc(cycle.periodTo, cycle.frozenPlanTermMonths)}`; `planYear = deriveFiscalYear(cycle.periodTo)`. (Verified: `createInvoiceDraft` allocates no number under any flag — `create-invoice-draft.ts`.)

### 5.3 The admin review queue
A filtered admin invoices view scoped to `origin='auto_renewal' AND status='draft'` + renewals-scoped actions (per row + bulk-over-selected):
- **Issue + Send** → mints the bill (via `issueAutoDraftedRenewal`) with the email override **threaded as a use-case/issue parameter, NOT a pre-issue row patch** (rev-3, review N4): a patch-then-issue two-step leaves the draft `autoEmailOnIssue=true` if the issue then fails, so a later "Issue silently" retry would inherit `true` and leak an email. Passing the override into the issue path (`issue-invoice.ts:858` resolves `draft.autoEmailOnIssue ?? settings.autoEmailEnabled` — the param supersedes the stored `false` only for this issue) enqueues exactly one locale-correct outbox row (`resolveRecipientLocale` → primary contact; empty-recipient skipped-with-warning) with no persisted state to leak.
- **Issue silently** (**default**) → mints the bill, `autoEmailOnIssue` stays `false` → member billed, no email.
- **Discard** → emit `renewal_auto_draft_discarded`, delete the draft.

The queue surfaces the **drift flag** (§5.10), the **bill-year ≠ coverage-year** note (§11), a **staleness indicator** (§5.5), and any **`supersedeWarnings`** returned by the issue path (from #1).

### 5.4 Idempotency, double-bill avoidance, draft-discard, tx topology
**Tx topology (review C1 correction).** The latch cannot share the F4 issue tx — F4 owns its own tx and must not write `renewal_cycles`. `issueAutoDraftedRenewal` follows the **existing 3-tx pattern** (`confirm-renewal.ts:544-557`, `admin-renew-lapsed-member.ts:509-517`): draft already exists → **issue** (F4 `issueMembershipBill`, its own tx, commits the number) → **link** (`renewal_cycles.linkInvoice ... WHERE linked_invoice_id IS NULL OR = $1`, own tx). Safety is inferred from *this shape* + the guard below, **not** from an atomicity that does not exist.

**Pre-issue guard — content-based, NOT `linked_invoice_id` (review C2, the deep catch).** Before minting, under the per-cycle lock, re-run the **same content check as eligibility**: `NOT EXISTS a live membership invoice for (member, subject='membership', plan_year) IN {draft,issued,paid,partially_credited,credited}` (excluding this draft). A `linked_invoice_id` re-read **misses orphan/unlinked bills** (which #1 §9 admits exist): a member could self-renew (bill B1 issued, link fails → orphan), pay B1 (paid §86/4), then the admin's Issue on the draft would not see B1 via `linked_invoice_id` and would mint a **second** §86/4 → duplicate. The content check catches B1 (any status) and refuses the issue. **This member+plan_year content guard is the primary duplicate-§86/4 barrier** — #1's void-on-reissue cannot cover the concurrently-paid case.

**Draft-discard (deadlock-safe).** When a bill is issued for a member, discard stale `status='draft'` membership invoices for the same `(member, plan_year)`. Both are F4 invoices so it is atomic-achievable, but it runs **post-issue in its own tx** with a **`requireStatus:'draft'`** guard (a `DELETE ... WHERE status='draft'` no-ops safely if a concurrent tx is promoting the draft → issued). It must **not** run inside the issue tx (two concurrent same-member issues each locking+deleting the other's draft → deadlock, the `for-no-key-update-deadlock` class).

**Other layers:** content-based draft dedup in the eligibility query (a re-run never mints a second draft; a self-renewed member is excluded); per-run advisory lock + per-cycle tx re-read at draft time (mirrors `enter-awaiting`'s TOCTOU pattern). **Double-draft** is possible but harmless; **double-open-bill** is prevented by the content guard, not by construction claims.

### 5.5 Failure handling + orphan-window recovery
- Coordinator `Promise.allSettled` per tenant; worker per-cycle try/catch around a per-cycle tx (lock → re-read → draft → `emitInTx`), counting `drafted / skipped_existing / skipped_opt_out / skipped_terminated / errors` and continuing (ship a **throw-path integration test** where the bridge rejects mid-batch). The **daily re-run IS the retry**; the **range** window self-heals a missed day. Auth via shared `gateCronBearerOrRespond`. Feature-off/read-only → `200 {skipped}`, never 503.
- **Cron-side zero tax blast radius** (drafts only) — true. **Issue-side is different (review I4):** `issueAutoDraftedRenewal` inherits the create→issue→link **orphan window** — the SC number mints (issue tx commits) then the link tx fails → an **issued orphan bill with a burned number** that the prune sweep (drafts-only) cannot catch. **Recovery (concretized rev-3):** (1) an idempotent link retry (`linkInvoice ... WHERE linked_invoice_id IS NULL OR = <invoiceId>`) attempted immediately after the failed issue and again on the next queue action for that cycle; (2) a **named daily reconcile cron** `.../cron/renewals/reconcile-issued-orphans` that finds `origin='auto_renewal' status='issued'` invoices for a member whose current cycle has `linked_invoice_id IS NULL` and re-links them (idempotent, bearer, `GET=POST`, `200 {skipped}` off) — the issued-bill analogue of the drafts-only prune sweep, since a burned-number orphan must not rely on an admin returning to that cycle; (3) admin-void as the manual backstop. Covered by an integration test (issue-success, link-fail → the reconcile re-links, no duplicate). **Do not** rely on "a reconcile pass" unnamed — the unlinked-settlement path is warn-only at its terminal exit, so a never-relinked orphan would otherwise settle silently.
- **`prune-expired-auto-drafts` sweep (made concrete, review I7):** a new cron route `.../cron/renewals/prune-auto-drafts` (daily, bearer, `GET=POST`, `200 {skipped}` when flag off), discarding `origin='auto_renewal' status='draft'` invoices whose cycle has left `upcoming|reminded` (member self-renewed, or lapsed ~90d after a T-30 draft). It emits **`renewal_auto_draft_discarded`** (same event as a manual discard) and is idempotent; tested happy + throw-path.

### 5.6 Cadence (config)
`tenant_invoice_settings`: `auto_invoice_lead_days_rolling INT DEFAULT 30`, `auto_invoice_lead_days_calendar INT DEFAULT 31` (`CHECK 1..120`), `auto_invoice_page_size INT DEFAULT 200`. `billing_cycle` drives **WHEN only**; the window always comes off the current cycle's `period_to`. A self-healing **range** window, never a fixed civil date.

### 5.7 Enrollment / dark-ship (three-key, all default-off) + UX
1. **`FEATURE_AUTO_INVOICE`** env flag (zod, default `false`, independent of `FEATURE_F8_RENEWALS`).
2. **`tenant_invoice_settings.auto_invoice_enabled BOOLEAN DEFAULT false`**.
3. Per-member **`members.auto_invoice_enrolled_at TIMESTAMPTZ NULL`** (opt-in).

**Opt-in for the first cohort.** **Enrollment UX (review I8):** a **bulk admin action on the Members directory** ("Enrol selected in auto-invoice") writing `auto_invoice_enrolled_at`, plus a read-only badge on the member profile; no per-member form field in v1. The **membership-state gate** lives in the eligibility query **and** is re-asserted inside `issueAutoDraftedRenewal` (defense-in-depth — the F4 issue path is ungated and the record-payment gate fails open).

### 5.8 Interaction with `confirm-renewal` + `admin-renew-lapsed-member`
**Coexist, not replace** — all collisions arbitrated at #1's `issueMembershipBill` chokepoint. `confirm-renewal` stays the self-service + plan-change lane (recommended: short-circuit to "pay your existing bill" when a live bill exists). `admin-renew-lapsed-member` (comeback) operates only on lapsed/terminal cycles — disjoint from auto-draft eligibility. The queue-issue action MUST be `issueAutoDraftedRenewal` (only it can write `renewal_cycles`). **`issue/route.ts` refusal is #2's responsibility (rev-3, moved from #1 per review N1):** because #2 introduces the `origin` column (§7) and is the first phase where a cycle-linked membership draft can dangle for a human to click Issue, `issue/route.ts` must **refuse** an `origin='auto_renewal'` / renewal-cycle-linked membership draft (typed error → the renewals queue), enforced by a **contract test** — UI-hiding is not enforcement (the API stays callable). A truly manual, non-renewal membership issue is unaffected (raw `issueInvoice`).

### 5.8a F8 reminder-stream coordination — extend the existing suppression
`FEATURE_F8_RENEWALS` is **ON in prod**. The two streams:
- **Ladder** (expiry-anchored, respects opt-out): a generic "renew" nudge referencing **no invoice**; overlaps auto-draft's ~T-30 window but is not a double-email (auto-draft silent); a member self-serving off the CTA is made safe by the eligibility dedup + #1's draft-discard.
- **Due-track** (bill-due-anchored, `awaiting_payment` only, ignores opt-out): references an **invoice**; a `draft` never triggers it (no issued bill), so auto-draft cannot dun a bill that does not exist.

**Correction (review I3/I6):** the ladder does **not** "skip only on unreconciled-paid" — it already stands its email steps down for cycles in **`dueTrackCycleIds`** (`dispatch-one-cycle.ts:618-624`, from `listDueTrackCandidates`). So the handoff is **an extension of that existing mechanism, not a new parallel gate**: (a) `issueAutoDraftedRenewal` transitions the cycle `upcoming|reminded → awaiting_payment` on issue; (b) ensure a freshly-issued bill enters `dueTrackCycleIds` immediately (via a targeted addition), closing the narrow window between issue and the candidate query first picking the cycle up.
**Scope guard (rev-3, review I5-nit):** do **NOT** globally widen `listDueTrackCandidates`' window as a side effect — the existing `[expiry, due+7)` **quiet window** is pinned by a converse test (066 due-track topology), and broadening it would fire dunning early for *every* member, not just auto-issued ones. The change must be **isolated** to "this cycle now has a live issued bill" (a `linked_invoice_id IS NOT NULL AND status='issued'` membership-bill signal), with its own test asserting the quiet window is unchanged for cycles *without* an issued bill. Net remains **one** dunning stream (ladder before a bill exists → due-track after); the pre-existing 066 double-track cleanup is a *scoped* consequence, not a global window change.

**Race note (review I5):** the dispatch cron snapshots `dueTrackCycleIds` at pass start; an admin Issue mid-pass is not seen until the next pass, so "exactly one stream" is **eventually-consistent, not atomic** (a rare same-pass double-touch is accepted). Mitigation: evaluate the live-unpaid-bill state with a **fresh read per candidate** rather than the pass-start snapshot.

### 5.9 Email policy
Per-action, **default silent** (§13.2). The cron enqueues **zero** email. The draft stores `autoEmailOnIssue=false` **explicitly, never null** (verified: `issue-invoice.ts:858` resolves `?? settings.autoEmailEnabled`, default true — a null would silently email). "Issue + Send" is the only path that sets `true`.

### 5.10 Price freshness + drift flag (made concrete)
Bill the current cycle's **frozen** price (faithful to `confirm-renewal`). **Drift flag (review I7):** the queue computes `drift = frozenPlanPriceThb ≠ current active plan-catalogue price for (planId, planYear)` (exact satang inequality after `parseThbDecimalToSatang`; any non-zero delta flags) and shows a badge so the treasurer catches a dues change before issuing. No silent re-snapshot. Tested.

---

## 6. Architecture & boundaries (Principle III)

- New renewals machinery: **four** cron routes (auto-draft coordinator + worker, `prune-auto-drafts`, `reconcile-issued-orphans`); use-cases `auto-draft-due-renewals` (worker body) + `issueAutoDraftedRenewal` (queue action, owns `renewal_cycles`); repo `listCyclesEligibleForAutoDraft`. Two new **bridge** methods: `draftInvoiceForRenewal` (create-half) and `issueExistingDraftForRenewal` (issue-half, routes through #1's `issueMembershipBill`). Naming: the *use-case* is `issueAutoDraftedRenewal`; the *bridge method* it calls is `issueExistingDraftForRenewal`. **Port-signature note (review M6):** new bridge methods can hide behind stale test stubs (casts defeat typecheck) — grep + run the whole renewals module suite.
- F4 reached only via the already-wired bridge leaf-factory; the renewals-side link/latch writes `renewal_cycles` (renewals-owned). Zero new npm deps. Apply migration + `pnpm test:integration` on live Neon **before** committing schema; failing money-path test first.

---

## 7. Data / schema + audit (the FULL F8 7-place lockstep)

- **Columns:** `invoices.origin invoice_origin pgEnum('manual','auto_renewal') DEFAULT 'manual'`; optional `renewal_cycles.auto_draft_invoice_id uuid NULL`; `members.auto_invoice_enrolled_at TIMESTAMPTZ NULL`; `tenant_invoice_settings.auto_invoice_enabled BOOL DEFAULT false` + `auto_invoice_lead_days_rolling/_calendar` + `auto_invoice_page_size`.
- **Env:** `FEATURE_AUTO_INVOICE` in `src/lib/env.ts` (no new secret — `CRON_SECRET` shared).
- **Two new audit events `renewal_auto_drafted` + `renewal_auto_draft_discarded` — this touches SEVEN places, not four (review C3; omitting #4 reproduces a documented prod incident — an ungraduated event hits `pinoFallback` which THROWS in prod, crashing the request + dropping the audit row):**
  1. `F8_AUDIT_EVENT_TYPES` tuple (`renewal-audit-emitter.ts`, 70→72).
  2. `_AssertF8AuditEventCount` compile assertion (70→72).
  3. pgEnum migration (`ADD VALUE ×2`).
  4. **`F8_ENUM_SHIPPED_TUPLE`** (`drizzle-renewal-audit-emitter.ts`) — the load-bearing one.
  5. `tests/unit/renewals/application/ports.test.ts` count assertion (CI-blocked via `scripts/check-cross-module-audit-counts.ts`).
  6. i18n `audit.eventType` labels in **en/th/sv** (`audit-event-label-coverage.test.ts` — TH must be Thai script, SV must differ from EN; **build-failing**; NOT covered by `check:i18n`).
  7. `ALL_AUDIT_EVENT_TYPES` / `DB_ONLY_AUDIT_EVENT_TYPES` sync (`schema.ts`).
  Plus a **live-Neon completeness test** that both events actually persist via `emitInTx` (mocks cannot catch the `pinoFallback`-throw class). `cron_kind` gains `'auto_draft'` — confirm whether it is a closed union needing a registration + a positive test.
- The admin issue reuses `invoice_issued`; the void backstop reuses #1's `invoice_voided`. **No** new renewal-cycle/invoice status.

### 7.1 i18n obligation (review I1 — was entirely absent)
EN canonical + **TH mandatory** + SV for: (a) the **queue UI** — the three action labels (Issue + Send / Issue silently / Discard), column headers, the drift-flag badge, the bill-year≠coverage-year note, the staleness indicator, the enrolment action; (b) the **two new `audit.eventType` labels** ×3 locales (the label-coverage guard **fails the build** without TH-script + SV≠EN). Captured as a first-class task, not an afterthought.

---

## 8. Audit & observability

Per-draft `renewal_auto_drafted` (member, cycle, plan_year, frozen price, coverage window, `correlationId=auto-draft:<cycleId>:<runId>`). One `cron_dispatch_orchestrated` per run (`cron_kind:'auto_draft'`, counters + `tenants_succeeded/failed`). Admin issue → `invoice_issued` (+ `invoice_voided`/`supersededByInvoiceId` on supersede); discard/prune → `renewal_auto_draft_discarded`. Gauges (reuse `observeCycleStateGaugesForTenant`): `auto_draft.drafts_created/_skipped{reason}/_errors`, **`auto_draft.pending_queue_size`** + **oldest-unreviewed-draft-age** with an **age-based alert** near the Dec-1 batch — the standing mitigation for the single-admin bus-factor. Runbook `docs/runbooks/cron-jobs.md`: add both cron routes to the vercel.json catalogue + the SC-year≠coverage-year note + the three-key enable procedure.

---

## 9. Dependency on Sub-project #1 + the resolved race model

#1 (`106-void-on-reissue`) must land first, providing the **`issueMembershipBill` composition** (issue → list new-flow bills → void[], per-member-serialized) that #2's `issueExistingDraftForRenewal` routes through. The two #2-scoped follow-ons:
1. **Draft-discard** (§5.4) — deadlock-safe, post-issue own-tx, `requireStatus:'draft'`.
2. **Content-based pre-issue guard** (§5.4) — the primary duplicate-§86/4 barrier, because void-on-reissue refuses `paid` bills and the `linked_invoice_id` re-read misses orphans.

**Mutual-void + concurrent-mint interplay (rev-3):** #1's **asymmetric `(created_at, id) <` void match** (not a lock) guarantees a deterministic single survivor even under concurrent same-member issue — so a second concurrent issue never annihilates the first's bill. This content guard (member+plan_year, any status) is what closes the *duplicate-§86/4* concurrent-mint case that the void backstop cannot (it refuses `paid` bills). The paid-race content-guard test (live Neon) is a **failing-first ship blocker** before `FEATURE_AUTO_INVOICE` is flipped, and it depends on #1's asymmetric match already being in place.

---

## 10. Testing (TDD, failing-first; money-path → live Neon)

1. **Cron drafts due members** — one `draft`, `origin='auto_renewal'`, correct window + frozen price, `autoEmailOnIssue=false` explicit, **no number/PDF/outbox**.
2. **Dedup** — re-run → no second draft; a member with an existing live membership invoice for the plan_year is skipped.
3. **Not enrolled / terminated / archived** — excluded by eligibility.
4. **Terminated AFTER draft, before issue** (the real security barrier) — member becomes terminated/suspended after the draft → the Issue click is **blocked inside `issueAutoDraftedRenewal`**, not just the query.
5. **Issue silently** — number minted, `linked_invoice_id` set, `createNextCycleOnPaid` intact, **zero** outbox rows (fixture: tenant `auto_email_enabled=true`; assert the draft persisted `autoEmailOnIssue=false` explicitly).
6. **Issue + Send** — exactly **one** locale-correct outbox row; empty-recipient → skipped-with-warning.
7. **Content pre-issue guard (paid-race, live Neon — ship blocker)** — orphan/unlinked bill B1 paid for the member+plan_year → the Issue on the draft is **refused** by the content check; no duplicate §86/4.
8. **Draft-discard** — orphan `status='draft'` for `(member, plan_year)` discarded on issue (own-tx, `requireStatus:'draft'`); concurrent draft→issued promotion is not clobbered.
9. **Issue-success / link-fail orphan recovery** — number minted, link tx fails → the idempotent link retry (and the `reconcile-issued-orphans` cron) re-links it, no duplicate; a never-relinked orphan is caught by the reconcile cron, not left to unlinked-settlement.
9b. **`issue/route.ts` boundary (contract test)** — an `origin='auto_renewal'` / renewal-cycle-linked membership draft posted to the generic issue route is **refused** (typed error → queue), not issued via bare `issueInvoice`; a non-renewal membership draft is unaffected.
9c. **Reminder quiet-window unchanged** — a cycle *without* an issued bill still observes the `[expiry, due+7)` quiet window (the §5.8a scope guard — dunning is not fired early globally).
10. **Batch isolation** — bridge rejects mid-batch → other members still drafted; counters correct (throw-path, live Neon).
11. **Missed-day self-heal** — skip a cron day → next run still drafts the cohort (range window).
12. **Prune sweep** — draft whose cycle left `upcoming|reminded` is discarded, emits `renewal_auto_draft_discarded`; idempotent + throw-path.
13. **Drift flag** — frozen ≠ catalogue price → the queue flags it.
14. **Reminder handoff (F8 live, live Neon)** — a `draft` triggers neither an invoice-referencing ladder nudge nor due-track; after issue, the cycle is `awaiting_payment` and enters `dueTrackCycleIds` so the ladder email stands down — one stream, asserting the issue→due-date window precisely.
15. **Audit completeness (live Neon)** — `renewal_auto_drafted` + `renewal_auto_draft_discarded` actually persist via `emitInTx` (proves pgEnum + `F8_ENUM_SHIPPED` + the count bump 70→72); `cron_dispatch_orchestrated{cron_kind:'auto_draft'}` is accepted; the ×3-locale `audit.eventType` labels exist.
16. **Advisory-lock disjointness** — `renewals:autodraft:*` does not contend with per-cycle/dispatch/`invoicing:` locks.
17. **Cross-tenant** — eligibility + issue are tenant-scoped; a peer tenant is never drafted/issued.
18. **Flag-off / read-only** → `200 {skipped}`, nothing created.

---

## 11. Risks + mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Duplicate §86/4 via orphan/unlinked bill (the `linked_invoice_id` re-read gap) | **high** | The **content-based** pre-issue guard (§5.4, member+plan_year, any status) — the primary barrier; void-on-reissue is a backstop only. Ship-blocker test #7. |
| #1 dependency (issue-existing-draft path bypasses void) | **high** | Resolved: #2's issue-half routes through #1's `issueMembershipBill`; enforce via #1 §4.1 entry-point test. |
| Single-admin bus-factor / unworked queue near Dec-1 | **high** | `pending_queue_size` + oldest-draft-age gauges + age alert; prune sweep; treasurer runbook. |
| Terminated/suspended auto-billed | **high** | Gate in eligibility **and** re-asserted in `issueAutoDraftedRenewal` (test #4). |
| Audit under-registration (4-place claim) reproduces prod `pinoFallback` crash | **high** | The full **7-place** lockstep (§7) + live-Neon completeness test #15. |
| Mutual-void (concurrent same-member issue → 0 bills) | medium | #1's per-member serialization lock + the content guard (§9). |
| Draft-discard / issue in-tx deadlock | medium | Post-issue own-tx + `requireStatus:'draft'` (§5.4). |
| Issue-success / link-fail orphan (burned SC number) | medium | Idempotent link retry + admin void (§5.5, test #9). |
| `billing_cycle` over-marking (0255) | medium | Mandatory admin-review pass before enabling (§12); A3 review discards a wrong-cadence row. |
| Accidental email at issue (null re-inherits tenant true) | medium | Explicit `false` on draft; default silent; tests #5/#6. |
| Reminder double-track (F8 ON) | medium | §5.8a: extend `dueTrackCycleIds` (one stream); eventually-consistent, fresh read per candidate. |
| i18n build-fail on the 2 audit labels + queue strings | medium | §7.1 i18n task (EN/TH/SV). |
| FY-boundary click timing | low | Surface bill-year≠coverage-year; issue Dec batch before year-end; number minted at click. |

---

## 12. Rollout phases

0. **Ship dark** — `FEATURE_AUTO_INVOICE=false` + migrations on dev Neon; failing money-path tests first, green on live Neon; **#1 landed** (composition + per-member serialize + bill-shape matching); test #7 (paid-race) green.
1. **Data prerequisite** — the mandatory `billing_cycle` admin-review pass. **Tool (review I8):** a filtered Members view + bulk-correct action (name it; do not leave as "a pass").
2. **Shadow** — flip per-tenant `auto_invoice_enabled` with a 2–3 member opt-in pilot; verify queue populates correctly, zero emails, dedup + state-gate + gauges.
3. **Opt-in cohort** — enrol the calendar cohort (bulk action, §5.7) ahead of a real ~Dec 1 batch; treasurer works the queue; monitor queue-age alerts + prune.
4. **Steady state** — expand opt-in (or opt-out only if the review model proves reliable — §13.3), keeping the queue-age alarm.

---

## 13. Resolved decisions (the five forks)

1. **Core stance** → **A3 auto-draft + admin review.**
2. **Email** → **per-action, default "Issue silently"**; `autoEmailOnIssue=false` explicit.
3. **Enrollment** → **opt-in for the first cohort** (bulk admin action); revisit opt-out later.
4. **Cadence** → **per-tenant config columns** + self-healing range window.
5. **Price** → **frozen price + a queue drift flag.**
