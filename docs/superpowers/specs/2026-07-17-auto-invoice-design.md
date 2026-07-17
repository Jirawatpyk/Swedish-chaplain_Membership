# auto-invoice (auto-draft + admin review) — Design

> **Date:** 2026-07-17 · **Sub-project #2** of the deferred renewal-invoicing workstream (066 §8 row L180). **Implementation branch:** a fresh `NNN-auto-invoice` off `main` **after Sub-project #1 (`106-void-on-reissue`) ships** — #1 is a HARD-dependency (§9).
> **Stance chosen:** **A3 — auto-draft + admin review** (a cron pre-fills renewal *drafts*; the treasurer reviews a queue and clicks Issue / Discard per row). Selected 2026-07-17 via an adversarial 4-lens design workflow (thai-tax · reliability · relationship-fit · architecture) over three stances (A1 full-auto, A2 auto-issue-hold-send, A3 auto-draft-review).
> **Foundation consumed:** `billing_cycle` (066/065 §5.1, migration 0255) becomes live here; void-on-reissue at the F4 mint point (#1) is the double-bill backstop.

---

## 1. Goal

Stop relying on a member to self-serve (or an admin to hand-build) a renewal invoice. A daily cron **pre-fills a renewal draft** for each enrolled member whose current term is inside its billing-cycle lead window; the treasurer works an "auto-drafted renewals" queue and, per row, clicks **Issue + Send**, **Issue silently**, or **Discard**. The §-era bill number (and any email) is minted **only** on the admin's Issue click.

One sentence: *the machine does the typing (drafts), the human keeps the decision (issue) — so a cron mistake is a free discard, never a burned tax number or a mis-sent bill.*

---

## 2. Motivation / current state (verified in code)

- **No proactive billing exists.** Renewal invoicing today is fully interactive: `confirm-renewal` (member clicks confirm in the portal → `createInvoiceDraft → issueInvoice` via the bridge, auto-issued) and `admin-renew-lapsed-member` (admin, lapsed members only). If a member never self-confirms and no admin hand-builds a bill, **nothing is billed**. The T-0 cron `enter-awaiting-payment-on-expiry` only flips `upcoming|reminded → awaiting_payment`; it issues **no** invoice.
- **`billing_cycle` is inert.** `members.billing_cycle` (`pgEnum('calendar','rolling')`, migration 0255, default `rolling`) records a per-member cadence but drives no behaviour. This design is its first consumer: `calendar` (1/1–31/12 term) → bill ~Dec 1; `rolling` (anniversary) → bill ~T-30.
- **The whole calendar cohort renews at once (~Jan 1).** A once-a-year batch is exactly where hand-building bills is most error-prone and where a wrong bulk auto-issue would do the most damage — the core argument for review-before-mint.
- **Chamber reality.** ~110 members, relationship-driven, the treasurer collects **out-of-band** (the bill email is not the primary collection lever), and there is a standing **0-email discipline** (guard: one documented 2026-06-04 seed that emailed a real member; `autoEmailOnIssue:false` + `suppressReceiptEmail:true` are mandatory on scripts). A cron that *auto-sends* is the wrong risk profile.

---

## 3. Chosen stance (A3) + why

**A3 = the cron mints DRAFTS only; a human clicks Issue.** Under the 088 flow, the §-era bill number (`SC-YYYY`, issue-date FY) is allocated at *issue*, and the §86/4 receipt (`RC-YYYY`) later at *payment* — so a draft is **not a tax document**. Therefore:

- **thai-tax (5/5):** the cron never burns a Revenue-Code-relevant number without a human deciding to. A cron misfire, stale price, duplicate, or FY-boundary straddle produces **at most a discardable draft — zero tax artifact** (robust even if the 088 flag regresses: the cron mints no number under any flag).
- **relationship-fit (best):** matches how SweCham operates; review-before-mint is a **net labour reduction** from today's hand-built/from-scratch creation, not new work; email is **leak-proof at cron time** (drafts have no outbox row).
- **reliability:** the automated component has **zero blast radius** (cannot burn a number, double-bill, or mis-email); residual risk sits in a human-gated, flagged, fixable dependency (#1).
- **architecture (the one dissent):** A3 is the heaviest build (new cron + review surface). But its sharpest objection — *put #1's void at the F4 mint point* — is adopt-regardless (three lenses), and #1 already does exactly that. The build is kept lean (a filtered invoices view + a renewals-scoped issue/discard action, not a bespoke read-model).

**Decisive vs A2 (auto-issue-hold-send):** email safety does **not** separate them (both are silent at cron time). The separator is the **burned number**: A3 makes a mistake a **free discard**; A2 mints a silent numbered §-era document the member never saw and corrects mistakes with a costly **void + churn** — worst exactly when the batch is biggest (the ~Dec 1 calendar cohort).

The five sub-decisions are recorded (resolved) in §13.

---

## 4. Scope + non-goals

### In scope
- A new renewals cron (coordinator → worker → use-case) that creates renewal **drafts** for eligible enrolled members.
- An admin **review queue** (lean: a filtered `origin=auto_renewal` drafts view) with three per-row actions: **Issue + Send**, **Issue silently** (default), **Discard**.
- A renewals-owned **`issueAutoDraftedRenewal`** use-case that mints the number through the F4 issue path (inheriting #1's supersede), sets `renewal_cycles.linked_invoice_id`, preserves `createNextCycleOnPaid`, and re-asserts the terminated gate.
- Three-key **dark-ship** enrollment (env flag + tenant flag + per-member opt-in), config **cadence** columns, and **observability** (queue-age gauges + alert).
- The **#2-scoped extensions of #1**: discard stale auto-`draft`s on issue; the renewals-side paid-race **latch** (§9).

### Non-goals (explicit)
- **No auto-issue and no auto-send at cron time** (that is A1/A2; rejected). The cron never allocates a number or enqueues an email.
- **No new renewal-cycle status, no new invoice status.** `draft/issued/paid/void` suffice; `document_type` already has `bill` (088).
- **No cron-created cycle rows.** The cron bills the member's existing current cycle for the next window; `createNextCycleOnPaid` (wired on this branch) spawns the successor at payment.
- **No bespoke read-model / new admin product.** Reuse the existing admin invoice list + rendering.
- **No new npm dependency** (Constitution X). **No** replacement of `confirm-renewal` — it stays the self-service + plan-change lane (§5.8).

---

## 5. Design

### 5.1 The cron (trigger + selection)
A **new, fifth renewals cron** — *not* folded into `enter-awaiting-payment-on-expiry` (that selects `expires_at <= now` at T-0 with a narrow dep slice and no F4 bridge; its `<= now` boundary is what keeps it disjoint from lapse). Copy the existing **coordinator → worker → use-case** trio + one `vercel.json` line:

- **Coordinator** `src/app/api/cron/renewals/auto-draft-coordinator/route.ts`: `runtime=nodejs`, `force-dynamic`, `export const GET = POST`, `gateCronBearerOrRespond` (constant-time Bearer `CRON_SECRET`), short-circuit → `200 {skipped}` when `!f8Renewals && !autoInvoice` or `readOnlyMode`, fresh `correlationId`, `Promise.allSettled` fan-out per tenant, emit `cron_dispatch_orchestrated` (`cron_kind:'auto_draft'`).
- **Worker** `src/app/api/cron/renewals/auto-draft/[tenantId]/route.ts`: bearer gate, flag guard, `tenantId === env.tenant.slug` else 400, `runInTenant` → new advisory lock `renewals:autodraft:<tenantId>` → `makeRenewalsDeps(tenantId)` (puts the F4 bridge in scope) → use-case → `200` counters.
- **Use-case** `src/modules/renewals/application/use-cases/auto-draft-due-renewals.ts` + barrel export.
- **Schedule** ~05:00 ICT (`0 22 * * *` UTC), placed **before** the 06:00 dispatch chain so the queue is ready for the treasurer's morning and populated before any reminder references a bill. (Deliberately far from the Bangkok Dec-31→Jan-1 seam at 17:00 UTC — though A3 largely neutralises FY-seam risk anyway, since the number is minted at the admin click, not the cron.)

**Eligibility** — new repo method `listCyclesEligibleForAutoDraft(tenantId, {nowIso, leadDaysCalendar, leadDaysRolling, pageSize})` joining `members`:
`status IN ('upcoming','reminded') AND period_to > now AND period_to <= now + leadDays(billing_cycle) AND member NOT archived AND members.auto_invoice_enrolled_at IS NOT NULL AND membership-access ∉ {terminated,suspended} AND NOT EXISTS a live membership invoice for (member, plan_year)`. Because `createNextCycleOnPaid` is wired on this branch, exactly one active cycle exists (the current term); the cron bills **that** cycle for the next window and creates **no** cycle row.

### 5.2 What the cron creates — drafts only
Via a new bridge method **`draftInvoiceForRenewal`** = the `createInvoiceDraft`-half of today's `issueInvoiceForRenewal` (no `issueInvoice` call). Result: **no §87/bill number, no `bill_document_number_raw`, no PDF, no outbox row** — `status='draft'`, `origin='auto_renewal'`, `autoEmailOnIssue` stored **explicit `false`**.
- `renewalSignal.unitPriceSatang` = the current cycle's `frozenPlanPriceThb` (forces `proRateFactor='1.0000'`, suppresses the registration-fee re-bill line).
- `membershipCoverage = {kind:'window', fromIso: cycle.periodTo, toIso: addMonthsUtc(cycle.periodTo, cycle.frozenPlanTermMonths)}` — byte-identical to `confirm-renewal` for both calendar (Jan1→Jan1) and rolling (anniversary→+term). `planYear = deriveFiscalYear(cycle.periodTo)`.

### 5.3 The admin review queue
A **lean surface**: a filtered admin invoices view scoped to `origin='auto_renewal' AND status='draft'` + a renewals-scoped action set. Per row (and bulk-over-selected):
- **Issue + Send** → mints the bill (via `issueAutoDraftedRenewal`, patching `autoEmailOnIssue=true` inside the issue tx → one locale-correct outbox row via `resolveRecipientLocale` to the primary contact; best-effort, empty-recipient skipped-with-warning).
- **Issue silently** (**default**) → mints the bill, leaves `autoEmailOnIssue=false` → member is billed, no email (the norm for members already contacted out-of-band).
- **Discard** → emit `renewal_auto_draft_discarded`, delete the draft (drafts carry no number, so nothing tax-relevant is lost).

The queue surfaces a **price-vs-catalogue drift flag** (§13.5) and a **bill-year (SC issue-FY) ≠ coverage-year** note (§11 FY-boundary).

### 5.4 Idempotency & double-bill avoidance
- **Primary — content-based dedup** in the eligibility query: `NOT EXISTS` a membership invoice for `(member, subject='membership', plan_year)` in `{draft,issued,paid,partially_credited,credited}`. A re-run never mints a second draft and excludes members who already self-renewed. Optional O(1) accelerator `renewal_cycles.auto_draft_invoice_id`.
- Per-run advisory lock `renewals:autodraft` + per-cycle lock + **tx-bound re-read before drafting** (`enter-awaiting`'s proven TOCTOU pattern).
- **On the ISSUE path** — the renewals-side **latch** (also #1 §9 item 2): set `renewal_cycles.linked_invoice_id` in the **same tx** as issue, and **re-read under the cycle lock** for an already-live/paid bill before minting. Void-on-reissue (#1) only voids `status='issued'` and refuses once `paid`, so this pre-issue re-read — **not** the void — is what prevents the *paid-race* double-bill (an active member paying the existing bill concurrently with the issue click).
- **Net:** double-*draft* is possible but harmless (drafts are not tax docs); double-*open-bill* is impossible by construction (latch + re-read + #1 backstop).

### 5.5 Failure handling
- Coordinator `Promise.allSettled` per tenant (one tenant's failure never aborts another). Worker loops eligible cycles with a **per-cycle try/catch around a per-cycle tx** (lock → re-read → draft → `emitInTx`), counting `drafted / skipped_existing / skipped_opt_out / skipped_terminated / errors` and continuing — one bad member cannot poison the batch (ship a throw-path integration test where the bridge rejects mid-batch).
- **The daily re-run IS the retry**: content dedup makes it duplicate-safe, and the **RANGE window** (`period_to <= now + leadDays`) — never a civil-date-exact "Dec 1" gate — **self-heals a missed cron day** instead of skipping a cohort for a year.
- **Zero tax blast radius on crash** (no number allocated, no §87 gap, nothing to roll back). Auth via shared `gateCronBearerOrRespond` (401 + `cron_bearer_auth_rejected` + metric; fail-open on Upstash). Feature-off / read-only → `200 {skipped}`, never `503`, so Vercel does not retry-storm.
- **Stale-draft handling**: a queue staleness indicator + a lightweight **`prune-expired-auto-drafts`** sweep that discards drafts whose cycle has left `upcoming|reminded` (member self-renewed, or lapsed at due+60 ≈ 90 days after a T-30 draft).

### 5.6 Cadence (config, not hardcode)
`tenant_invoice_settings`: `auto_invoice_lead_days_rolling INT DEFAULT 30`, `auto_invoice_lead_days_calendar INT DEFAULT 31` (`CHECK 1..120`), `auto_invoice_page_size INT DEFAULT 200` (MTA-ready). `billing_cycle` drives **WHEN only** (per-cadence lead-days lookup), never **WHAT** — the window always comes off the current cycle's `period_to`. Calendar members share `period_to ≈ Jan 1` so `leadDays ≈ 31` naturally batches the cohort ~Dec 1; rolling members drip individually at T-30. A self-healing **range** window, never a fixed civil date.

### 5.7 Enrollment / dark-ship (three-key, all default-off)
1. **`FEATURE_AUTO_INVOICE`** env flag (zod, default `false`, **independent** of `FEATURE_F8_RENEWALS` so it can be flipped/killed alone).
2. **`tenant_invoice_settings.auto_invoice_enabled BOOLEAN DEFAULT false`**.
3. Per-member **`members.auto_invoice_enrolled_at TIMESTAMPTZ NULL`** (opt-in; `NULL` = never drafted).

**Opt-in for the first cohort** (positive enroll) — even though A3's human review would make loose opt-out defensible, start conservative given the 0-email discipline + relationship model; loosening to opt-out is a later decision (§13.3). The **membership-state gate** (terminated/suspended) lives in the eligibility query **AND** is re-asserted inside `issueAutoDraftedRenewal` — the F4 issue path has no such gate and the record-payment gate fails open, so this is defense-in-depth, never query-only.

### 5.8 Interaction with `confirm-renewal` + `admin-renew-lapsed-member`
**Coexist, not replace** — all collisions arbitrated at the shared F4 issue chokepoint:
- **`confirm-renewal`** (member self-service) stays the self-service fast lane + the pay action + the **plan-change-at-renewal** path. If a member self-renews after a draft exists, dedup stops re-drafts and #1's draft-discard extension cleans the orphan; if the cron runs after a self-renew, `NOT EXISTS` already excludes them — either order is safe. Recommended (correctness does not depend on it): `confirm-renewal` short-circuits to *"pay your existing bill"* when a live linked bill exists (removes SC-number churn + double-email).
- **`admin-renew-lapsed-member`** (comeback) operates only on lapsed/terminal cycles — disjoint from auto-draft's `upcoming|reminded` eligibility; no race. After reactivation, its payment spawns the next cycle, which the cron then picks up at its own T-30.
- **Critical boundary:** the queue-issue action MUST be the renewals use-case `issueAutoDraftedRenewal`, **not** the generic F4 admin "issue draft" button — the F4 module cannot touch `renewal_cycles`, so only the renewals use-case can set `linked_invoice_id`, preserve `createNextCycleOnPaid`, fire void-on-reissue, and re-check the terminated gate.

Net: auto-draft owns the bulk happy path; `confirm-renewal` the self-service/plan-change lane; `admin-renew-lapsed` the comeback lane — all feed one F4 mint point.

### 5.8a F8 reminder-stream coordination (ladder + due-track) — **live in prod**
`FEATURE_F8_RENEWALS` is **`true` in production** (confirmed 2026-07-17), so two member-facing reminder streams already send and must be coordinated with auto-invoice **before #2 ships**:
- **Ladder** (tier×offset, anchored on `expires_at`, daily 06:00 ICT, respects per-member opt-out): a generic "renew" nudge that references **no specific invoice**. It overlaps auto-draft's ~T-30 window but is **not** a double-email (auto-draft is silent); a member self-serving off the ladder CTA is made safe by the eligibility dedup + #1's draft-discard extension.
- **Due-track** (due+7 / due+30, anchored on the **bill `due_date`**, `awaiting_payment` cycles only, **ignores opt-out** — contractual): references an **invoice**. A `draft` never triggers it (no issued bill; cycle still `upcoming|reminded`), so auto-draft **cannot** produce a "your invoice is overdue" email for a bill that does not exist.
- **Required handoff (the tune, a ship requirement):** `issueAutoDraftedRenewal` must move the cycle `upcoming|reminded → awaiting_payment`, **and a new ladder gate must stand the ladder down when the cycle has a live unpaid membership bill** — so the member is dunned by exactly **one** stream: *ladder before a bill exists → due-track after*. This new gate also cleans up the **pre-existing 066 double-track** that already fires ladder + due-track together on `confirm-renewal`-issued bills today — so it is a small **global** improvement, not auto-invoice-only. (Today the ladder skips only on an *unreconciled paid* invoice, not on an issued-but-unpaid one — that is the exact gate to add.)

### 5.9 Email policy
Per-action, **default silent** (§13.2). The cron enqueues **zero** email (drafts have no outbox). The draft stores `autoEmailOnIssue=false` **explicitly, never null** — `issueInvoice` resolves `draft.autoEmailOnIssue ?? settings.autoEmailEnabled`, and `auto_email_enabled` defaults **true**, so a null would silently email. "Issue + Send" is the only path that sets `true`, inside the issue tx.

### 5.10 Price freshness
Bill the **current cycle's frozen price** (faithful to `confirm-renewal`), and **surface a drift flag** in the queue when it differs from the live catalogue price so the treasurer can catch a dues change before issuing (§13.5). No silent re-snapshot.

---

## 6. Architecture & boundaries (Principle III)

- New renewals machinery: two cron routes; use-cases `auto-draft-due-renewals` (the cron worker's body) + `issueAutoDraftedRenewal` (the queue action — the renewals use-case that owns `renewal_cycles`); repo `listCyclesEligibleForAutoDraft`. These call two new **bridge** methods: `draftInvoiceForRenewal` (the `createInvoiceDraft`-half, called by the cron) and `issueExistingDraftForRenewal` (the `issueInvoice`-half for a pre-existing draft, called by `issueAutoDraftedRenewal`). Naming: the *use-case* is `issueAutoDraftedRenewal`; the *bridge method* it calls is `issueExistingDraftForRenewal`.
- F4 is reached **only** via the already-wired `f4InvoicingForRenewalBridge` leaf-factory (Principle III honored); the F4 supersede lives in F4 (#1). The renewals-side latch writes `renewal_cycles` (renewals-owned) — F4 must **not** write renewal tables.
- The review surface is a **filtered invoices view + renewals-scoped action**, not a new module or read-model.
- **Zero new npm deps.** Apply migration + `pnpm test:integration` on live Neon **before** committing schema (F4 R8 gotcha); author the failing money-path integration test first (Principle II).

---

## 7. Data / schema impact

- `invoices.origin invoice_origin pgEnum('manual','auto_renewal') DEFAULT 'manual'` (lighter alternative: nullable `invoices.auto_drafted_at`).
- Optional `renewal_cycles.auto_draft_invoice_id uuid NULL` (dedup accelerator + queue join).
- `members.auto_invoice_enrolled_at TIMESTAMPTZ NULL` (opt-in).
- `tenant_invoice_settings`: `auto_invoice_enabled BOOL DEFAULT false` + `auto_invoice_lead_days_rolling/_calendar` + `auto_invoice_page_size`.
- Env: `FEATURE_AUTO_INVOICE` in `src/lib/env.ts` zod schema (no new secret — `CRON_SECRET` shared).
- Audit (4-places: domain const + pgEnum + 2 count tests): **`renewal_auto_drafted`** + **`renewal_auto_draft_discarded`**; admin issue reuses `invoice_issued`; the void backstop reuses #1's `invoice_voided` + `supersededByInvoiceId`; `cron_kind` gains `'auto_draft'` (reuse an existing kind's `kind_specific` shape to limit taxonomy churn).
- **No** new renewal-cycle status; **no** new invoice status; `document_type` already has `bill`.

---

## 8. Audit & observability

- Per-draft **`renewal_auto_drafted`** (member, cycle, plan_year, frozen price, coverage window, `correlationId = auto-draft:<cycleId>:<runId>`). One **`cron_dispatch_orchestrated`** per run (`cron_kind:'auto_draft'`, counters + `tenants_succeeded/failed`). Admin issue → `invoice_issued` (+ `invoice_voided`/`supersededByInvoiceId` when superseding); discard → `renewal_auto_draft_discarded`.
- Gauges (reuse the dispatch-coordinator `observeCycleStateGaugesForTenant` best-effort per-tenant pattern): `auto_draft.drafts_created / _skipped{reason} / _errors`, and the two **operational-safety-net** metrics — **`auto_draft.pending_queue_size`** AND **oldest-unreviewed-draft-age**. **Alert** if any auto-draft exceeds N days or the queue exceeds a threshold near the Dec-1 batch — the standing mitigation for the single-admin bus-factor.
- Runbook `docs/runbooks/cron-jobs.md`: add the coordinator to the job catalogue + the authoritative `vercel.json` mapping, the SC-year ≠ coverage-year note, and the three-key enable procedure. Structured logs, `correlationId` threaded, member-id hashed, forbidden fields unchanged.

---

## 9. Dependency on Sub-project #1 (the two hard requirements)

Sub-project #1 (`106-void-on-reissue`) must land first, and — per this design — with two properties #1's spec now carries:

1. **Void at the F4 `issueInvoice` mint point** (done in #1's revised spec). A3 issues pre-existing drafts through `issueAutoDraftedRenewal`, a *different* entry point than the create-and-issue wrapper; had #1 stayed in the bridge wrapper, this path would bypass the void and two open §-era bills could coexist. **Ship blocker; add an integration test asserting the existing-draft issue path fires the void.**
2. **Draft-discard extension** — void-on-reissue voids `status='issued'` only; A3 must **also discard stale `status='draft'` membership invoices** for the same `(member, plan_year)` when a bill is issued (orphan auto-drafts from a member-self-renew race). This is a **#2-scoped** extension of the same F4 invariant.

Plus the **paid-race latch** (§5.4) is a #2 addition (renewals-side), because void-on-reissue structurally cannot cover the concurrently-paid case. Note: the mint-point placement is adopt-regardless per three lenses, so it retires A3's biggest architectural objection; and because the cron mints no number under any flag, A3's **cron side** is uniquely robust to an 088 regression — but that does **not** remove the #1 dependency on the **issue** side.

---

## 10. Testing (TDD, failing-first; integration on live Neon)

1. **Cron drafts due members** — enrolled member, `period_to` inside leadDays → one `draft` with `origin='auto_renewal'`, correct window + frozen price, `autoEmailOnIssue=false`, **no number, no PDF, no outbox row**.
2. **Dedup** — re-run the cron → no second draft; a member with an existing live membership invoice for the plan_year is skipped.
3. **Not enrolled / terminated / archived** — excluded by the eligibility query.
4. **Issue silently** — admin issues a draft → number minted, `linked_invoice_id` set, `createNextCycleOnPaid` wiring intact, **zero** outbox rows.
5. **Issue + Send** — exactly **one** locale-correct outbox row; empty-recipient → skipped-with-warning.
6. **Discard** — `renewal_auto_draft_discarded` emitted, draft gone, nothing tax-relevant lost.
7. **Void-on-reissue fires on the existing-draft issue path** (the #1 §9-item-1 blocker) — issuing an auto-draft supersedes the member's prior `issued` bill.
8. **Paid-race latch** — existing bill paid concurrently with issue → the pre-issue re-read prevents a second open bill (integration test).
9. **Batch isolation** — bridge rejects mid-batch → other members still drafted; counters correct.
10. **Missed-day self-heal** — skip a cron day → next run still drafts the cohort (range window).
11. **Cross-tenant** — eligibility + issue are tenant-scoped (RLS + explicit filter); a peer tenant is never drafted/issued.
12. **Flag-off / read-only** → `200 {skipped}`, nothing created.
13. **Reminder handoff (F8 live)** — a `draft` (pre-issue) triggers **neither** an invoice-referencing ladder nudge **nor** due-track (cycle still `upcoming|reminded`, no bill). After `issueAutoDraftedRenewal`, the cycle is `awaiting_payment` and the expiry-anchored ladder no longer fires for it (the new live-unpaid-bill gate); due-track owns post-bill dunning — exactly one stream.

---

## 11. Risks + mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| #1 placement dependency (issue-existing-draft bypasses void) | **high** | Resolved in #1's revised spec (F4 mint point) + a test asserting the draft-issue path fires the void; ship-block A3 until satisfied. |
| Single-admin bus-factor / unworked queue near the Dec-1 batch | **high** | `pending_queue_size` + oldest-draft-age gauges + age-based alert; `prune-expired-auto-drafts` sweep; documented treasurer cadence. A slightly delayed invoice at an out-of-band chamber ≪ a wrong auto-sent bill. |
| Terminated/suspended member auto-billed (F4 issue has no gate; payment gate fails open) | **high** | Membership-state gate in the eligibility query **and** re-asserted inside `issueAutoDraftedRenewal`; plus `status IN (upcoming,reminded)`. |
| `billing_cycle` over-marking (0255 mis-marks some Jan-first-payment rolling members as calendar) | medium | **Mandatory admin-review pass before enabling** (§12 Phase 1); A3 de-risks — a human reviews every draft and discards a wrong-cadence row before any number is minted. |
| Accidental email at issue (silent path must persist `false`; a slip re-inherits tenant `true`) | medium | Store explicit `false` at draft creation; default the action to silent; integration-test both actions assert exactly-one vs zero outbox rows. |
| Frozen-price staleness industrialised (rubber-stamped "Issue all" after a dues change) | medium | Price-vs-catalogue **drift flag** in the queue; keep frozen faithful but visible; treat "Issue all" as reviewed, not blind. |
| Over-build vs 110-member scale | medium | Lean review surface (filtered invoices view + renewals action), reuse existing rendering; `auto_draft_invoice_id` + prune cron are optional v1 levers. |
| FY-boundary click timing (Dec-31→Jan-1 scatters SC-YYYY across two FY) | low | Surface bill-year ≠ coverage-year in the queue + runbook; issue the December batch before year-end. A3 already removes the *cron*-timing seam (number minted at the click). |
| **Reminder double-track** — F8 ladder (expiry) + due-track (bill-due) both fire on an issued unpaid bill; `FEATURE_F8_RENEWALS` is **ON in prod**, and auto-invoice makes issued bills more frequent | medium | The §5.8a handoff: `issueAutoDraftedRenewal` moves the cycle → `awaiting_payment`, and a **new ladder gate** stands the ladder down when a live unpaid membership bill exists → exactly one dunning stream. Pre-existing 066 behaviour; this is a global cleanup, and a **ship requirement** for #2. |

---

## 12. Rollout phases

0. **Ship dark** — land `FEATURE_AUTO_INVOICE=false` + all migrations on the dev Neon branch; author the failing money-path integration tests first and green them on live Neon; confirm #1 is at the F4 mint point **and** extended to discard stale drafts, with a test proving the issue-existing-draft path fires the void.
1. **Data prerequisite** — run the mandatory `billing_cycle` admin-review pass to correct over-marked calendar members before any cron consumes the column.
2. **Shadow** — flip per-tenant `auto_invoice_enabled` with a 2–3 member opt-in pilot (or zero enrolled); verify the queue populates with correct window/price, zero emails enqueued, dedup + membership-state gate behave, gauges report.
3. **Opt-in cohort** — enroll the calendar cohort ahead of a real ~Dec 1 batch; the treasurer works the queue with Issue+Send / Issue silently / Discard; monitor queue-age alerts + the prune sweep through a full batch.
4. **Steady state** — expand opt-in toward full membership (or flip to opt-out only if the human-review model has proven reliable — §13.3), keeping the queue-age alarm as the standing safety net.

---

## 13. Resolved decisions (the five forks)

1. **Core stance** → **A3 auto-draft + admin review.** (vs A2's burned-number/void-churn, A1's auto-send blast radius.)
2. **Email** → **per-action, default "Issue silently"**; `autoEmailOnIssue=false` stored explicit on the draft.
3. **Enrollment** → **opt-in for the first cohort** (`members.auto_invoice_enrolled_at`); revisit opt-out later once the review model is proven.
4. **Cadence** → **per-tenant config columns** (rolling 30 / calendar 31 / page_size 200) with a self-healing **range** window, never a fixed civil date.
5. **Price** → **bill the frozen price, surface a drift flag** in the queue (no silent re-snapshot).
