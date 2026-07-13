# Membership Benefit Suspension + Lapse Enforcement — Design

**Date**: 2026-07-13
**Status**: Approved design, awaiting spec review
**Branch**: `059-membership-suspension` (worktree, off `origin/main`)
**Owner modules**: `src/modules/renewals` (F8) · `src/modules/broadcasts` (F7) · `src/modules/events` (F6) · `src/modules/insights` (F9) · `src/lib/lapsed-portal-scope.ts` (presentation)
**Provenance**: TSCC policy update received 2026-07-13 (supersedes the "no fixed lapse policy — board discretion per case" note in `docs/runbooks/cron-jobs.md:1056`).

## Purpose

TSCC's updated membership policy:

> Members get **90 days of credit** on the renewal invoice. During that window they
> **remain members but may not use any benefits**. Benefits unlock the moment payment
> lands. If the 90 days elapse unpaid, membership is terminated.

Three things in the platform contradict that policy today, and all three are
**enforcement** gaps — the renewal-cycle period math is already correct and is
**not touched by this work**.

### The three gaps

1. **`src/lib/lapsed-portal-scope.ts` is dead AND broken.**
   `checkLapsedPortalScope()` has **zero production callers** (imported only by tests;
   0% coverage, with an exemption note in `vitest.config.ts`). Worse — wiring it up as-is
   would still block nobody:

   ```ts
   // lapsed-portal-scope.ts:128-134
   const cycle = await deps.cyclesRepo.findActiveForMember(tenantId, memberId);
   if (!cycle || cycle.status !== 'lapsed') return { allowed: true };
   ```

   `findActiveForMember` filters `status NOT IN ('lapsed','cancelled','completed')`
   (`drizzle-renewal-cycle-repo.ts:576`), so a lapsed member yields `null` → `!cycle` →
   `allowed: true`. The `cycle.status !== 'lapsed'` branch is **unreachable**. The unit and
   integration tests pass only because they mock the repo to return a lapsed cycle — a state
   the real query cannot produce. Classic mock-hides-bug.

2. **FR-004's role-revocation half was never implemented.**
   `specs/011-renewal-reminders/spec.md:211` requires lapse to "revoke their `member` role's
   full access". `lapse-cycles-on-grace-expiry.ts:257-313` only writes the cycle status + an
   audit row. No role change, no session invalidation, no `members.status` change, no trigger.

3. **Quotas reset on 1 Jan regardless of payment.**
   F7 e-blast (`compute-quota-counter.ts:43-51`), F6 event seats
   (`apply-quota-effect.ts:88-96`) and F9 benefit usage (`compute-benefit-usage.ts:81-87`)
   all key on **plan + calendar year only** — none reads membership or cycle status. An unpaid,
   expired member receives a full fresh year of benefits on 1 Jan and can spend them.

Net effect today: lapse produces a red badge on the dashboard and nothing else. An unpaid
member keeps full portal access and a fresh annual quota indefinitely.

## Decisions

| Question | Decision |
|---|---|
| Renewal anchor | **Unchanged.** Renewals stay gapless at `prior.periodTo` (`create-next-cycle-on-paid.ts:74`). An earlier proposal to anchor on the invoice issue date was **rejected** — TSCC bills ~1 month in advance, so the invoice date is not the period start; anchoring on it would overlap periods and compound-drift (~1 year lost per 5). See `docs/Bug/2026-07-08-renewal-paid-invoice-disconnect.md`. |
| What gets suspended | **E-Blast submission (F7)** + the portal surfaces that consume a benefit. |
| What does NOT get suspended | **F6 event seats** — the platform has no in-system event registration to block (members register on EventCreate; admins import attendee CSVs *after* the event). Blocking the import would discard a record of reality, not prevent a benefit. Record it and alert staff instead; controlling who is invited is a process concern. **Member directory** — delisting someone over a late invoice is disproportionate, publicly visible, and degrades the directory for *other* members. Delist only on `terminated`. |
| Suspension policy shape | **Allow-by-default + short denylist** (NOT the existing whitelist). See § Two policies. |
| Lapse trigger | `expires_at + grace_period_days` **plus a new guard**: never lapse a member who has an unpaid membership invoice that is **not yet past its `due_date`**. |
| `grace_period_days` | **90** (TSCC-confirmed policy, not a chosen default). Config-only SQL; `GRACE_PERIOD_DAYS_MAX` is already 90. |
| Post-lapse payment | `admin-renew-lapsed-member` currently always re-anchors to `now`. Change to: compute the gapless period first; **use it if it has not already expired**, otherwise re-anchor at the payment month. Self-correcting — no threshold config. |
| Per-member override | **Dropped (YAGNI).** It was proposed against the now-superseded "board discretion per case" note. With a fixed 90-day policy the rationale disappears, and 90 days is already generous. Admins retain `mark-paid-offline` as an escape hatch. |
| Auto-issue of renewal invoices | **Out of scope.** No cron issues invoices today (`dispatch-one-cycle.ts` only sends emails / creates admin tasks). Members can self-serve via `/portal/renewal/[memberId]`, which creates the invoice (`confirm-renewal.ts:523`). A T-30 auto-issue cron would touch F4, §87 numbering and tax documents — a separate feature. |
| Benefit-quota year | Stays **calendar year** (F7/F9 unchanged) — suspension gates *consumption*, it does not reshape the quota window. |

## Architecture

### 1. Single source of truth (Domain)

```ts
// src/modules/renewals/domain/renewal-cycle.ts — beside the existing isMembershipLapsed (:325)
export type MembershipAccess = 'full' | 'suspended' | 'terminated';

export function deriveMembershipAccess(
  cycle: RenewalCycle | null,
  now: Date,
): MembershipAccess;
```

Pure function, no I/O — meets the Domain 100%-line-coverage bar. Exported through the
renewals barrel (`src/modules/renewals/index.ts`, which already exports `isMembershipLapsed`).

Status mapping (all 7 states from the `renewal_cycles_status_check` CHECK,
`0087_f8_create_renewal_cycles_table.sql:88-100`):

| `status` | access | rationale |
|---|---|---|
| `upcoming` · `reminded` | `full` | inside a live period |
| `completed` | `full` | paid |
| `awaiting_payment` | **`suspended`** | expired, unpaid |
| `pending_admin_reactivation` | **`suspended`** | paid but deliberately held for admin review (FR-005b) — do not unlock until the admin acts |
| `lapsed` · `cancelled` | **`terminated`** | out of membership |
| *(no cycle at all)* | `full` | a new member with no cycle yet must never be blocked |

**Plus one overriding rule**: if `period_to` is in the past, the result is at least
`suspended` **regardless of status**. The `enter-awaiting-payment` cron runs once daily at
06:15 Asia/Bangkok, so a status-only rule leaves a half-day window in which an expired member
still has full access. Reading `period_to` directly makes the predicate correct the instant
the period ends, with no cron in the path.

### 2. New repo read (Infrastructure)

The predicate needs a cycle that **may be terminal**. No existing per-member repo method
returns one — `findActiveForMember` excludes `lapsed`/`cancelled`/`completed` (:576) and
`findMostRecentForMember` still excludes `lapsed`/`cancelled` (:599). Hence:

```ts
// RenewalCycleRepo port + drizzle impl
findLatestCycleForMember(tenantId, memberId): Promise<RenewalCycle | null>
// ALL statuses, no filter · ORDER BY period_from DESC · LIMIT 1
```

Ordering by `period_from DESC` gives the right answer in every shape: a member whose 2026
cycle is `completed` and whose 2027 cycle is `upcoming` resolves to 2027 (`full`); a member
lapsed in 2026 and admin-renewed into 2027 resolves to the 2027 cycle, not the stale `lapsed`
row.

This read **replaces** the broken `findActiveForMember` call in `lapsed-portal-scope.ts`.

### 3. Three consumers, one predicate

```
                  deriveMembershipAccess()          ← Domain (pure)
                          │
        ┌─────────────────┼──────────────────┐
        │                 │                  │
   [Presentation]    [Application]      [Application]
        │                 │                  │
  lapsed-portal-     F7 submit-         F6 import /
  scope.ts           broadcast.ts       F9 display
  (barrel, direct)   (via port)         (via port)
        │                 │                  │
  blocks portal      blocks + spends    alert only /
  surfaces           no quota           badge only
```

| Consumer | Layer | Access path |
|---|---|---|
| Portal pages | Presentation | Calls the renewals barrel directly — allowed under Principle III. |
| F7 `submit-broadcast` | Application | **New port** `MembershipAccessPort` + an adapter wired at the F7 composition root — mirrors the existing `plans-bridge-port.ts` / `plans-bridge.ts` pair exactly. Application code may not import `src/lib/**` (ESLint `no-restricted-imports`). |
| F6 import · F9 display | Application | Same port. F6 records + alerts (never blocks); F9 renders a "suspended" badge. |

The F7 gate lives in the **use-case**, not the route: quota is reserved inside
`submitBroadcast`, so a route-only guard would leak through any other caller.

### 4. Two policies, not one

The existing gate is **deny-by-default with a small allowlist**
(`LAPSED_PORTAL_ALLOWED_PREFIXES`, `lapsed-portal-scope.ts:41-59`). That is correct for
`terminated` — a near-total lockout with a renewal escape hatch.

It is the **wrong shape for `suspended`**. The portal has 18 pages and 18 API routes; an
allowlist would have to enumerate nearly all of them, and **forgetting one means a paying
customer cannot reach their invoice**. Among the routes that must never be blocked:
`/portal/invoices/[invoiceId]`, `/api/portal/invoices/[invoiceId]/pdf`,
`/portal/account/data-export` (a GDPR Art. 20 / PDPA right), `/portal/credit-notes/[id]`
(tax documents).

| State | Policy | List |
|---|---|---|
| `terminated` | deny-by-default + allowlist | unchanged (`/portal/renewal`, `/portal/preferences`, `/portal/account`, …) |
| `suspended` | **allow-by-default + denylist** | `/portal/broadcasts/new` (the single self-serve benefit-consuming surface) |

This fails safe: a missed denylist entry costs one leaked e-blast surface, which the
use-case gate catches anyway. A missed allowlist entry locks a customer out of paying.

`/portal/benefits` stays **open** while suspended — showing "E-Blast 10/10 · suspended"
motivates payment; hiding it does not.

### 5. Which benefits the system can actually gate

The plan benefit matrix carries four quota'd entitlements
(`plans/domain/benefit-matrix.ts:57-80`): `eblast_per_year`, event seats,
`banner_per_year`, `cultural_tickets_per_year`.

Only **e-blast** has a self-serve, in-system consumption surface. Event seats are consumed on
EventCreate (external) and land here as an admin CSV import *after the fact*; banners and
cultural tickets are fulfilled by staff off-platform entirely. There is no route to block for
those three — the system never sees the moment of consumption.

So the enforcement surface is genuinely one page and one use-case, and that is a property of
the product, not an oversight. For the other three, suspension shows up as an **alert to staff**
(F6 import) and a **badge** (F9 usage view); the decision not to grant them sits with whoever
invites the member or hands over the ticket. This is recorded so a future reader does not
mistake the narrow denylist for a missed requirement.

## Data flow

**Suspension (instant, no cron)** — `period_to` passes → the predicate reads it directly →
`suspended` on the very next request.

**Restoration (instant, no cron)** — payment lands (Stripe webhook *or* admin
`mark-paid-offline`) → F4 flips the invoice to `paid` → the F8 `onPaid` callback classifies
`renewal` → closes the old cycle → creates the next at `prior.periodTo` (gapless backdate) →
the next request resolves the new cycle, whose `period_to` is in the future → `full`.
Total latency ≈ the F4 tx commit (~50 ms). This satisfies TSCC's "จนกว่าเงินจะเข้า" literally.

**Lapse (daily cron 06:30, now guarded)**

```
expires_at + grace(90) < now ?          → no  → skip
unpaid membership invoice not yet due ? → yes → skip + audit + loud log
                                        → otherwise → lapsed
```

The guard must find invoices that are **not linked to the cycle** — an admin-created invoice
leaves `linked_invoice_id` NULL, which is why lapse currently records
`closed_reason: 'grace_expired'` with `failed_payment_attempts: 0` even when a live unpaid
invoice exists (`lapse-cycles-on-grace-expiry.ts:236-243`). Resolve by
`member + subject='membership' + status='issued'`, reusing the dispatcher's Gate 7.5 SQL
(`drizzle-member-renewal-flags-repo.ts:937-991`).

**Post-lapse payment** — `admin-renew-lapsed-member.ts:211` changes from an unconditional
`periodFrom = now` to: compute the gapless period; if it has not already expired use it
(the member merely paid late — anniversary unmoved), otherwise re-anchor at the payment
month (a genuine comeback).

## User-facing surfaces

**Member**

| Surface | Behaviour |
|---|---|
| `/portal` | Banner: "ระงับสิทธิ์ชั่วคราว — ชำระเงินเพื่อเปิดใช้งาน" + a **smart CTA** (below). The membership stat card already renders `overdue` in red (`dashboard-stats.ts:60-62`); extend its copy to name the suspension. |
| `/portal/benefits` | Open. Quota rendered in a suspended state. |
| `/portal/broadcasts/new` | Blocked — **not a bare 403**: an explanatory page with the same smart CTA. |
| Everything else | Unchanged (invoices, tax documents, timeline, account, GDPR export). |

**Smart CTA** — the banner must never dead-end. Since no cron issues invoices, a suspended
member may have nothing to pay:

```
unpaid membership invoice exists?
  yes → /portal/invoices/[invoiceId]
  no  → /portal/renewal/[memberId]   ← confirm-renewal.ts:523 issues the invoice on confirm
```

`/portal/renewal` is already in the terminated-state allowlist and needs no new code — only
the CTA target must branch. A member can therefore always unblock themselves without waiting
for an admin.

Accessibility: never colour-alone (icon + text). i18n EN/TH/SV from day one — `pnpm check:i18n`
fails the build on a missing EN key.

**Admin**

| Surface | Behaviour |
|---|---|
| Members directory | New "suspended" badge (today only a lapsed badge exists, and only for terminal cycles). |
| F6 CSV import | A suspended attendee is **recorded normally**, plus a warning row in the import report and an audit event. |

## Audit & observability

Four new `audit_event_type` values (5-year retention, emitted in the same tx as any state
change per Principle VIII):

| Event | Fires when |
|---|---|
| `membership_suspended_action_blocked` | a suspended member hits a denylisted portal surface |
| `broadcast_blocked_membership_suspended` | F7 rejects a submit (follows the existing broadcasts reject taxonomy) |
| `renewal_lapse_deferred_invoice_not_due` | the new lapse guard spares a member — **the signal that proves the guard works** |
| `event_attendance_by_suspended_member` | F6 import sees an unpaid attendee |

Adding an audit event type touches **4 places** (domain const, pgEnum migration, and two
parity-test counts) — a recurring trap; the plan will enumerate them.

Metrics: counter `membership_access_blocked{surface, reason}` + a gauge of currently-suspended
members (so the January spike is visible).

## Schema

```sql
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS '…';  -- ×4
```

**No new columns, no new tables, no indexes, no backfill.** The truth already lives in
`renewal_cycles`; this work only starts listening to it. `grace_period_days = 90` is a
separate one-line ops SQL, not a migration.

## Error handling

**The load-bearing decision — a DB failure must fail differently per layer:**

| Path | On `findLatestCycleForMember` throw | Why |
|---|---|---|
| Portal pages (read) | **Fail open** — allow + log + metric | A DB blip that locks every member out of the portal is far worse than a suspended member briefly seeing a page. |
| F7 `submitBroadcast` (write) | **Fail closed** — return `submit.server_error` (500) | Failing open spends a quota unit **irreversibly**. |

F7 must **not** return `broadcast_blocked_membership_suspended` on an infra error: that
collapses "policy said no" (422) into "our database fell over" (500) and blinds the ops
dashboard. This mirrors the adjacent quota check exactly (`submit-broadcast.ts:349-356`),
which already returns `submit.server_error` rather than a fake `quota_blocked`.

**Lapse guard**

| Case | Behaviour |
|---|---|
| Several unpaid invoices | If **any** is not yet due → do not lapse. |
| No invoice at all | Guard finds nothing → lapse proceeds on grace alone. Essential fallback: without it a never-billed member could never be lapsed. |
| Draft invoice (`due_date` NULL) | Ignored — only `status = 'issued'` counts. |
| Date comparison | Asia/Bangkok, reusing `invoicing/application/use-cases/derive-overdue.ts:83-85` (`bangkokLocalDate(nowUtcIso)` → `todayBkk > invoice.dueDate`). |

**Other paths**

- Payment mid-session → the next request returns `full`; no refresh, no cron.
- A backdated new cycle (`period_from` in the past, `status = 'upcoming'`) → `period_to` is in
  the future → `full`. Covered by the mapping table.
- F4 `onPaid` callback throws → F4 rolls back → the invoice stays `issued` → the member stays
  suspended. No half-state. Existing contract; no change.
- Audit emit failure → log and swallow (fire-and-forget), per
  `lapsed-portal-scope.ts:197-211`. A 403 must never hang on a log write.

## Testing

**The lesson from gap #1 is a testing lesson.** The broken gate shipped with unit,
integration *and* E2E tests. They passed because they mocked `findActiveForMember` into
returning a `lapsed` cycle — something the real SQL cannot do.

Two rules follow, and they are requirements of this design, not suggestions:

1. **`findLatestCycleForMember` must be covered by a live-Neon integration test, unmocked.**
   The single most important assertion in this work is *"the repo returns a `lapsed` cycle"* —
   the one test that would have caught the original bug.
2. **An E2E test must prove the gate is actually wired.** Unit tests call the helper directly
   and therefore cannot distinguish "wired" from "dead code" — which is exactly how the
   original defect survived. E2E is mandatory here, not optional.

| Layer | Coverage |
|---|---|
| Unit — Domain (100% line) | `deriveMembershipAccess`, table-driven: 7 statuses × `period_to` past/future × `cycle = null`. |
| Unit — Application | `submitBroadcast`: suspended → reject; **DB throw → `server_error`, not `quota_blocked`**. Lapse guard: not-yet-due → skip; no invoice → lapse; draft → ignore. `admin-renew-lapsed-member`: unexpired → gapless; expired → re-anchor. |
| Contract | `MembershipAccessPort` (F7→F8 bridge) + barrel export. |
| Integration (live Neon) | **Repo returns a `lapsed` cycle.** Full cycle: expire → suspended → pay → `full`. Lapse guard against a real invoice with a future `due_date`. **Cross-tenant probe** (Principle I — Review-Gate blocker). |
| E2E | Suspended member: banner renders; `/portal/invoices` reachable; `/portal/broadcasts/new` blocked with a working pay CTA. `@a11y` axe scan of the blocked page. `@i18n` banner in EN/TH/SV. |

**Gate before merge**

```bash
pnpm lint && pnpm typecheck && pnpm test:coverage \
  && pnpm check:i18n && pnpm check:audit-events && pnpm check:audit-counts \
  && pnpm test:integration && pnpm test:e2e
```

`check:audit-events` and `check:audit-counts` matter especially here — four new audit event
types, each needing all four touch-points.

## Delivery slices

The work is one cohesive policy change, but it sequences into three slices that each land
green on their own. Slice 1 alone closes both go-live blockers.

| Slice | Contents | Why this order |
|---|---|---|
| **1 — Enforcement core** | `deriveMembershipAccess` · `findLatestCycleForMember` · wire + fix `lapsed-portal-scope` (two policies) · F7 port/adapter + `submitBroadcast` precondition · smart CTA · 2 audit events | Closes the free-benefits hole and the dead/broken gate — the two go-live blockers. Nothing below depends on it being deferred. |
| **2 — Lapse correctness** | due-date guard on the lapse cron · `admin-renew-lapsed-member` gapless-or-re-anchor · 1 audit event · `grace_period_days = 90` ops SQL | Only meaningful once suspension exists: raising grace to 90 *before* slice 1 would extend the free ride from 30 days to 90. **Slice 2 must not ship before slice 1.** |
| **3 — Visibility** | admin "suspended" badge · F6 import alert · F9 badge · metrics gauge | Pure observability. Valuable, but nobody is blocked on it. |

## Security & compliance

- All reads and writes go through the caller's `TenantTx` — never the global `db` singleton
  (Principle I, two-layer isolation). A cross-tenant probe is a Review-Gate blocker.
- Audit rows are emitted in the same tx as the state change (Principle VIII).
- `/portal/account/data-export` stays reachable while suspended — GDPR Art. 20 / PDPA
  portability is a legal right and must not be gated on payment.
- Renewal state is finance-adjacent → ≥2 reviewers (or the Constitution v1.4.2 solo-maintainer
  substitute).

## Out of scope

- Auto-issuing renewal invoices on a schedule (see § Decisions).
- Per-member grace overrides.
- Blocking F6 event imports.
- Delisting suspended members from the directory.
- Any change to renewal-period anchoring or the gapless-continuation math.

## Ops steps at ship

1. `UPDATE tenant_renewal_settings SET grace_period_days = 90 WHERE tenant_id = 'swecham';`
   (verify the current value first — code/migration default is 14, and the intended 30 was a
   hand-run SQL that may never have executed; `docs/runbooks/cron-jobs.md:937` and `:1053`
   contradict each other.)
2. Update `docs/runbooks/cron-jobs.md:1047-1063` — the "no fixed lapse policy — board
   discretion per case / 30 days chosen default" note is **superseded** by TSCC's 90-day
   credit policy.
