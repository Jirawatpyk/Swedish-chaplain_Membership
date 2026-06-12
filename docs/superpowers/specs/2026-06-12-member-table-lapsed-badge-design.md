# Member-table lapsed-membership badge — design

- **Date**: 2026-06-12
- **Branch**: `067-renewal-no-tin-test` (follow-up; may graduate to its own Spec Kit feature)
- **Status**: Approved (brainstorming) → ready for writing-plans
- **Author**: Claude + Jirawat
- **Reference**: gap #4 ("สมาชิกหมดอายุ แต่ member table ยัง active")

## Problem

The admin member table (`/admin/members`) shows only `member.status`
(`active` / `inactive` / `archived`) — the **account** state. It does NOT
surface the **renewal-cycle coverage** state. A member whose membership has
**lapsed** (latest renewal cycle is terminal `lapsed`/`cancelled` and past
expiry) still renders a green **"Active"** badge in the table. The only place
an admin can see lapsed members today is the separate `/admin/renewals` lapsed
tab. This is a visibility gap: an admin viewing a member for any other reason
has no in-table signal that the membership coverage has ended.

## Goal

Let an admin see **at a glance, in the member table**, which members have a
**lapsed** membership — without leaving the directory.

## Non-goals (YAGNI — explicitly out of scope)

- **No `overdue` / `due-soon` surfacing.** Scope is **lapsed-only**. An
  in-grace (`overdue`) or near-expiry (`due`) member shows **no** badge.
  (Rationale: lapsed is the clear, misleading case — "active but actually
  ended". Due/overdue are softer states; adding them risks badge noise.)
- **No filter.** No "lapsed-only" filter chip on the directory. Finding *all*
  lapsed members remains the job of `/admin/renewals` (lapsed tab). The table
  badge is **incidental awareness**, not a discovery tool. This keeps the
  query a simple per-page enrichment (no cross-page `WHERE`/`COUNT`).
- **No new column.** The badge renders **inline beside the existing Status
  badge** (a lapsed-only dedicated column would be mostly empty `—`).

## Decisions captured (from brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Scope | **Lapsed only** |
| 2 | Placement | **Inline, beside the Status badge** |
| 3 | Filter | **No filter — badge only** |
| 4 | DRY predicate | **Single canonical `isMembershipLapsed` shared by portal + admin** |

Target row appearance (lapsed row):

```
Member          Status                  Plan
────────────────────────────────────────────
Acme Co.        ● Active  ⚠ Lapsed     Regular Corp     ← lapsed cycle
Beta Ltd.       ● Active               Premium Corp     ← no badge
Gamma AB        ○ Inactive             Partner Tier
```

## Canonical "lapsed" semantic

`lapsed` ≡ `deriveMembershipStat(cycle, now).kind === 'lapsed'`
(`src/app/(member)/portal/_lib/dashboard-stats.ts`), i.e.:

- the member's **most-recent** renewal cycle is **ended-terminal** —
  `isTerminalCycleStatus(status) && status !== 'completed'` (so `lapsed` and
  `cancelled`, but **NOT** `completed`, which means the member paid/renewed),
  **AND**
- its `expiresAt` is in the past (or unparseable → still treated lapsed).

A member with **no cycle** (`kind: 'empty'`), an `active`/`completed` cycle, or
an in-grace `overdue` cycle is **not** lapsed → no badge.

## Approach (chosen: A)

### A — Batch use-case in the renewals module ⭐

Add a renewals **application use-case** that, given the page's member IDs,
returns the set of lapsed ones in **one** query.

- **Repo batch method** `findLatestCyclesForMembers(memberIds)` — a single
  `SELECT DISTINCT ON (member_id) … ORDER BY member_id, <recency> DESC` over
  `renewal_cycles WHERE member_id = ANY($1)`, mirroring the recency ordering
  already used by `loadMemberRenewalStatus`. Threads `tx` from `runInTenant`
  (RLS-safe — never the global `db` singleton).
- **Use-case** `loadMembersMembershipStatus({ tenantId, memberIds })
  → Result<ReadonlySet<string>>` — maps each latest cycle through the canonical
  `isMembershipLapsed(cycle, now)` predicate and returns the lapsed member-ID
  set.

**Why A**: no N+1 (1 query per page of ≤50 rows), no F3↔F8 SQL coupling, clean
module boundary (staff presentation → renewals application via barrel — the
same direction the page already uses for `@/modules/members` / `@/modules/plans`
/ `@/modules/insights`), tenant-isolated.

### Rejected alternatives

- **B — loop `loadMemberRenewalStatus` per row**: simplest, but **N+1** (up to
  50 queries/page). Violates the no-N+1 constraint; rejected.
- **C — `LEFT JOIN` latest cycle into `directorySearchWithCount`**: one query,
  but couples the **F3 members** SQL to the **F8 renewals** schema (breaks
  Constitution Principle III module boundary). The badge-only scope needs no
  cross-page `WHERE`/`COUNT`, so the JOIN buys nothing. Rejected.

## Design detail

### 1. Data flow — `src/app/(staff)/admin/members/page.tsx`

After `directorySearchWithCount` returns `result.value.items`:

1. collect `memberIds = items.map(i => i.member.memberId)`.
2. call `loadMembersMembershipStatus({ tenant, memberIds })` (renewals deps)
   to get `lapsedIds: ReadonlySet<string>`.
3. in the existing row-mapping (where `projectEngagementScore` already runs),
   set `membership_lapsed: lapsedIds.has(row.member.memberId)`.

The renewals read runs **after** (or in parallel with) the member search but
must not gate it — see Error handling.

### 2. renewals module

- New repo method `findLatestCyclesForMembers` (DISTINCT-ON, `tx`-threaded).
- New use-case `loadMembersMembershipStatus` (barrel export).
- **DRY**: extract `isMembershipLapsed(cycle, now): boolean` as a pure export
  of the renewals barrel (it only needs existing renewals primitives —
  `isTerminalCycleStatus`, expiry parse). Refactor portal `deriveMembershipStat`
  step-4 to call it (behavior-preserving — portal unit tests stay green). Both
  portal dashboard and admin badge now derive "lapsed" from **one** function.

### 3. UI — `src/components/members/members-table.tsx`

- Add `readonly membership_lapsed: boolean` to `MembersTableRow`.
- In the `status` column cell, after `StatusBadge` / `InlineStatusCell`, render
  when `row.membership_lapsed`:
  - `<Badge variant="destructive">` with an `AlertTriangleIcon` (`aria-hidden`)
    + visible text label (i18n) — **text, not colour alone** (WCAG 1.4.1).
  - an `sr-only` fuller phrase ("Membership lapsed — needs renewal") so screen
    readers get the meaning, not just "Lapsed".
- The badge is purely presentational from the row flag; no client-side renewal
  logic enters the client bundle (mirrors the engagement-projection pattern).

### 4. Error handling

The renewals enrichment must **never** take down the members directory. Wrap
`loadMembersMembershipStatus` so a `Result` `!ok` **or** a thrown read resolves
to an **empty set** (→ no badges) and logs a `warn` with `errKind` only (no
PII/SQL). The member search result is the sole driver of the error/empty
states; renewals is best-effort enrichment. (Mirrors the resilience already in
`portal/_components/dashboard-reads.ts`.)

### 5. i18n

New key `admin.members.directory.membershipLapsed`:

| Locale | Value |
|--------|-------|
| EN | `Lapsed` |
| TH | `หมดอายุ` |
| SV | `Förfallen` |

Plus an `sr-only` key (e.g. `membershipLapsedSr` = "Membership lapsed — needs
renewal" / TH / SV). Added to all three locale files (parity enforced by
`check:i18n`). `t.has`-guarded if rendered via a dynamic key path.

### 6. a11y

- Badge conveys state via **text + icon**, never colour alone (WCAG 1.4.1).
- Contrast ≥ 4.5:1 (reuse the audited `destructive` Badge variant).
- `sr-only` phrase gives the full meaning to assistive tech.
- No new focusable control (the badge is non-interactive); row link unchanged.

### 7. Testing

- **Unit**: `isMembershipLapsed` truth table (lapsed / cancelled / completed /
  active / overdue-grace / no-cycle / unparseable-expiry); `loadMembersMembershipStatus`
  use-case with a mocked repo (correct set, empty input → empty set, missing
  cycle → not lapsed).
- **Integration (live Neon)**: seed one tenant with members in each state
  (active cycle, lapsed cycle, completed cycle, no cycle) → the use-case returns
  exactly the lapsed set; a **cross-tenant** member-ID list returns **empty**
  (RLS + `runInTenant` proof, Constitution Principle I Review-Gate blocker).
- **Component**: `members-table` renders the Lapsed badge only on rows with
  `membership_lapsed: true`; SR text present; no badge otherwise.
- **E2E**: optional / deferred (seed-dependent — gate behind an `E2E_*` fixture
  like the other renewal specs; do not hard-fail when unseeded).

## Future extensions (not now)

- Promote to `overdue` / `due` badges (the use-case can return a
  `Map<memberId, kind>` instead of a `Set` if/when needed).
- A "lapsed membership" directory filter (would require pushing the renewal
  status into `directorySearchWithCount` for cross-page `WHERE`/`COUNT`).

## Constitution / project checks

- **Principle I (tenant isolation)**: batch repo threads `tx` from
  `runInTenant`; mandatory cross-tenant integration test.
- **Principle III (clean architecture)**: new logic lives in the renewals
  module (application + infrastructure); staff presentation calls only the
  barrel; no F3↔F8 SQL coupling.
- **i18n**: EN/TH/SV parity.
- **a11y**: WCAG 2.1 AA — text+icon badge, not colour-only.
- **Reliability**: best-effort enrichment, never crashes the directory.
