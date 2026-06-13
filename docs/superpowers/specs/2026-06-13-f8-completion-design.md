> **Status:** brainstorming design DRAFT (2026-06-13) — for maintainer review before writing-plans. Produced from a 5-agent code-grounded investigation (workflow wylnuwq4i). Closes the F8 renewal-flow gaps (task #54).

# F8-completion — renewal-flow wiring — design

## Problem (the unwired boundaries)

F8 Renewal Tracking shipped the cycle-tracking schema, the SAFE/CAS transition primitive, the reminder dispatcher, the F4↔F8 invoice bridge, the F5 paid→complete callback, and three race-safe admin use-cases — but several F4↔F8 boundaries were never connected, so the renewal pipeline is **inert end-to-end**. Confirmed by code: **(B2)** no production writer ever calls `cyclesRepo.insert` (`drizzle-renewal-cycle-repo.ts:367`) — zero `upcoming` cycles exist; **(B1)** no writer transitions a cycle to `awaiting_payment` (`grep "to: 'awaiting_payment'"` = 0 hits), yet `confirm-renewal.ts:182` and `mark-cycle-complete-from-invoice-paid.ts:136` both *require* that status, so self-service confirm + invoice-paid-completion are dead on arrival; **(B3)** `adminReactivateLapsedCycle` / `adminRejectReactivation` are implemented, race-safe, and barrel-exported (`index.ts:557,565`) but have no API route + no UI; **(G4)** `/portal/renewal/[memberId]/page.tsx:218` renders `<RenewalConfirmFlow>` for any active cycle with no `summary.status` payability gate (pure UX dead-end — server gate at `confirm-renewal.ts:182` is intact); **(G5)** `transitionStatus` (`drizzle-renewal-cycle-repo.ts:768`) enforces only the optimistic `WHERE status = from` CAS, never `canTransition`, and the domain `TRANSITIONS` map is missing two real edges; **(G6)** a dead `'grace'` literal in the dispatch-candidate status filter (`drizzle-dispatch-candidate-repo.ts:258`) that no DB row can ever match. Separately, a **tax-compliance contradiction**: `confirm-renewal` bills F4 from the *live* F2 catalogue price (`create-invoice-draft.ts:145`), not the cycle's frozen price, violating FR-022 — the portal shows the frozen price but the §86/4 invoice can bill a different live price. **None of these are live production bugs — the system is pre-launch; these are completeness gaps that must close before F8 can function.**

## Goals

1. A production writer **creates** an `upcoming` renewal cycle (steady-state on prior-cycle-paid; bootstrap for first-time/existing members) with a **frozen** price snapshot.
2. A production writer **advances** `upcoming|reminded → awaiting_payment` so the confirm + paid-completion paths become reachable.
3. Admin **reactivate / reject** for `pending_admin_reactivation` cycles are reachable: API routes + cycle-detail UI + a discovery surface.
4. The portal renewal page **gates** the Confirm CTA on payability (no enabled-button-that-always-409s).
5. The cycle state machine is **authoritative**: `transitionStatus` enforces `canTransition`, the `TRANSITIONS` map declares every real edge, and the dead `'grace'` arm is removed.
6. The §86/4 renewal invoice **bills the frozen price** the member was shown (FR-022), not the live catalogue.
7. Every new audit event lands in all 4 required sites; every new cross-tenant + tax invariant is covered by an integration test against live Neon.

## Non-goals (YAGNI)

- **Multi-year (>12mo) renewal invoicing** and **non-THB renewal cycles** — F4 is THB-only and `plan-lookup-for-renewal-drizzle.ts` hardcodes `termMonths:12`/`currency:'THB'`. Constrain renewals to 12-month THB cycles for launch; multi-year is a separate spec (see Open Questions).
- **Converging the `pending_admin_reactivation` terminal states** (reject→`cancelled` vs timeout→`lapsed`). Recommend **document the split as intentional**, do not change member-visible lifecycle/funnel behaviour (changes at-risk + lapsed-tab bucketing).
- **A `blockAutoReactivation` admin UI** — sibling gap to B3; scope it explicitly but it is not required for the core renew journey (only for the admin-blocked branch). Flag for the maintainer.
- **Invoice-at-cycle-creation** — tax-dangerous (phantom §86/4 + §87-number / credit-note churn). Keep issuance at confirm; only snapshot price at creation.
- **Reworking the reminder dispatcher to write `reminded`** — out of scope unless the maintainer wants `reminded` in the active lifecycle (see Open Questions); the new writers treat `reminded` as a valid `from` either way.
- Pro-rate / registration-fee redesign beyond suppressing them for renewals.

## Design decisions

| Decision | Chosen option | Why |
|---|---|---|
| Steady-state cycle creation | **A — 3rd `f8OnPaidCallbacks` entry** `createNextCycleOnPaidInTx` (after completion + tier-upgrade) | Atomic with the just-completed cycle in F4's tx; reuses the live, tested paid seam (`renewals-deps.ts:469`, wired at `payments/infrastructure/di.ts:67`); matches `data-model.md:96` "created when previous cycle paid"; `getEffectivePlanForRenewal` + `planLookupForRenewal` + `scheduledPlanChangeRepo` are already injected for exactly this. |
| First-time / existing-member creation | **D — `createMember` post-commit best-effort listener** + one-off backfill script for the 131 existing SweCham members | Covers the "first-time member" arm A can't; mirrors `change-plan.ts:63` `manualPlanChangeListeners` precedent. Backfill is mandatory cold-start (zero cycles exist today). |
| → `awaiting_payment` writer | **C — BOTH: a T-0 expiry cron (baseline) + lazy self-transition in `confirm-renewal`** | Cron feeds the lapse pipeline + grace dashboard for no-action members; lazy confirm-transition lets members renew early in the reminder window (the reminder emails embed a renewal CTA at `dispatch-one-cycle.ts:1157`). Both go through the CAS guard + advisory lock → idempotent, race-safe. Satisfies *both* spec sources (data-model T-0 diagram AND FR-022 confirm-transitions text). |
| Admin reactivate / reject wiring | **Two cycleId-scoped POST routes** (`/reactivate` no-body, `/reject` with `reason`) + cycle-detail actions component + a status-filtered "Pending review" discovery tab | Matches the established one-route-per-action F8 convention (`cancel`, `mark-paid-offline`, `send-reminder-now`); reuses `requireRenewalAdminContext`, `errorResponse`/`successResponse`, and the cancel/mark-paid skeletons verbatim. |
| Portal payability gate (G4) | **Server-side branch on `summary.status`**: render `<RenewalConfirmFlow>` only for `awaiting_payment`; status-specific read-only card otherwise | Cheap, presentation-only, mirrors the existing `summary.isFirstTimeRenewer` branch (`page.tsx:179`). `summary.status` is already returned (`load-renewal-summary.ts:67`). |
| State-machine hardening (G5) | **Complete the `TRANSITIONS` map (+`pending_admin_reactivation→lapsed`, +`upcoming→completed`) THEN enforce `assertCanTransition` in `transitionStatus`** | The map is missing two edges real writers use (reconcile-timeout + offline-mark of `upcoming`); enforcing without first completing the map would throw `invalid_transition` on those live paths. Defense-in-depth + documentation-as-code on a money path. |
| Dead `'grace'` arm (G6) | **Remove the literal + fix the misleading comment** | Provably dead (DB CHECK `0087:90-99` rejects `'grace'`; not in `CYCLE_STATUSES`). Grace inclusion is already achieved by the date window (`dispatch-candidate-repo.ts:260`). Sibling list at `drizzle-renewal-cycle-repo.ts:808` is already correct. |
| Frozen-price billing (tax) | **Add a `unitPriceSatang` override to F4's membership-invoice path; thread `frozenPlanPriceThb` from the cycle through the bridge** | FR-022 mandates "frozen price, NOT live F2 plan prices"; portal shows frozen, invoice currently bills live → price-shown ≠ price-billed on a §86/4 document. The event path (`createEventInvoiceDraft`) already proves the caller-supplied-price pattern. |
| Renewal pro-rate / reg-fee | **Renewals always proRate `1.0`, never re-add `registration_fee`** | `create-invoice-draft.ts:161-170,205` re-derives pro-rate + can re-bill the one-off reg fee — wrong for an existing member's renewal. |
| **OPEN** — first cycle's period anchor for existing members | **OPEN — maintainer call** | `members` has no `expires_at`; `registrationDate` is a join-date, `planYear` is a calendar year. Backfill must set each member's first `period_to` explicitly. Launch-blocking data question. |
| **OPEN** — `awaiting_payment` audit ownership (cron vs confirm double-emit) | **OPEN — maintainer call** | Decide whether `renewal_entered_awaiting_payment` emits from both writers or cron-only. |
| **OPEN** — multi-year / non-THB scope-out vs support | **OPEN — maintainer call** | Recommend scope-out for launch (see Non-goals). |

## Architecture

### A. Renewal-cycle creation (F4 hook → `upcoming`)

**Steady-state (on prior-cycle-paid):** add a 3rd callback to the array returned by `f8OnPaidCallbacks` at `renewals-deps.ts:469` (currently `[markCycleComplete… , makeApplyTierUpgradeOnPaidCallback]`). New use-case `create-next-cycle-on-paid.ts`:

- Resolve the just-paid cycle: `cyclesRepo.findByInvoiceIdInTx(tx, tenantId, evt.invoiceId)` (`drizzle-renewal-cycle-repo.ts:450`). No-op if absent.
- **Idempotency guard (must run AFTER callback[0] flips prior→`completed`):** call `cyclesRepo.findActiveForMember` — if a non-terminal cycle already exists for the member, **no-op** (do not insert-and-catch; the partial-unique index `renewal_cycles_active_member_uniq`, migration `0087:170` would otherwise throw and roll back the payment).
- Derive `periodFrom = prior.periodTo` (gapless — recommended), `periodTo = periodFrom + prior.cycleLengthMonths`.
- Resolve the effective plan: `getEffectivePlanForRenewal` (`plans/application/get-effective-plan-for-renewal.ts:41`, docstring: "Called from F4's renewal-invoice-creation hook at cycle-creation time") → `makeDrizzlePlanLookupForRenewal.loadPlanFrozenFields` (`plan-lookup-for-renewal-drizzle.ts:49`) returns `{tierBucket, priceTHB, termMonths, currency}` — the exact `NewRenewalCycleInput` frozen columns.
- `cyclesRepo.insert(tx, tenantId, NewRenewalCycleInput)` (`drizzle-renewal-cycle-repo.ts:367`; input shape `renewal-cycle-repo.ts:22-36`).
- Emit `renewal_cycle_created` (payload shape already defined `renewal-audit-emitter.ts:261`).
- **Non-throwing discipline:** mirror callbacks [0]/[1]'s try/catch + `INVALID_TX` fallback (`renewals-deps.ts:527-611`) — a creation bug must not roll back the member's payment.

**Reusable to call:** `cyclesRepo.insert` · `findByInvoiceIdInTx` · `getEffectivePlanForRenewal` · `makeDrizzlePlanLookupForRenewal` · `markCycleCompleteInTx` (`mark-cycle-complete-from-invoice-paid.ts:118`) as the InTx-callback precedent.

**Ship `renewal_cycle_created`:** add to `F8_ENUM_SHIPPED_TUPLE` (`drizzle-renewal-audit-emitter.ts:67`) + a new `ALTER TYPE … ADD VALUE 'renewal_cycle_created'` migration + the **4-place** audit-count updates (domain const + pgEnum + `audit-event.test.ts` + `completeness.test.ts`). **Apply the migration + run integration BEFORE the emit site ships** (the new pgEnum value is invisible to unit mocks; emitting pre-migration falls through to pino-only → silent audit gap).

**First-time / bootstrap (option D):** post-commit best-effort listener on `create-member.ts:144` (pattern: `change-plan.ts:63-89`). + a one-off backfill script for the 131 existing members (uses the maintainer's chosen period anchor — OPEN).

### B. → `awaiting_payment` transition

`canTransition(upcoming|reminded, awaiting_payment)` is **already true** (`cycle-status.ts:88-89`); the eligibility index already covers the status (`0087:164`). No domain or index change.

**B-cron (baseline T-0 writer):** new use-case `enter-awaiting-payment-on-expiry.ts` — **clone `lapse-cycles-on-grace-expiry.ts` 1:1** (per-cycle advisory lock + tx re-read via `findByIdInTx` + `transitionStatus({from: actualStatus, to: 'awaiting_payment'})` + emit-in-tx + per-cycle fault isolation). New repo method `listCyclesEligibleForAwaitingPayment(tenantId,{nowIso,pageSize})` — clone `listCyclesEligibleForLapse` (`drizzle-renewal-cycle-repo.ts:689`), `WHERE status IN ('upcoming','reminded') AND expires_at <= now`, order `expires_at ASC`. New cron route pair under `src/app/api/cron/renewals/enter-awaiting-payment/[tenantId]/route.ts` + coordinator — copy the lapse-cycles route pair verbatim (`gateCronBearerOrRespond` + kill-switch + `READ_ONLY_MODE` short-circuit + `Promise.allSettled` fan-out). Schedule entry in `docs/runbooks/cron-jobs.md`.

**B-lazy (early renewal):** in `confirm-renewal.ts:182`, change the reject-on-non-`awaiting_payment` to: if `status ∈ {upcoming,reminded}` → `transitionStatus(tx, …, {from: status, to: 'awaiting_payment'})` inside the Step-1 `runInTenant` tx it already opens (`confirm-renewal.ts:140`); **idempotent** when already `awaiting_payment` (treat as success, NOT `cycle_not_payable`). The CAS guard + advisory lock resolve cron-vs-confirm and confirm-vs-confirm races to a single `awaiting_payment` row; the loser sees `CycleTransitionConflictError` and re-reads.

**New audit `renewal_entered_awaiting_payment`** — 4-place landing (same discipline as A). Audit ownership (both writers vs cron-only) is **OPEN**.

**Use `<= now` for the T-0 flip** vs `< now - grace` for the lapse cron — chosen consistently so a cycle is never simultaneously eligible for both in one pass.

### C. Admin reactivate / reject (routes + UI)

Both use-cases take production `deps` directly — **the stale docstrings claiming `f5RefundBridge` "not yet wired into RenewalsDeps default factory" are wrong** (`renewals-deps.ts:373,385,391` all wired; `RenewalsDeps ⊇ AdminRejectReactivationDeps`).

- **`POST /api/admin/renewals/[cycleId]/reactivate`** (NEW, no body) — copy `cancel/route.ts`: kill-switch → `requireRenewalAdminContext(request,'write')` → `resolveTenantFromRequest` → `makeRenewalsDeps` → `adminReactivateLapsedCycle(deps, {…})` → error switch: `cycle_not_pending`→409 `{current_status}`, `cycle_not_found`→404, `invalid_input`→400, `server_error`→500.
- **`POST /api/admin/renewals/[cycleId]/reject`** (NEW, body) — copy `mark-paid-offline/route.ts`: `BodySchema = z.object({reason: z.string().trim().min(1).max(500)})` → `adminRejectReactivation(deps, {…,reason})` → switch adds `refund_failed`→502, `cycle_missing_invoice`→409. Success returns `{cycle_status, closed_reason, refund_credit_note_id}` (**may be null** — `no_payment_found` path; UI must render the no-refund case distinctly). **Add a per-(tenant,admin) rate-limit (30/5min, like `send-reminder-now`)** to bound double-click refund storms; do **not** add route-level retry (the refund is two-tx outside the F8 tx — retry could double-attempt).
- **RBAC:** reject issues a refund → `action='write'` (admin-only), **not** `manager_exception`. Security-sensitive (payment/refund) → ≥2 reviewers, one signs the security checklist.
- **Cycle-detail actions** — replace the empty PageHeader actions comment (`[cycleId]/page.tsx:335-348`) with `<PendingReactivationActions cycleId status={c.status} />`, rendered **only when `c.status === 'pending_admin_reactivation'`** (the pending Alert already exists at `page.tsx:356`). New client component: two buttons + dialogs (mirror `outreach-dialog.tsx` fetch + toast); reject = `AlertDialog` (destructive, explicit "this issues a refund" copy) with required `reason` textarea; reactivate = plain confirm. `sonner` toast + `router.refresh()` on success. **Hide for managers** (avoid a broken affordance).
- **Discovery surface** — a "Pending review" status-filtered tab on the pipeline calling `cyclesRepo.list({statusFilter:['pending_admin_reactivation']})` (already used at `reconcile-pending-reactivations.ts:242`). Whether to ship this list vs deep-link-only is **OPEN** (the page's own comment defers it).
- **i18n** — button labels, confirm copy, success/error toasts under `admin.renewals.*` in en/th/sv (page already uses `admin.renewals.cycleDetail.pendingNotice*`).

**Reachability caveat (G3):** `pending_admin_reactivation` is only reachable via `holdForAdminReview` (`mark-cycle-complete-from-invoice-paid.ts:279`), which fires only when the member is `blocked_from_auto_reactivation` AND a cycle in `awaiting_payment` is paid. So **C is unreachable until B lands** (no `awaiting_payment` writer) **and a `blockAutoReactivation` UI exists**. Treat **B1 + B3 + block-UI as one shippable slice** or C ships as dead code.

### D. Portal payability gate + domain-map hardening

- **G4** — at `page.tsx:216-227`, branch on `summary.status`: render `<RenewalConfirmFlow>` only for `awaiting_payment`; for `upcoming|reminded` show a read-only "renewal window not yet open / reminder pending" card; for `pending_admin_reactivation` show an "awaiting admin verification" notice. The server gate (`confirm-renewal.ts:182` → 409 → `errorCycleNotPayable`) stays the security backstop. New i18n keys under `portal.renewal` in en/th/sv (th mandatory — missing key → runtime `MISSING_MESSAGE`). **Note for reviewers:** until B lands, the `awaiting_payment` branch is unreachable, so this correctly renders the not-yet-payable state for all members — that is correct, not "renewal is broken."
- **G5** — in `cycle-status.ts:87-103` add `pending_admin_reactivation: ['completed','cancelled','lapsed']` and `upcoming: [...,'completed']` (offline-mark of an `upcoming` cycle via `mark-paid-offline.ts` `PAYABLE_STATUSES={'awaiting_payment','upcoming'}`). **Then** call `assertCanTransition(args.from, args.to)` in `transitionStatus` before building the setClause (`drizzle-renewal-cycle-repo.ts:727`), throwing a domain-mapped error. Verify against **live Neon (integration)**, not mocks, since this sits inside F4/F5 paid + refund transactions (a wrong throw aborts a money tx). Edge inventory already audited: the only two undeclared real edges are `pending_admin_reactivation→lapsed` (reconcile-timeout `reconcile-pending-reactivations.ts:696`) and `upcoming→completed` (offline-mark) — both must be added in the same patch.
- **G6** — drop `,'grace'` from `dispatch-candidate-repo.ts:258` and fix the comment at lines 255-256 to say grace inclusion is via the `expires_at >= NOW() - maxOffsetDays` window. Cross-check `drizzle-renewal-cycle-repo.ts:808` (already correct).
- **Terminal-state divergence** — **document** reject→`cancelled` / timeout→`lapsed` as intentional (explicit refusal vs passive expiry) in `cycle-status.ts` + data-model; do not converge (converging shifts members between at-risk/lapsed reporting buckets — `drizzle-renewal-cycle-repo.ts:347` short-circuits urgency on `status='lapsed'`).

## Complete user journeys (now end-to-end)

**(1) Normal renew (steady-state, member self-service)**

1. Member's prior cycle was paid → **[NEW A]** `createNextCycleOnPaidInTx` inserts an `upcoming` cycle with frozen price, atomic in the prior payment's F4 tx.
2. Reminder cron dispatches T-90…T-7 emails *(existing dispatcher)* — email CTA links to the renewal page *(existing `dispatch-one-cycle.ts:1157`)*.
3. At/after expiry, **[NEW B-cron]** `enterAwaitingPaymentOnExpiry` flips `upcoming|reminded → awaiting_payment` — OR the member clicks the CTA earlier and **[NEW B-lazy]** `confirm-renewal` self-transitions to `awaiting_payment` in its Step-1 tx.
4. Member opens `/portal/renewal/[memberId]` → **[NEW G4]** page renders the Confirm flow only because status is `awaiting_payment` (otherwise a read-only not-yet-open card).
5. Member confirms → `confirm-renewal` issues the §86/4 invoice via the bridge, **[NEW tax]** billing the cycle's **frozen** price (override), pro-rate `1.0`, no reg-fee.
6. Member pays *(existing F5/F4)* → invoice_paid → callback[0] `markCycleComplete` flips `awaiting_payment → completed` *(existing)* → **[NEW A]** callback[2] creates the *next* `upcoming` cycle. Loop closes.

**(2) Lapsed → admin reactivation**

1. Admin sets `blocked_from_auto_reactivation` on a member *(use-case exists; **block-UI is a flagged sibling gap**)*.
2. Member's lapsed cycle reaches `awaiting_payment` **[NEW B]** and the member/admin pays it.
3. invoice_paid → `holdForAdminReview` *(existing)* transitions `awaiting_payment → pending_admin_reactivation`.
4. **[NEW C-discovery]** Admin sees the cycle in the "Pending review" tab → opens cycle-detail.
5. **[NEW C-UI]** Admin clicks **Reactivate** → `POST /reactivate` → `adminReactivateLapsedCycle` → `pending → completed` / `admin_reactivated`. **OR Reject** → `POST /reject` (reason required) → `adminRejectReactivation` issues the F5 refund + `pending → cancelled` / `admin_rejected_with_refund` + `post_refund_review` task. UI distinguishes refund-issued vs no-refund (`refund_credit_note_id` null).
6. If no admin acts within 30 days → reconcile cron *(existing, live)* `pending → lapsed` / `pending_reactivation_timed_out`.

## Tax / compliance constraints (Thai §86/4 / §87)

- **Frozen price must equal shown price.** The issued §86/4 (ใบกำกับภาษี) MUST bill `frozen_plan_price_thb` (FR-022, `spec.md:256`), not the live F2 catalogue. Today it bills live (`create-invoice-draft.ts:145`) → a tenant editing a plan mid-cycle creates a tax-document amount that diverges from what the member agreed to (a §86/10 credit-note correction problem). The frozen-price override closes this.
- **Issue at confirm, never at cycle-creation.** A §86/4 with an allocated §87 number must not exist before the member commits to renew — early issuance creates phantom tax documents + gapless-stream pollution for every member who lapses instead of renewing (§87 RD audit liability). Snapshot price at creation; consume a §87 number only at confirm.
- **§87 gapless numbering untouched.** The advisory-locked allocator (`postgres-sequence-allocator.ts`) and `issue-invoice.ts:400` §87 allocation are reused as-is — the frozen-price override only sets the membership line's unit price *before* VAT is computed.
- **§86/4 vs §105 discriminator untouched.** Membership always resolves `pdfDocKind='invoice'`, TIN line omitted when buyer has no TIN (066 ruling, `document-kind.ts`) — reuse verbatim.
- **VAT 7% + buyer snapshot** pinned at issue (`issue-invoice.ts:280,426`) — unchanged.
- **No registration-fee leak.** A renewal must never re-bill the one-off `registration_fee` (`create-invoice-draft.ts:205` can fire it) — suppress for the renewal path.
- **THB-only, 12-month** for launch (term/currency hardcoded in `plan-lookup-for-renewal-drizzle.ts`). Multi-year / non-THB have no correct §86/4 total path today — scope out or define explicitly (OPEN).
- **Atomicity residual (accepted, pre-existing):** F4 issuance runs outside the F8 tx (`confirm-renewal.ts:273`); the frozen-price rework must not widen the issue↔link orphan window.

## Testing strategy (TDD)

**Unit (domain / pure):**
- `cycle-status.test.ts` — assert the two new edges (`pending_admin_reactivation→lapsed`, `upcoming→completed`) are now legal and previously-illegal edges still reject; bump the count assertions.
- `create-next-cycle-on-paid` — period-derivation math (gapless `periodFrom = prior.periodTo`), idempotency no-op when an active cycle exists, non-throwing on plan-resolution failure.

**Integration (live Neon — mandatory, mocks hide schema/RLS):**
- **Frozen-price invariant (the tax fix):** bump the F2 plan price between cycle creation and confirm, then assert **both** the cycle column *and the issued invoice total* stay at the frozen value. The existing `frozen-price.test.ts` only asserts the column — extend it to assert the issued §86/4 line total (the untested divergence).
- `create-next-cycle-on-paid` against the partial-unique index — assert no constraint violation on webhook retry (callback[0] short-circuits + callback[2] no-ops), and that the new cycle commits atomically with completion.
- `enter-awaiting-payment-on-expiry` — `upcoming|reminded → awaiting_payment` flip, lapse-cron then sees the row, cron-vs-confirm race resolves to one `awaiting_payment` row.
- **G5 enforcement** — every one of the 6 real cycle edges (`awaiting_payment→completed/lapsed/pending`, `pending→completed/cancelled/lapsed`, `upcoming→completed` offline-mark) passes through the now-enforcing `transitionStatus` without throwing `invalid_transition`; an illegal edge throws.
- `adminReactivate` / `adminReject` routes through real `deps` (proves `f5RefundBridge` wiring; reject issues a real test-mode refund + credit-note).
- **Cross-tenant probe** — tenant A cannot create/transition/reactivate a cycle in tenant B (Principle I two-layer isolation test) for every new writer + route.
- **Reg-fee suppression** — a renewal of an existing member with `registrationFeePaid=false` does NOT add a `registration_fee` line.

**E2E (Playwright + axe):**
- G4 — `upcoming` cycle renders the read-only not-yet-open state (no enabled Confirm); `awaiting_payment` renders the Confirm flow.
- Admin reactivate + reject flows from the cycle-detail page (dialogs, toasts, refund-vs-no-refund copy), manager sees no buttons.
- `@i18n` — new `portal.renewal.*` + `admin.renewals.*` keys present in en/th/sv (th mandatory).

**Migration discipline:** for each new audit event (`renewal_cycle_created`, `renewal_entered_awaiting_payment`), apply the `ADD VALUE` migration + run `test:integration` **before** committing the emit site.

## Resolved decisions (maintainer-approved 2026-06-13)

All open questions resolved; the spec is decision-complete for writing-plans.

1. **First-cycle period anchor** — DEFAULT: per-member `period_to` = last-paid-invoice date (or join date) + 12 months when that date exists in the member data; otherwise a **uniform anchor**: `period_from` = go-live date, `period_to` = go-live + 12 months (admin adjusts individual outliers post-backfill). The exact go-live/membership-year date is the single operator input to the backfill script.
2. **FR-022 tax** — **FIX THE CODE**: thread the cycle's `frozenPlanPriceThb` into the F4 membership-invoice path (`unitPriceSatang` override) so the §86/4 invoice bills the frozen price the portal shows. Lands in Slice 1.
3. **`awaiting_payment` audit ownership** — emit `renewal_entered_awaiting_payment` from **BOTH** writers (T-0 cron + lazy-confirm) with a `source` discriminator field (`cron` | `confirm`) for an accurate timeline.
4. **Multi-year / non-THB renewals** — **SCOPE OUT** for launch; renewals are 12-month THB only. Multi-year/non-THB is a separate future spec.
5. **`reminded` status** — **do NOT write `reminded`** on the cycle (reminders are tracked in `renewal_reminder_events`); the new writers accept `upcoming | reminded` as a valid `from` either way (tolerant), so this is non-breaking.
6. **Admin reactivation scope** — Slice 3 ships **admin "reactivate lapsed member" = create a fresh `awaiting_payment` cycle + issue a §86/4 renewal invoice** (the common lapsed-comeback path, reusing Slice 1 creation + Slice 2 awaiting + F4). **DEFER** the `blockAutoReactivation` UI + the `pending_admin_reactivation` money-hold reactivate/reject routes to post-launch (a specialized safety branch for suspicious members; the race-safe use-cases already exist and can be wired later).
7. **Pending-review discovery tab** — **DEFER** (follows #6 — no `pending_admin_reactivation` flow at launch).
8. **Reject reason confirmation** — when the pending-reject flow is later built, use **typed confirmation (type "REFUND")** given the irreversible Stripe refund + credit-note money impact.
9. **Terminal-state split** — **DOCUMENT as intentional** (reject→`cancelled` leaves the re-engagement funnel; timeout→`lapsed` stays in it); do NOT converge.

## Phasing (ship in slices)

This **can** ship in slices, but the core renew loop has a hard ordering dependency: **B (awaiting_payment writer) must precede or accompany C and the observable half of G4.**

- **Slice 0 — safe cleanups (independent, ship first):** G6 (dead `'grace'` removal) + G5 map-completion-then-enforce + terminal-state documentation. Zero behavioural risk, makes the state machine authoritative before new writers land on it.
- **Slice 1 — make cycles exist (B2 creation + tax fix + cold-start backfill):** A (create-on-paid callback) + D (createMember bootstrap) + the one-off backfill + the frozen-price F4 override + reg-fee/pro-rate suppression + `renewal_cycle_created` audit. Without this, everything downstream is empty. The tax fix rides here because it touches the same confirm/F4 seam and is a §86/4 correctness blocker.
- **Slice 2 — make cycles payable (B1):** the T-0 `enterAwaitingPaymentOnExpiry` cron + the lazy confirm-transition + `renewal_entered_awaiting_payment` audit + **G4 portal gate** (G4 becomes observably correct here). This unblocks self-service renew end-to-end.
- **Slice 3 — admin lapsed-comeback (reactivate via a fresh cycle):** an admin "Renew / reactivate this lapsed member" action that creates a fresh `awaiting_payment` cycle + issues a §86/4 renewal invoice (reuses Slice 1 creation + Slice 2 awaiting + the F4 bridge) → member pays → active. **DEFERRED to post-launch** (resolved Q6/Q7): the `blockAutoReactivation` UI + the `pending_admin_reactivation` reactivate/reject money-hold routes + the "Pending review" tab — the race-safe `adminReactivateLapsedCycle` / `adminRejectReactivation` use-cases already exist and can be wired then. Security-sensitive (renewal invoice + member payment) → ≥2 reviewers, one signs the security checklist.

Recommended order: **0 → 1 → 2 → 3.** Slices 0 and 1 can proceed in parallel branches (disjoint files); 2 depends on 1; 3 depends on 2.

---

Key files cited (all absolute): `src/modules/renewals/infrastructure/renewals-deps.ts:465-629` · `src/modules/renewals/domain/value-objects/cycle-status.ts:87-121` · `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts:367,450,689,768,808` · `src/modules/renewals/application/use-cases/confirm-renewal.ts:140,182,273` · `src/modules/renewals/application/use-cases/mark-cycle-complete-from-invoice-paid.ts:118,136,279` · `src/modules/renewals/application/use-cases/admin-reactivate-lapsed-cycle.ts:75` · `admin-reject-reactivation.ts:137` · `src/modules/renewals/application/ports/renewal-cycle-repo.ts:22-36` · `src/modules/invoicing/application/use-cases/create-invoice-draft.ts:145,205` · `src/app/(member)/portal/renewal/[memberId]/page.tsx:106,218` · `src/modules/renewals/infrastructure/drizzle/drizzle-dispatch-candidate-repo.ts:258` · `drizzle/migrations/0087_f8_create_renewal_cycles_table.sql:6,90,164,170`.