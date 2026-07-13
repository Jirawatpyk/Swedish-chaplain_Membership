# Membership Benefit Suspension + Lapse Enforcement — Design

**Date**: 2026-07-13 (rev 2 — post 5-agent adversarial review; every Blocker/High resolved inline)
**Status**: Approved design, rev 2 awaiting maintainer re-confirmation
**Branch**: `059-membership-suspension` (worktree, off `origin/main`)
**Owner modules**: `src/modules/renewals` (F8) · `src/modules/broadcasts` (F7) · `src/modules/events` (F6) · `src/modules/insights` (F9) · `src/lib/lapsed-portal-scope.ts` + `src/lib/member-context.ts` (presentation composition)
**Provenance**: TSCC policy update received 2026-07-13 (supersedes the "no fixed lapse policy — board discretion per case" note in `docs/runbooks/cron-jobs.md:1056`).

## Purpose

TSCC's updated membership policy:

> Members get **90 days of credit** on the renewal invoice. During that window they
> **remain members but may not use any benefits**. Benefits unlock the moment payment
> lands. If the 90 days elapse unpaid, membership is terminated.

This **deliberately changes** the shipped F8 grace semantics (see § FR amendments — FR-003
previously said grace *retains* access). Under the new policy grace still means "not yet
terminated", but it no longer means "benefits still usable".

Three enforcement gaps in the platform contradict the new policy today. The renewal-cycle
period math is already correct and is **not touched** by this work (see § Anchor scope).

### The three gaps

1. **`src/lib/lapsed-portal-scope.ts` is dead AND broken.**
   `checkLapsedPortalScope()` has **zero production callers** (imported only by tests; its
   per-file coverage threshold was lowered to 80/70/80 in `vitest.config.ts:615-624` because
   actual coverage is ~0%). Worse — wiring it up as-is would still block nobody:

   ```ts
   // lapsed-portal-scope.ts:128-134
   const cycle = await deps.cyclesRepo.findActiveForMember(tenantId, memberId);
   if (!cycle || cycle.status !== 'lapsed') return { allowed: true };
   ```

   `findActiveForMember` filters `status NOT IN ('lapsed','cancelled','completed')`
   (`drizzle-renewal-cycle-repo.ts:576`), so a lapsed member yields `null` → `!cycle` →
   `allowed: true`. The `cycle.status !== 'lapsed'` branch is **unreachable**. The tests pass
   only because they mock the repo to return a lapsed cycle — a state the real query cannot
   produce (`tests/integration/renewals/lapsed-portal-scope.test.ts:104-120` documents this
   in a comment, seeds a lapsed row, then `void`-s it and skips the block branch as a
   "Wave D follow-up" that was never actioned).

2. **FR-004's role-revocation half was never implemented.**
   `specs/011-renewal-reminders/spec.md:211` requires lapse to "revoke their `member` role's
   full access". `lapse-cycles-on-grace-expiry.ts:257-313` only writes the cycle status + an
   audit row. FR-004 intended FR-005a's portal gate to *be* that revocation — but the gate is
   gap #1. Gaps #1 and #2 are the same hole from two sides.

3. **Quotas reset on 1 Jan regardless of membership status.**
   F7 e-blast (decision point `compute-quota-counter.ts:129,147`), F6 event seats
   (`apply-quota-effect.ts:269-280`) and F9 benefit usage (`compute-benefit-usage.ts:81-93`)
   all key on **plan + calendar year**. A grep of `broadcasts/`, `events/`, `insights/` finds
   **zero imports from `@/modules/renewals`** and zero reads of `members.status`/`lapsed`. An
   unpaid, expired member receives a full fresh year of benefits on 1 Jan and can spend them.
   (F6 does read a per-ticket `payment_status`, but never *membership* status.)

Net effect today: lapse produces a red badge and nothing else.

## Decisions

| Question | Decision |
|---|---|
| Anchor scope | **Steady-state renewal anchor unchanged** — gapless at `prior.periodTo` (`create-next-cycle-on-paid.ts:73`). The **one** anchor this design does change is the post-lapse comeback path (`admin-renew-lapsed-member`), argued separately in § Post-lapse. |
| Why not anchor on the invoice issue date | Rejected. TSCC issues the renewal invoice ~1 month **before** the period starts, so the invoice date is not the period start; anchoring a new period on it would start the period before the prior one ends, overlap, and lose ~1 month per renewal — compounding to ~1 year over ~12 renewals. (This rationale is the design's own reasoning; it is **not** attributed to the anchor docs, whose recorded rejections concern *payment-date* anchoring and the *calendar-year* model — `docs/Bug/2026-07-08-renewal-paid-invoice-disconnect.md:158-184,229`.) |
| What gets suspended (enforceable) | **E-Blast submission (F7)** — the sole self-serve, in-system, benefit-consuming surface — plus the **`contacts/invite`** privilege surface (see § Surfaces). |
| What is alert-only, not blocked | **F6 event seats** — no in-system registration exists to block (members register on EventCreate; admins import a CSV after the fact). Record + alert. **Banner / cultural tickets / website logo** — fulfilled by staff off-platform; no consumption route exists. **Directory** — delist only on `terminated`, never `suspended`. |
| Suspension policy shape | `suspended` = **allow-by-default + short denylist**; `terminated` = the existing **deny-by-default + allowlist**. See § Two policies. |
| Lapse trigger | `expires_at + grace_period_days` **plus a new guard**: never lapse a member who has an unpaid membership invoice that is **not yet past its `due_date`**. This requires a **new repo query** — the dispatcher's Gate 7.5 SQL cannot be reused (it selects `status IN ('paid','partially_credited')`, the opposite of what the guard needs). |
| `grace_period_days` | **90** (TSCC-confirmed). Prod-config SQL; the shipped code/migration default stays **14** and is unchanged. `GRACE_PERIOD_DAYS_MAX` is already 90. |
| Post-lapse payment | Change `admin-renew-lapsed-member` from an unconditional `periodFrom = now` to: compute the gapless period; use it if it has not already expired, else re-anchor at the payment month. See § Post-lapse for why this touches the "one place a payment-time anchor is right". |
| Per-member override | **Dropped (YAGNI)** — proposed against the now-superseded "board discretion" note; with a fixed 90-day policy the rationale is gone. `mark-paid-offline` remains an admin escape hatch. |
| Auto-issue of renewal invoices | **Out of scope.** No cron issues invoices today. Members self-serve via `/portal/renewal/[memberId]` (`confirm-renewal.ts:523`), which self-issues. |
| Kill-switch | Enforcement rides the existing `FEATURE_F8_RENEWALS` flag (`proxy.ts` § 1f). No new flag. Because this gate can block a paying member if it misfires, the plan must confirm the flag disables the *new* gate too, not just the old paths. |

## Architecture

### 1. Single source of truth (Domain)

```ts
// src/modules/renewals/domain/renewal-cycle.ts — replaces/subsumes isMembershipLapsed (:325)
export type MembershipAccessReason =
  | 'in_good_standing'      // access = 'full'
  | 'unpaid'                // suspended: expired, awaiting payment
  | 'pending_review'        // suspended: paid, held for admin (FR-005b)
  | 'grace_expired'         // terminated: lapsed
  | 'cancelled';            // terminated: admin-cancelled an ENDED period

export interface MembershipAccessDecision {
  readonly access: 'full' | 'suspended' | 'terminated';
  readonly reason: MembershipAccessReason;
}

export function deriveMembershipAccess(
  cycle: RenewalCycle | null,
  now: Date,
): MembershipAccessDecision;
```

The `reason` field is **load-bearing for copy**, not cosmetic: without it the banner tells a
member who already paid (`pending_review`) to "pay to restore" (UX review, HIGH-5).

`deriveMembershipAccess` **subsumes** `isMembershipLapsed`, which is redefined as
`deriveMembershipAccess(cycle, now).access === 'terminated'` so there is exactly one
good-standing predicate in the file (architect BLOCKER-1 corollary).

Pure function, no I/O, `now` injected — meets Domain 100%-line coverage. Exported through the
renewals barrel as a **value** (precedent: `isMembershipLapsed`, `barWidthPercent` are already
value-exported *"so Presentation never deep-imports ./domain/**"*, `src/modules/renewals/index.ts`).

**Status mapping — the corrected table.** The critical fix from review: a terminal status is
**not enough** to terminate; the period must also have ended. Cancelling a still-live
`upcoming` duplicate cycle (`cancel-cycle.ts` transitions from `upcoming|reminded|awaiting_payment|pending_admin_reactivation`)
must **not** lock the member out (architect BLOCKER-1). And a `completed` cycle past its
period must stay `full`, or the member is prompted to pay a **second** time — the exact
057 R2 (CRITICAL) failure the dashboard already guards against
(`dashboard-stats.ts:64-86`, UX BLOCKER-3).

| `status` | `expires_at` vs now | → access / reason |
|---|---|---|
| `upcoming` · `reminded` | future | `full` / `in_good_standing` |
| `upcoming` · `reminded` | **past** | `suspended` / `unpaid` ← closes the 06:15-cron gap |
| `awaiting_payment` | any | `suspended` / `unpaid` |
| `pending_admin_reactivation` | any | `suspended` / `pending_review` |
| `completed` | any (incl. past) | **`full`** / `in_good_standing` ← 057 R2: never re-prompt payment |
| `lapsed` | any | `terminated` / `grace_expired` |
| `cancelled` | **past** | `terminated` / `cancelled` |
| `cancelled` | **future** | **`full`** / `in_good_standing` ← a cancelled *future* cycle is not ended coverage |
| *(no cycle)* | — | `full` / `in_good_standing` — never block a member with no cycle |

Rule stated precisely: **`terminated` requires a terminal status (`lapsed`/`cancelled`) AND
`expires_at < now`** (mirrors the shipped `isMembershipLapsed` two-condition rule exactly).
The "expired → at least suspended" override applies to **non-terminal** statuses only
(`upcoming`/`reminded`); it never touches `completed`. Comparison is **instant vs instant**
using `expiresAt` (the trigger-maintained mirror of `period_to`,
`0087_...sql:37-39,192-203` — every sibling predicate reads `expiresAt`, so we do too; no
day-truncation, which would flip access ±7 h at the Bangkok boundary). Boundary
`expires_at === now` is treated as expired (strict `<` means exactly-now is still `full`;
the plan pins this with a test).

### 2. New repo read (Infrastructure)

The predicate needs a cycle that **may be terminal**. The correct approach is **not** a new
ordering — `findLatestCyclesForMembers` (batch, `drizzle-renewal-cycle-repo.ts:640-663`)
already returns all statuses ordered `created_at DESC, cycle_id DESC` with a deterministic
tiebreak, and carries a review comment (S1 speckit-review) requiring the single-read and
batch-read paths to **share that ordering** so the portal chip and admin badge cannot
disagree. The earlier `period_from DESC` proposal was **wrong**: it is a third ordering, has
no tiebreak (two cycles can share a `period_from` → nondeterministic gate), and a frozen
future `period_from` on a cancelled row can outrank a freshly-restored live cycle,
terminating a member who was just un-archived (security F-1, architect BLOCKER-2).

```ts
// single-row sibling of findLatestCyclesForMembers — SAME ordering key
findLatestCycleForMember(tenantId, memberId): Promise<RenewalCycle | null>
// all statuses, no filter · ORDER BY created_at DESC, cycle_id DESC · LIMIT 1
```

This resolves every multi-cycle shape correctly (2026-`completed` + 2027-`upcoming` → 2027;
2026-`lapsed` + 2027 admin-renewed → the 2027 row, not the stale lapsed one; archive→restore
→ the restored row) because the newest row always has the newest `created_at`. It **replaces**
the broken `findActiveForMember` call in `lapsed-portal-scope.ts`.

Tenant isolation: the method wraps its own `runInTenant(tenant, tx)` and relies on the RLS
GUC, exactly like every sibling read (there is no `WHERE tenant_id` in these methods — RLS
enforces it). A cross-tenant probe integration test is a Review-Gate blocker (Principle I).

### 3. Three consumers, one predicate

```
                  deriveMembershipAccess()          ← Domain (pure)
                          │
        ┌─────────────────┼──────────────────┐
        │                 │                  │
   [Presentation]    [Application]      [Application]
        │                 │                  │
  chokepoints        F7 submitBroadcast  F6 import /
  (see § 4)          F3 inviteColleague  F9 display
        │                 │                  │
  blocks portal      block + spend      alert / badge
  surfaces           no quota / no acct
```

| Consumer | Layer | Access path |
|---|---|---|
| Portal pages / API | Presentation | via the two chokepoints in § 4, which call the renewals barrel directly (allowed — `src/lib/**` is the exempt composition layer, `eslint.config.mjs:332`). |
| F7 `submitBroadcast` · F3 `inviteColleague` | Application | **New port** `MembershipAccessPort` + adapter wired at each composition root — mirrors `plans-bridge-port.ts` / `plans-bridge.ts`. (These use-cases are cross-module F→F8 dependencies; the port exists for that reason, not because Application may not import `src/lib/**` — it may.) |
| F6 import · F9 display | Application | Same port. F6 records + alerts; F9 renders a badge. |

The write gates live in the **use-case**, not the route: F7 quota is reserved inside
`submitBroadcast`; `inviteColleague` provisions an auth account. A route-only guard leaks
through any other caller.

### 4. Enforcement chokepoints — the fix for gap #1's root cause

The original gate died because there was **no chokepoint** — enforcement was per-call-site and
every call site forgot. This design names the chokepoints and adds a CI guard so a future
route cannot silently skip them.

- **`terminated` (deny-by-default allowlist)** is enforced at the two existing DB-capable
  chokepoints, not per page:
  - **Pages**: `src/app/(member)/portal/layout.tsx:41` (`requireSession('member')`) — extend to
    run the terminated-scope check for every portal page.
  - **API routes**: `src/lib/member-context.ts:48` (`requireMemberContext`, used by the portal
    API routes) — extend the same way.
  - The Edge proxy stays path-prefix-only (no DB; `proxy.ts:378`).
- **`suspended` (allow-by-default denylist)** is enforced at **two layers**: the
  `/portal/broadcasts/new` server component (UX) + the `submitBroadcast` and `inviteColleague`
  use-cases (enforcement). The page block is UX; the use-case block is the real gate.
- **New CI gate `check:portal-guard`** (pattern: `check:layout`, `check:multi-tenant`): fails
  when a `src/app/(member)/portal/**` page or `src/app/api/portal/**` route does not route
  through a chokepoint. Without it, the hole reopens on the next route — which is precisely how
  the original gate shipped dead.

### 5. Which benefits the system can actually gate

The plan benefit matrix (`plans/domain/benefit-matrix.ts`) has quota'd entitlements on two
different unions. On **base** (every tier): `eblast_per_year` (:72), `cultural_tickets_per_year`
(:80). **Partnership-only**: `event_tickets_included` (:46), `banner_per_year` (:57),
`website_logo_months` (:56). Enforcement must **not** reference `banner_per_year` for a
corporate member — it does not exist on their matrix (spec-compliance blocker; the earlier
"gate 4 benefits" phrasing was a modeling error).

Only **e-blast** has a self-serve in-system consumption surface. Everything else is consumed
externally (EventCreate) or fulfilled by staff off-platform — the system never sees the moment
of consumption, so there is no route to block. The enforceable surface is genuinely one page +
one use-case; that is a property of the product, not an oversight. For the rest, suspension
surfaces as a **staff alert** (F6 import) and a **badge** (F9), and the decision to withhold
sits with whoever invites the member or hands over the ticket.

## Data flow

**Suspension (instant, no cron)** — `expires_at` passes → the predicate reads it directly →
`suspended` on the next request.

**Restoration — two distinct paths (the earlier draft told only the first):**

1. **Steady-state / within-grace** (`awaiting_payment` or non-terminal-expired): payment lands
   (Stripe webhook *or* admin `mark-paid-offline`) → F4 flips the invoice `paid` → the F8
   `onPaid` callback classifies `renewal` → closes the old cycle → creates the next at
   `prior.periodTo` (gapless) → the next request resolves the new cycle (future `expires_at`) →
   `full`. Latency ≈ the F4 tx commit (~50 ms). No cron.
2. **Post-termination** (`lapsed`/`cancelled`): the `onPaid` callback classifier folds a
   terminal cycle to `not_applicable` (`mark-cycle-complete-from-invoice-paid.ts:104`) — a raw
   payment does **not** auto-restore. Restoration goes through **`admin-renew-lapsed-member`**,
   which creates a fresh cycle (§ Post-lapse). This is by design (FR-005b admin-comeback), and
   the smart CTA reflects it: a terminated member sees a contact-support action, not a
   self-serve renew.

**Lapse (daily cron 06:30, now guarded)**

```
expires_at + grace(90) < now ?          → no  → skip
unpaid membership invoice not yet due ? → yes → skip + audit(renewal_lapse_deferred_invoice_not_due) + log
                                        → otherwise → lapsed
```

The guard needs a **new** query — `member + invoice_subject='membership' + status='issued' +
due_date >= today(Bangkok)`. It must find invoices **not linked** to the cycle (an
admin-created invoice leaves `linked_invoice_id` NULL, which is why lapse currently records
`grace_expired` with `failed_payment_attempts: 0` even when a live unpaid invoice exists).
**The guard runs OUTSIDE the advisory-lock tx** — beside the existing pre-tx F5 attempts read
in `processOne` — not inside it. Every repo read in this module opens its own `runInTenant`
(a fresh pooled connection); calling it while holding `pg_advisory_xact_lock` is the
documented deadlock/pool-starvation class (architect HIGH-3). Prefer a port
(`InvoiceDueBridgePort` + adapter at the F8 root), mirroring `f5PaymentAttemptsBridge`, over
raw cross-module SQL against F4's `invoices` table.

## Post-lapse (admin-renew comeback anchor)

`admin-renew-lapsed-member.ts:211` today is unconditionally `periodFrom = now`. Change to:
compute the gapless period from the prior cycle's `periodTo`; **use it if it has not already
expired**, otherwise re-anchor at the payment month.

This **does** touch a path the anchor docs deliberately reserved as *"the ONE place a
payment-time anchor is right"* (`docs/Bug/2026-07-08-renewal-paid-invoice-disconnect.md:139`).
The justification: with benefit suspension now doing the punishing, a member who pays late but
**within** a still-live period should not *also* lose their anniversary — the suspension window
already cost them. A genuine comeback (prior period long expired) still re-anchors, exactly as
before. The member with **no settled predecessor** (the documented FIX-1/R2-FIX-2 branch,
`admin-renew-lapsed-member.ts:222-249`) has no gapless period to compute and keeps the
payment-month anchor. "Re-anchor at the payment month" means Bangkok-month truncation
(consistent with `payment-anchor-date.ts`), and the chosen `period_from` is printed on the
§86/4 tax document — the plan must test that the printed window matches the anchor.

## Grace-90 × gapless-backdate interaction (new analysis)

A member who pays on day 89 gets a gapless period that began 89 days ago → they were suspended
~89 days **and** the freshly-paid year is already 89 days spent. At the old 30-day grace this
was tolerable; at 90 it triples. This is **intended** under the new policy (benefits genuinely
pause; paying late costs usable time — the incentive to pay on time), but it must be stated so
TSCC confirms it, and the member-facing copy must show *"benefits paused · N days used of your
new period"* rather than hide it.

## User-facing surfaces

**Member** — the banner is **not a second red block**. The dashboard membership card already
renders status (067 decision: keep it *in* the card, not a duplicate banner;
`membership-stat-section.tsx:71-75`). Add a `suspended` kind to `MembershipStat` + reuse
`StatCard` (`stat-card.tsx:101` structurally refuses a status row without a text label → no
colour-alone). If a cross-page persistent banner is wanted (it shows on every portal page),
suppress it on `/portal` to avoid stacking with the card, and record that this supersedes 067.

| Surface | Behaviour |
|---|---|
| `/portal` card | `suspended:unpaid` → **amber** (`tone="warning"`, not red — distinct from terminated's red), `<PauseCircle>` icon + distinct `sr-only` phrase, smart CTA. Copy carries dates, not accusation: *"Benefits paused · invoice due {dueDate} · membership ends {expiresAt + 90d}"*. `suspended:pending_review` → *"Payment received — being verified"*, **no** pay CTA. `terminated` → the existing `mailto:` contact action (`membership-stat-section.tsx:98-107`; copy `contactToRenew`/`lapsedMailSubject` already written). |
| `/portal/benefits` | Open. Quota shown *"10 of 10 remaining — paused until payment"* (never greyed to 0 — the quota is intact). Names **every** paused benefit, including the ones the platform can't technically gate (event/banner/logo), so a member isn't blindsided at an event door. |
| `/portal/broadcasts/new` | Blocked. Reuse the FR-009 precedent (`broadcasts/new/page.tsx:83` already `redirect`s to `/portal/benefits?tab=broadcasts` when `cap === 0`) — same destination, `InlineAlert tone="warning"` + smart CTA. If a standalone page is preferred, use `EmptyState` (`role="status"`, `<PauseCircle>` — **not** `ErrorState`/`TriangleAlert`, which read as a transient error). |
| Command palette | Filter the "Compose E-Blast" jump target when `access !== 'full'` (`member-command-palette-root.tsx`) — the denylist covers routes, not the palette that links to them. |
| Everything else | Unchanged (invoices, tax documents, timeline, account, GDPR export). |

**Smart CTA — must never dead-end.** Branch on the resolved decision, and the target must be
reachable under the member's own policy:

```
access = suspended:
  unpaid membership invoice exists? → /portal/invoices/[invoiceId]
  else                              → /portal/renewal/[memberId]  (self-issues on confirm)
access = suspended:pending_review   → no CTA (already paid)
access = terminated                 → /portal (mailto contact — NOT /portal/renewal)
```

Two reachability fixes the review surfaced:

- **The renewal page's payability gate keys on a status literal** (`page.tsx:240`,
  `summary.status === 'awaiting_payment'`), so the `upcoming`-but-expired cohort the override
  rule creates lands on *"renewal window not yet open"* — a dead end that contradicts the
  banner. The gate must key on the **same predicate** (`awaiting_payment` OR non-terminal &&
  expired). The reviewer note at `page.tsx:224-239` (which currently says the opposite) must be
  updated. `confirm-renewal.ts:241` already has the lazy `upcoming|reminded → awaiting_payment`
  self-transition, so the server accepts this confirm — only the presentation gate blocks it.
- **`terminated`'s allowlist must not point at a redirect-into-a-wall.** `/portal/renewal` for a
  terminated member resolves `null` and `redirect('/portal')` (`page.tsx:110-113`), and
  `/portal` is not allowlisted → 403. Fix: the terminated CTA goes to `/portal` (which renders
  the working `mailto:` action) and `/portal` is added to the terminated allowlist; drop the
  "`/portal/renewal` needs no new code" claim.

**Admin**

| Surface | Behaviour |
|---|---|
| Members directory | New "suspended" badge — copy the existing lapsed badge shape exactly (`members-table.tsx:600-604`: `aria-hidden` icon + `aria-hidden` short label + `sr-only` full phrase), distinct icon + phrase, **amber** not red. |
| F6 CSV import | A suspended attendee is **recorded normally**, plus a warning row in the import report and an audit event. |

Accessibility: never colour-alone; suspended = amber/`PauseCircle`, terminated = red/`TriangleAlert`
(two reds side by side is the classic colour-alone failure). `role="status"` on the banner
(server-rendered, not async — no `aria-live`). `@a11y` axe scan on `/portal` in the suspended
state (banner + card + badge stack), not only the blocked page. Use `warning-surface`/
`destructive-surface` tokens, not raw `amber-*` literals. TH/SV copy from native speakers — the
suspended-vs-terminated distinction ("ระงับสิทธิ์" vs "ยกเลิกสมาชิกภาพ") is one members read
carefully; not machine-translated. Test TH banner length at 320 px (Reflow, WCAG 1.4.10).

## Audit & observability

Five new `audit_event_type` values (5-year retention, emitted in the same tx as any state
change per Principle VIII). They land in **three module taxonomies** (each with its own
compile-time count assertion) plus the global enum:

| Event | Module taxonomy | Fires when |
|---|---|---|
| `membership_suspended_action_blocked` | F8 (`renewal-audit-emitter.ts`) | a suspended member hits a chokepoint-blocked surface |
| `membership_access_fail_open` | F8 | the read threw and the gate failed open — the durable, forensic record of a fail-open decision (security F-3) |
| `renewal_lapse_deferred_invoice_not_due` | F8 | the lapse guard spared a member — the signal that proves the guard works |
| `broadcast_membership_suspended_blocked` | F7 (`broadcasts` audit-port, 43-list) | F7 rejects a submit (name follows F7's `broadcast_<reason>_blocked` taxonomy — **not** the earlier `broadcast_blocked_membership_suspended`) |
| `event_attendance_by_suspended_member` | F6 events taxonomy | F6 import sees an unpaid attendee |

**Adding an audit event type touches 5 places, not 4** (UX review): domain const, pgEnum
migration, the two parity-test counts, **and the `audit.*` i18n label registry** — miss the
last and the F9 audit viewer renders raw `snake_case`. Enumerate per-event, per-module in the
plan; the F7 one also needs a 422 error-code + union entry in `broadcasts-api.md:87-92` and
`data-model.md:547-589`. Shared-Neon caveat: an enum add on a side branch drifts audit-parity
on all other branches until merge — note ship order.

Metrics: counter `membership_access_blocked{surface, reason}` + counter
`membership_access_fail_open{surface}` (alertable) + a gauge of currently-suspended members
(the January spike). The gate adds a DB read to the portal hot path — memoise per render with
`React.cache` and state the p95 budget (Principle VII).

## Schema

```sql
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS '…';  -- ×5
```

**No new columns, no new tables, no indexes, no backfill.** The truth already lives in
`renewal_cycles`. `grace_period_days = 90` is a separate one-line ops SQL, not a migration.

## FR amendments (required — this design changes shipped F8/F7 behaviour)

This is a deliberate policy change, so the shipped specs must be amended, not left stale:

- **`specs/011-renewal-reminders/spec.md`**
  - **FR-003** — grace no longer "retains access"; during grace the member is **suspended**
    (benefits blocked, access to pay/read retained). The `default 14` text gets a footnote that
    prod config is 90 (code default unchanged).
  - **FR-004** — lapse trigger gains the due-date guard; the "revoke access" half is now
    actually delivered via the wired chokepoints.
  - **FR-005** — delete the "any F6 event registration" blocked-route clause (that route was
    never built and never will be — F6 is admin-only after-the-fact import). Reconcile the
    documented allowlist (`/portal/profile`, `/portal/renewal`, `/portal/billing`) with the
    real `LAPSED_PORTAL_ALLOWED_PREFIXES`, which drifted; add the two-policy model and `/portal`.
  - **FR-005a** — record that the helper is now wired at the chokepoints and uses
    `findLatestCycleForMember`.
  - Entity `TenantRenewalSettings` (:357) default note; audit taxonomy (+5 events).
- **`specs/010-email-broadcast/spec.md`** — FR-002 gains precondition (l) + the 422 error code;
  `contracts/broadcasts-api.md` + `data-model.md` gain the audit event.
- **`docs/runbooks/cron-jobs.md`** — `:1047-1063` (30→90, board-discretion note superseded) **and**
  the contradictory `:937` ("SweCham uses the default 14").

## Delivery slices

| Slice | Contents | Order constraint |
|---|---|---|
| **1 — Enforcement core** | `deriveMembershipAccess` (+ reason) · `findLatestCycleForMember` · wire terminated at layout + `requireMemberContext` · suspended denylist + F7/F3 use-case gates · `check:portal-guard` · smart CTA + payability-gate fix + `/portal` allowlist fix · fail-open audit · 4 of the 5 audit events | Closes both go-live blockers. |
| **2 — Lapse correctness** | new due-date-guard query (outside tx) · `admin-renew-lapsed-member` gapless-or-re-anchor · `renewal_lapse_deferred_invoice_not_due` · `grace_period_days = 90` ops SQL | **Must not ship before slice 1** — grace 90 before suspension exists = a 90-day free ride. |
| **3 — Visibility** | admin badge · F6 import alert + `event_attendance_by_suspended_member` · F9 badge · metrics gauge | Observability; nobody blocked on it. |

## Error handling

**Fail differently per layer:**

| Path | On `findLatestCycleForMember` throw | Why |
|---|---|---|
| Portal page reads (GET) | **Fail open** — allow + **emit `membership_access_fail_open`** + metric | A DB blip locking every member out is worse than a brief page view. |
| F7 `submitBroadcast`, F3 `inviteColleague`, and every other state-changing use-case | **Fail closed** — 500 (`submit.server_error` shape) | Failing open spends a quota unit / provisions an account **irreversibly**. Each write use-case fails closed **independently** — never relying on a page-level fail-open (security F-3). |

Fail-open must leave an **audit row**, not just a log — otherwise an attacker who induces the
DB error (statement timeout, pool exhaustion) bypasses the gate with no forensic trace
(security F-3). F7 must **not** return the policy-reject code on an infra error (don't collapse
422 into 500) — mirrors `submit-broadcast.ts:349-356`.

**Lapse guard**

| Case | Behaviour |
|---|---|
| Several unpaid invoices | **any** not yet due → do not lapse (`.some`, not `.every`). |
| No invoice at all | guard finds nothing → lapse proceeds on grace alone (essential fallback). |
| `draft` (`due_date` NULL) / `void` / `cancelled` / `paid` | ignored — only `status='issued'` with a non-null future `due_date` counts. |
| Event invoice (subject≠membership) with future due date | ignored — must not defer a membership lapse. |
| Date comparison | Asia/Bangkok, reusing `invoicing/application/use-cases/derive-overdue.ts:83-85` (`bangkokLocalDate(nowUtcIso)` → `todayBkk > invoice.dueDate`). |
| Guard throws | it runs inside the per-cycle best-effort loop (`errors += 1; continue`) — a throw must not become an invisible skip; make it observable (metric/audit), and test the throw path. |

**Other paths**: payment mid-session → next request `full` (no refresh); backdated new cycle
(`period_from` past, `upcoming`, future `expires_at`) → `full`; F4 `onPaid` throw → F4 rolls
back → member stays suspended (no half-state); audit emit failure → log + swallow
(`lapsed-portal-scope.ts:197-211`) — a 403 never hangs on a log write.

## Testing

The incident's lesson is a testing lesson: the broken gate shipped green because a test author
**found** the bug, could not make the test pass, and rewrote the test's scope
(`tests/integration/renewals/lapsed-portal-scope.test.ts:104-120,140-141,226-235`). The plan
enforces these rules:

1. **A test may never be narrowed to accommodate a defect.** A discovered-but-unfixed defect is
   a red test + a blocking issue — never a `void`-ed variable or a "follow-up" comment.
2. **A test may never mock a repo method into a row its own SQL cannot produce.** For any
   status-keyed predicate, a live-Neon test inserts that exact status and asserts the repo
   returns it.
3. **A deny gate is tested from the deny side** — at least one test that goes red if the gate is
   deleted. "Allowed routes are allowed" carries zero information.
4. **A gate is not tested until its production wiring is tested** — through the real DI graph,
   not a mocked port. This applies to the **F7 `submitBroadcast` gate too** (the earlier draft
   left it with only a mocked-port unit test — the original defect one layer up).
5. **Never lower a coverage threshold to pass a gate** — `vitest.config.ts:615-624` is raised
   back in slice 1 and its two false claims deleted.
6. **Best-effort loops need per-item try/catch + an explicit throw-path test.**
7. **Every tenant-scoped read threads `tx` from `runInTenant`; cross-tenant probes assert a
   distinguishable outcome** — assert the repo returns `null` for a foreign member (not just
   `allowed:true`, which is what a *dead* gate returns).

| Layer | Coverage |
|---|---|
| Unit — Domain (100% line) | `deriveMembershipAccess`, table-driven: 7 statuses × `expires_at` {past, exactly-now, future} × `cycle=null`; **terminated requires status AND expired** (cancelled-future → full; completed-past → full); instant-not-day comparison; `reason` for every branch. |
| Unit — Application | `submitBroadcast` + `inviteColleague`: suspended → reject; **DB throw → server_error, not the policy code**. Lapse guard: any-not-due → skip; no invoice → lapse; draft/void/paid → ignore; event-subject → ignore; on-due-date exactly; guard-throws → observable. `admin-renew-lapsed`: unexpired → gapless; expired → re-anchor; no-predecessor branch; printed §86/4 window matches anchor. Smart CTA: both branches + every target resolves to an allowed route. |
| Contract | `MembershipAccessPort` (F7/F3→F8) + barrel export. |
| Integration (live Neon) | **Repo returns a `lapsed` cycle** (the assertion that would have caught the original bug). Ordering shapes: completed-2026+upcoming-2027; lapsed-2026+admin-renewed-2027; **archive→restore → full**. Full cycle: expire → suspended → pay → full. Lapse guard against a real `issued` invoice with future `due_date` → cycle survives + `renewal_lapse_deferred_invoice_not_due` payload. **F7 gate through the real `makeBroadcastsDeps()`** (not a mocked port). **Cross-tenant probe** on the new read (Review-Gate blocker). |
| E2E | Suspended member (needs a **new seed fixture** — the existing `renewals-seed.ts` seeds `upcoming`+`lapsed` on one member, which resolves to `full`): banner renders; `/portal/invoices` reachable; `/portal/broadcasts/new` blocked with a working CTA; the four never-block routes (`/portal/invoices/[id]`, its PDF API, `/portal/account/data-export`, `/portal/credit-notes/[id]`) reachable. `@a11y` axe on `/portal` + blocked page. `@i18n` banner EN/TH/SV. |

**Test files** — new: `tests/unit/renewals/domain/derive-membership-access.test.ts` ·
`tests/integration/renewals/find-latest-cycle-for-member.test.ts` (model on the existing
`find-most-recent-for-member.test.ts`, which exists for this exact bug class) ·
`tests/unit/lib/membership-suspension-policy.test.ts` (the four never-block routes by name;
denylist prefix-confusables) · `tests/integration/broadcasts/submit-broadcast-membership-suspended.test.ts`
(real deps) · `tests/contract/renewals/membership-access-port.contract.test.ts` ·
lapse-guard unit + integration · smart-CTA unit · `tests/e2e/membership-suspension.spec.ts`.
Rewritten (they currently encode the bug): `lapsed-portal-scope` integration + e2e + unit.
Updated: `vitest.config.ts`, both `admin-renew-lapsed-member` tests, `renewals-seed.ts`.

**Gate before merge**

```bash
pnpm lint && pnpm typecheck && pnpm test:coverage \
  && pnpm check:i18n && pnpm check:audit-events && pnpm check:audit-counts && pnpm check:portal-guard \
  && pnpm test:integration && pnpm test:e2e
```

## Security & compliance

- All reads/writes via the caller's `runInTenant`/RLS (never the global `db`) — Principle I.
  The hazard on the new read is **connection-nesting** (see § Data flow lapse guard), not RLS
  bypass. Cross-tenant probe is a Review-Gate blocker.
- Audit rows in the same tx as the state change (Principle VIII); fail-open itself is audited.
- `/portal/account/data-export` stays reachable while suspended — GDPR Art. 20 / PDPA
  portability is a legal right, not gated on payment.
- `contacts/invite` (account provisioning) is gated under `suspended` — an unpaid member should
  not mint colleague logins.
- Renewal state is finance-adjacent → ≥2 reviewers (or the Constitution v1.4.2 solo-maintainer
  substitute). One signs a feature `security.md` § checklist covering the AuthZ chokepoints,
  fail-open audit, and the two-policy enumeration.

## Out of scope

- Auto-issuing renewal invoices on a schedule.
- Per-member grace overrides.
- Blocking F6 event imports; delisting suspended members from the directory.
- Any change to steady-state renewal-period anchoring (only the admin-comeback path changes).

## Ops steps at ship

1. Verify the current value first — `SELECT tenant_id, grace_period_days FROM tenant_renewal_settings WHERE tenant_id='swecham';` (code default is 14; the intended 30 was a hand-run SQL that may never have executed — `cron-jobs.md:937` vs `:1053` contradict). Then `UPDATE … SET grace_period_days = 90 WHERE tenant_id='swecham';` **after** slice 1 is live.
2. Amend the specs/runbook per § FR amendments.
