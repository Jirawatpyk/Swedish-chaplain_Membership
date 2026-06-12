# Member-table lapsed-membership badge — design

- **Date**: 2026-06-12
- **Branch**: `067-renewal-no-tin-test` (follow-up; may graduate to its own Spec Kit feature)
- **Status**: Approved + 4-specialist review incorporated (v2) → ready for writing-plans
- **Author**: Claude + Jirawat
- **Reference**: gap #4 ("สมาชิกหมดอายุ แต่ member table ยัง active")
- **Reviewers (design)**: chamber-os-architect, senior-tester, chamber-os-ux-architect,
  performance-slo-guardian — all **APPROVE-WITH-CHANGES**; changes folded into this v2.

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
- **No filter.** No "lapsed-only" filter chip on the directory. Finding *all*
  lapsed members remains the job of `/admin/renewals` (lapsed tab). The table
  badge is **incidental awareness**, not a discovery tool — so no cross-page
  `WHERE`/`COUNT` (the enrichment touches only the current page's ≤50 rows).
- **No new column.** The badge renders **inline beside the existing Status
  badge** (a lapsed-only dedicated column would be mostly empty `—`).

## Decisions captured (brainstorming + design review)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Scope | **Lapsed only** |
| 2 | Placement | **Inline, beside the Status badge** |
| 3 | Filter | **No filter — badge only** |
| 4 | DRY predicate | **Single canonical `isMembershipLapsed` (Domain) shared by portal + admin** |
| 5 | Recency basis | **`created_at DESC` + `cycle_id` tiebreak** (mirrors `loadMemberRenewalStatus`) |
| 6 | Index | **Add** `renewal_cycles (tenant_id, member_id, created_at DESC)` (1 migration) |
| 7 | Badge style | **`outline` + `border-destructive/40 text-destructive`** (subordinate, not filled) |

Target row appearance (lapsed row):

```
Member          Status                  Plan
────────────────────────────────────────────
Acme Co.        ● Active  ⚠ Lapsed     Regular Corp     ← lapsed cycle (outline chip)
Beta Ltd.       ● Active               Premium Corp     ← no badge
Gamma AB        ○ Inactive             Partner Tier
```

## Canonical "lapsed" semantic

`lapsed` ≡ `deriveMembershipStat(cycle, now).kind === 'lapsed'`
(`src/app/(member)/portal/_lib/dashboard-stats.ts:76-90`). The **load-bearing
gate is the terminal status, not the expiry** — a member is lapsed iff their
**most-recent** cycle:

- is **ended-terminal** — `isTerminalCycleStatus(status) && status !== 'completed'`
  (so `lapsed` and `cancelled`, but **NOT** `completed`, which means the member
  paid/renewed and is in good standing), **AND**
- its `expiresAt` is in the past (or unparseable → still treated lapsed).

**Ordering invariant (must be documented at the call site + tested):** in
`deriveMembershipStat`, `isOverdue(cycle, now)` is evaluated *before* the
ended-terminal branch. `isOverdue` (`renewal-cycle.ts:272-275`) early-returns
`false` for any terminal cycle, so a terminal `lapsed`/`cancelled` cycle is
**never** stolen by the overdue branch — therefore
`kind === 'lapsed' ⟺ isMembershipLapsed(cycle, now)`. The predicate MUST gate
on the terminal status **first**; written naively as "expiry in the past" it
would wrongly flag an in-grace `overdue` (non-terminal, past-expiry) cycle.

A member with **no cycle** (`empty`), an `active`/`completed`/future-expiry
cycle, or an in-grace `overdue` cycle is **not** lapsed → no badge.

## Approach (chosen: A)

### A — Batch use-case in the renewals module ⭐

Add a renewals **application use-case** that, given the page's member IDs,
returns the set of lapsed ones in **one** query.

- **Domain predicate** `isMembershipLapsed(cycle, now): boolean` — colocated in
  `src/modules/renewals/domain/renewal-cycle.ts` next to `isOverdue` /
  `daysUntilExpiry`, re-exported via the barrel. Pure; depends only on
  `isTerminalCycleStatus` + `Date.parse`. Definition:

  ```
  isMembershipLapsed(cycle, now) =
       isTerminalCycleStatus(cycle.status)
    && cycle.status !== 'completed'
    && (!Number.isFinite(Date.parse(cycle.expiresAt))
        || Date.parse(cycle.expiresAt) < now.getTime())
  ```

  `deriveMembershipStat` step-4 is refactored to call it (behavior-preserving —
  see the ordering invariant + characterization test).

- **Repo port (new method)** `findLatestCyclesForMembers(memberIds): RenewalCycle[]`
  — the existing `RenewalCycleRepo.list()` supports a *single* `memberIdFilter`,
  not an `ANY($1)` batch, so this is a genuinely new port method + Drizzle
  adapter. Query:

  ```sql
  SELECT DISTINCT ON (member_id) <cols>
  FROM renewal_cycles
  WHERE member_id = ANY($1)               -- ≤50 ids; RLS ANDs tenant_id
  ORDER BY member_id, created_at DESC, cycle_id DESC;
  ```

  `created_at DESC` mirrors `loadMemberRenewalStatus` (`sort: 'created_at_desc'`);
  `cycle_id DESC` is the deterministic tiebreak for equal `created_at`. Returns
  **Domain `RenewalCycle[]`** via `rowToDomain` (no Drizzle/infra type leaks
  upward). Threads `tx` from `runInTenant` (RLS-safe — never the global `db`).

- **Use-case** `loadMembersMembershipStatus(deps, { tenantId, memberIds })
  → Result<ReadonlySet<string>>` — short-circuits `[]` input (no DB round-trip),
  else maps each latest cycle through `isMembershipLapsed(cycle, deps.clock.now())`
  and returns the lapsed member-ID set. `now` comes from the injected
  `ClockPort` (`renewals-deps.ts`), **not** `new Date()`.

**Why A**: no N+1 (1 query per page), no F3↔F8 SQL coupling, clean module
boundary (staff presentation → renewals application via barrel — the same
direction the page already uses for `@/modules/members` / `@/modules/plans` /
`@/modules/insights`), tenant-isolated by RLS+FORCE.

### Rejected alternatives

- **B — loop `loadMemberRenewalStatus` per row**: **N+1** (up to 50
  queries/page). Rejected.
- **C — `LEFT JOIN` latest cycle into `directorySearchWithCount`**: couples the
  **F3 members** SQL to the **F8 renewals** schema (breaks Principle III; the F3
  query already carries F9 risk derivation — three features in one statement).
  Badge-only scope needs no cross-page `WHERE`/`COUNT`. Rejected. The page
  already composes cross-module reads at the **presentation** layer by calling
  multiple barrels then merging in the row-map — Approach A extends that exact
  pattern with a fourth barrel call.

## Design detail

### 1. Data flow — `src/app/(staff)/admin/members/page.tsx`

After `directorySearchWithCount` resolves `result.value.items`:

1. `memberIds = items.map(i => i.member.memberId)`.
2. start the renewals read **and** `resolveMemberNumberPrefix` together — both
   depend only on data already in hand, neither on the other — to hide the
   extra round-trip:

   ```ts
   const memberIds = result.value.items.map((r) => r.member.memberId);
   const [memberPrefix, lapsedIds] = await Promise.all([
     resolveMemberNumberPrefix(tenant, deps.memberSettings),
     loadMembersMembershipStatusSafe({ tenant, memberIds }), // best-effort wrapper, §4
   ]);
   ```

   (It cannot join the earlier search/`listPlans` `Promise.all` — it needs
   `memberIds` from the search result first. It is structurally serial-*after*
   the search, but parallel with the prefix fetch.)
3. in the existing row-map (where `projectEngagementScore` already runs), set
   `membership_lapsed: lapsedIds.has(row.member.memberId)` — always assigned,
   never optional/conditional (matches the row-builder's exhaustive convention,
   avoids `exactOptionalPropertyTypes` friction).

### 2. renewals module

- **Domain**: `isMembershipLapsed` in `renewal-cycle.ts` (barrel re-export).
- **Application**: `loadMembersMembershipStatus` use-case (barrel export); takes
  `now` from `deps.clock.now()`.
- **Infrastructure**: `findLatestCyclesForMembers` Drizzle adapter (DISTINCT-ON,
  `tx`-threaded, returns Domain entities).
- **Migration** (new): index `renewal_cycles_member_recency_idx` on
  `renewal_cycles (tenant_id, member_id, created_at DESC)` — makes the DISTINCT
  ON an index skip-scan per member (no `Sort` node), deterministic and
  future-proof for large MTA tenants. Add the matching Drizzle `index(...)` in
  `schema-renewal-cycles.ts`. (Apply the migration + run integration tests
  before committing the schema change — per the F4 R8 gotcha.)
- **DRY**: portal `deriveMembershipStat` step-4 delegates to `isMembershipLapsed`
  → portal dashboard + admin badge derive "lapsed" from **one** function.

### 3. UI — `src/components/members/members-table.tsx`

- Add `readonly membership_lapsed: boolean` to `MembersTableRow` (always set).
- In the `status` column cell, wrap the existing status control **and** the new
  badge as **siblings** in `inline-flex items-center gap-1.5`. The lapsed badge
  MUST sit **outside** `InlineStatusCell`'s `<button>` (inside it would join the
  toggle's accessible name + 28×60 hit area, so clicking the warning would fire
  a status toggle). Render the badge only when `row.membership_lapsed`:
  - `<Badge variant="outline" className="gap-1 border-destructive/40 text-destructive">`
    with a `TriangleAlert` icon (lucide; `aria-hidden`, `size-3`) + visible text
    label (i18n `membershipLapsed`). **Outline, not filled** — it subordinates
    to the primary status badge and doesn't over-weight the cell next to the
    deliberately-unfilled engagement label. (The `archived` secondary-badge is
    **not** a precedent — it *replaces* the status badge; this sits *beside* it.)
  - an `sr-only` span (i18n `membershipLapsedSr` = "Membership lapsed — needs
    renewal") so a SR user hears "Active, Membership lapsed — needs renewal".
- Purely presentational from the row flag; no client-side renewal logic enters
  the client bundle (mirrors the engagement-projection pattern).

### 4. Error handling

The renewals enrichment must **never** take down the members directory. The
page-side `loadMembersMembershipStatusSafe` wrapper handles **both** failure
shapes:

- use-case returns `Result` `!ok` → empty set;
- the `runInTenant` repo call **throws** (a Postgres error throws rather than
  returning `!ok` — the F4 `listInvoicesPaged` typed-`never`-but-throws trap) →
  `try/catch` → empty set.

On either path: log **one** `warn` per page render (not per member) with
`errKind` + `memberIdsCount` only — never the IDs/SQL/PII. An empty set → no
badges; the member search result remains the sole driver of the error/empty
states. (Mirrors `portal/_components/dashboard-reads.ts` resilience.)

### 5. i18n

Two keys in the **existing** `admin.members.directory` namespace (the table
already calls `useTranslations('admin.members.directory')` — no new hook):

| Key | EN | TH | SV |
|-----|----|----|----|
| `membershipLapsed` | `Lapsed` | `หมดอายุ` | `Förfallen` |
| `membershipLapsedSr` | `Membership lapsed — needs renewal` | `สมาชิกภาพหมดอายุ — ต้องต่ออายุ` | `Medlemskap förfallet — kräver förnyelse` |

Reuses the established renewals-tab terms. Static literal keys → **no `t.has`
guard** needed. Add all keys to all three locale files; EN canonical present so
runtime resolution is safe (`check:i18n` parity enforced).

### 6. a11y

- State via **text + icon**, never colour alone (WCAG 1.4.1).
- Contrast ≥ 4.5:1 (`text-destructive` on `background`, audited).
- `sr-only` phrase gives full meaning to assistive tech.
- Badge is non-interactive (no new focusable control); row link + inline-edit
  toggle unchanged (badge is a sibling, not inside the button).
- RTL / dark-mode / reduced-motion: static chip — no concern (confirmed).

### 7. Testing (TDD order)

1. **Characterization (RED-first, before refactor)**: pin
   `deriveMembershipStat(c, now).kind === 'lapsed' ⟺ isMembershipLapsed(c, now)`
   across a cycle corpus — locks the equivalence (note: the original uses an
   **instant-level `<`**, not the day-granularity of `daysUntilExpiry`).
2. **Extract + delegate (GREEN)**: move the predicate to Domain, refactor
   step-4; existing `deriveMembershipStat` unit tests stay green; **add a portal
   `overdue → overdue` regression test** asserting an in-grace cycle is not
   re-routed to lapsed after the refactor.
3. **Predicate truth table** (unit, Domain 100%): terminal `lapsed` → true;
   terminal `cancelled` → true; terminal `completed` → **false**; non-terminal
   `active` → false; non-terminal **past-expiry (= overdue)** → **false**;
   no-cycle (n/a — caller passes only present cycles); `expiresAt` unparseable →
   true; **`expiresAt` exactly == now** → false (strict `<`); terminal-but-
   **future-expiry** → false; `pending_admin_reactivation` (non-terminal) →
   false.
4. **Use-case unit**: mocked repo → correct lapsed set; **empty input → empty
   set AND repo NOT called** (no wasted round-trip); missing-cycle member → not
   in set; **repo-throws → use-case degrades** (swallow/Result, the page wrapper
   then empties) — the throw-path test that mock-only suites otherwise hide.
5. **Integration (LIVE Neon)** — seed with **simulated/dummy** members + cycles
   (NEVER real member rows; idempotent), covering active / lapsed / completed /
   no-cycle:
   - the use-case returns **exactly** the lapsed set (positive control in
     tenant A) **and** empty for a tenant-B member-ID list (cross-tenant
     negative control) — Constitution Principle I Review-Gate blocker, mirrors
     `tests/integration/portal/dashboard-cross-tenant.test.ts`; drive through
     `makeRenewalsDeps` → `runInTenant`.
   - **multi-cycle parity**: seed a member with **≥2 cycles** whose `created_at`
     and `expires_at` deliberately disagree → assert the batch picks the **same**
     cycle as `loadMemberRenewalStatus` (proves the `created_at DESC` basis).
   - **`EXPLAIN (ANALYZE, BUFFERS)`** the DISTINCT ON at seed scale → assert
     `Index Scan` on `renewal_cycles_member_recency_idx`, **no `Seq Scan` / no
     `Sort` node** (acceptance evidence for decision #6).
6. **Component** (Vitest + Testing Library): badge renders only on
   `membership_lapsed: true`; `sr-only` text present; **badge is inside the
   status cell** (the table hard-codes the row-link cell index — assert the
   badge lands in the right cell); no badge otherwise.
7. **E2E**: optional / deferred — gate behind an `E2E_*` fixture with a
   **conditional** skip (never a bare `test.skip` — `check:fixme` blocks those
   on release branches). Reuse the existing `seedMemberAndRenewalCycle` helper
   (override its default `status:'upcoming'`).

## Future extensions (not now)

- Promote to `overdue` / `due` badges (the use-case can return a
  `Map<memberId, kind>` instead of a `Set`).
- A "lapsed membership" directory filter (would require pushing the renewal
  status into `directorySearchWithCount` for cross-page `WHERE`/`COUNT`).

## Constitution / project checks

- **Principle I (tenant isolation)**: batch repo threads `tx` from
  `runInTenant`; `member_id = ANY($1)` runs under RLS+FORCE so a foreign ID
  matches nothing (leaks nothing); mandatory cross-tenant integration test
  (positive + negative control). **PASS** (contingent on the test).
- **Principle II (TDD)**: characterization → extract → truth-table → use-case
  (incl. throw-path) → integration (cross-tenant + multi-cycle + EXPLAIN) →
  component → page-wiring. **PASS.**
- **Principle III (clean architecture)**: predicate → Domain; use-case →
  Application; repo → Infrastructure (Domain entities out, no infra leak);
  page → barrel-only; Approach C rejected. **PASS.**
- **Principle V (i18n)**: EN/TH/SV for both keys, existing namespace. **PASS.**
- **Principle VI (inclusive UX)**: text + icon, not colour-only; `sr-only`
  phrase; non-interactive; outline chip subordinate to status. **PASS.**
- **Principle X (simplicity)**: lapsed-only, no filter, no column. One index
  migration is a justified scalability choice (decision #6), **not** a deviation
  needing Complexity Tracking. **PASS.**
- **Performance**: +1 batch query hidden behind the prefix fetch via
  `Promise.all`; index skip-scan ≈ single-digit ms; no N+1; SC-002 budget
  (members directory p95 < 500 ms) unaffected. Best-effort `warn` is the
  degradation signal (no new unwired metric).
